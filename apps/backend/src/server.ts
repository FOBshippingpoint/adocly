import {
  cbor,
  NetworkAdapter,
  Repo,
  type Chunk,
  type DocumentId,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo";

interface Session {
  peerId: PeerId;
  peerMetadata: PeerMetadata;
}

class WebSocketAdapter extends NetworkAdapter {
  #documents = new Map<PeerId, Set<DocumentId>>();

  #sockets = new Map<PeerId, WebSocket>();
  #ready = false;
  #readyResolver?: () => void;
  #readyPromise = new Promise<void>((resolve) => {
    this.#readyResolver = resolve;
  });

  constructor(private readonly state: DurableObjectState) {
    super();
  }

  async restore(): Promise<void> {
    for (const socket of this.state.getWebSockets()) {
      const session = socket.deserializeAttachment() as Session | null;
      if (!session || socket.readyState !== WebSocket.OPEN) continue;
      this.#sockets.set(session.peerId, socket);
      const documents = await this.state.storage.get<DocumentId[]>(`peer-docs/${session.peerId}`);
      this.#documents.set(session.peerId, new Set(documents));
    }
  }

  knowsDocument(peerId: PeerId, documentId?: DocumentId): boolean {
    return documentId !== undefined && (this.#documents.get(peerId)?.has(documentId) ?? false);
  }

  trackDocument(peerId: PeerId, documentId: DocumentId): void {
    if (!this.#sockets.has(peerId)) return;
    let documents = this.#documents.get(peerId);
    if (!documents) this.#documents.set(peerId, (documents = new Set()));
    if (documents.has(documentId)) return;
    documents.add(documentId);
    this.state.waitUntil(this.state.storage.put(`peer-docs/${peerId}`, [...documents]));
  }

  isReady(): boolean {
    return this.#ready;
  }

  whenReady(): Promise<void> {
    return this.#readyPromise;
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    this.#ready = true;
    this.#readyResolver?.();
    for (const socket of this.#sockets.values()) {
      const session = socket.deserializeAttachment() as Session;
      this.emit("peer-candidate", session);
    }
  }

  disconnect(): void {
    for (const [peerId, socket] of this.#sockets) {
      socket.close();
      this.emit("peer-disconnected", { peerId });
    }
    this.#sockets.clear();
  }

  remove(socket: WebSocket): void {
    for (const [peerId, current] of this.#sockets) {
      if (current !== socket) continue;
      this.#sockets.delete(peerId);
      this.#documents.delete(peerId);
      this.state.waitUntil(this.state.storage.delete(`peer-docs/${peerId}`));
      this.emit("peer-disconnected", { peerId });
    }
  }

  send(message: Message): void {
    if (!("targetId" in message) || !message.targetId) return;
    const socket = this.#sockets.get(message.targetId);
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(new Uint8Array(cbor.encode(message)));
  }

  async receive(socket: WebSocket, bytes: Uint8Array): Promise<void> {
    if (!this.#ready) await this.#readyPromise;
    try {
      const message = cbor.decode(bytes) as Message & { peerMetadata?: PeerMetadata };
      const { type, senderId } = message;
      if (type === "join") {
        const existing = this.#sockets.get(senderId);
        if (existing) {
          existing.close();
          this.emit("peer-disconnected", { peerId: senderId });
        }
        socket.serializeAttachment({ peerId: senderId, peerMetadata: message.peerMetadata ?? {} });
        this.#sockets.set(senderId, socket);
        this.emit("peer-candidate", { peerId: senderId, peerMetadata: message.peerMetadata ?? {} });
        this.send({
          type: "peer",
          senderId: this.peerId!,
          peerMetadata: this.peerMetadata,
          selectedProtocolVersion: "1",
          targetId: senderId,
        } as unknown as Message);
      } else if (this.#sockets.get(senderId) === socket) {
        this.emit("message", message);
      }
    } catch {
      this.remove(socket);
      socket.close(1003, "Invalid sync message");
    }
  }
}

class SqliteStorageAdapter implements StorageAdapterInterface {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, data BLOB NOT NULL)");
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const row = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM storage WHERE key = ?", key.join("/"))
      .toArray()[0];
    return row ? new Uint8Array(row.data) : undefined;
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO storage (key, data) VALUES (?, ?)", key.join("/"), data);
  }

  async remove(key: StorageKey): Promise<void> {
    this.sql.exec("DELETE FROM storage WHERE key = ?", key.join("/"));
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = keyPrefix.join("/");
    return this.sql
      .exec<{ key: string; data: ArrayBuffer }>(
        "SELECT key, data FROM storage WHERE key = ? OR (key > ? AND key < ?)",
        prefix,
        `${prefix}/`,
        `${prefix}0`,
      )
      .toArray()
      .map((row) => ({
        key: row.key.split("/"),
        data: new Uint8Array(row.data),
      }));
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = keyPrefix.join("/");
    this.sql.exec(
      "DELETE FROM storage WHERE key = ? OR (key > ? AND key < ?)",
      prefix,
      `${prefix}/`,
      `${prefix}0`,
    );
  }
}

export class SyncServer implements DurableObject {
  #network: WebSocketAdapter;
  #repo!: Repo;

  constructor(private readonly state: DurableObjectState) {
    this.#network = new WebSocketAdapter(state);
    void state.blockConcurrencyWhile(async () => {
      await this.#network.restore();
      this.#repo = new Repo({
        network: [this.#network],
        storage: new SqliteStorageAdapter(state.storage.sql),
        peerId: `storage-server-${state.id.toString()}` as PeerId,
        // Restore subscriptions after hibernation without announcing unrelated documents.
        sharePolicy: async (peerId, documentId) => this.#network.knowsDocument(peerId, documentId),
      });
      this.#repo.synchronizer.on("open-doc", ({ peerId, documentId }) => {
        this.#network.trackDocument(peerId, documentId);
      });
      await this.#repo.networkSubsystem.whenReady();
    });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") {
      this.#network.remove(socket);
      socket.close(1003, "Expected binary sync message");
      return;
    }
    await this.#network.receive(socket, new Uint8Array(message));
  }

  webSocketClose(socket: WebSocket): void {
    this.#network.remove(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.#network.remove(socket);
    socket.close(1011, "WebSocket error");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Hi");
    }
    await this.#repo.networkSubsystem.whenReady();
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
