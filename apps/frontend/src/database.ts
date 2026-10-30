import * as Automerge from "@automerge/automerge/slim";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";
import {
  type AutomergeUrl,
  type DocHandle,
  encodeHeads,
  isValidAutomergeUrl,
  Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

export interface Snapshot {
  id: string;
  heads: UrlHeads;
  timestamp: number;
}

export type ViewMode = "write" | "split" | "preview";
export type Theme = "light" | "dark";

export interface LayoutSetting {
  mode: ViewMode;
  splitRatio: number;
}

export interface CollaboratorSetting {
  emoji: string;
  color: string;
}

export interface FileEntry {
  url: AutomergeUrl;
  title: string;
  shared: boolean;
}

export interface Settings {
  files: FileEntry[];
  docUrl: AutomergeUrl;
  theme: Theme;
  layout: LayoutSetting;
  identity: CollaboratorSetting;
}

export interface DocSchema {
  content: string;
  assets?: Record<string, string>;
}

const SYNC_SERVER_URL = import.meta.env.VITE_SYNC_SERVER_URL ?? "ws://localhost:8787";
const ASSET_SERVER_URL = (
  import.meta.env.VITE_ASSET_SERVER_URL ?? SYNC_SERVER_URL.replace(/^ws/, "http")
).replace(/\/+$/, "");

export class Database {
  private shared = false;
  private networkEnabled = false;
  private repo: Repo | null = null;
  private handle: DocHandle<DocSchema> | null = null;
  private initPromise: Promise<DocHandle<DocSchema>> | null = null;

  private async waitForHandle(url: AutomergeUrl, timeoutMs: number): Promise<DocHandle<DocSchema>> {
    const repo = this.repo!;
    const progress = repo.findWithProgress<DocSchema>(url);
    const current = progress.peek();
    if (current.state === "ready") {
      return current.handle;
    }

    return new Promise<DocHandle<DocSchema>>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error(`Timed out loading document ${url}`));
      }, timeoutMs);

      const unsubscribe = progress.subscribe((state) => {
        if (settled) return;
        if (state.state === "ready") {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(state.handle);
        } else if (state.state === "failed") {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          reject(state.error);
        }
      });
    });
  }

  async init(defaultContent: string, hashCandidate?: string): Promise<DocHandle<DocSchema>> {
    if (this.handle) return this.handle;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await Automerge.initializeWasm(wasmUrl);
      this.repo = new Repo({
        storage: new IndexedDBStorageAdapter(),
      });

      if (hashCandidate && isValidAutomergeUrl(hashCandidate)) {
        this.enableSharing();
        try {
          this.handle = await this.waitForHandle(hashCandidate, 10000);
          this.setSetting("docUrl", this.handle.url);
          return this.handle;
        } catch {}
      }

      const savedUrl = this.getSetting("docUrl");
      if (savedUrl && isValidAutomergeUrl(savedUrl)) {
        try {
          this.handle = await this.waitForHandle(savedUrl, 3000);
          if (this.getFiles().find((file) => file.url === savedUrl)?.shared) this.enableSharing();
          return this.handle;
        } catch {}
      }

      this.handle = this.repo.create<DocSchema>({ content: defaultContent, assets: {} });
      this.setSetting("docUrl", this.handle.url);
      return this.handle;
    })();

    return this.initPromise;
  }

  async openDocument(url: string, shared = true): Promise<DocHandle<DocSchema> | null> {
    if (!this.repo || !isValidAutomergeUrl(url)) return null;
    if (shared) this.enableNetwork();
    if (this.handle?.url === url) return this.handle;
    try {
      const handle = await this.waitForHandle(url, 10000);
      this.handle = handle;
      this.shared = shared;
      this.rememberDocument();
      this.setSetting("docUrl", handle.url);
      return handle;
    } catch {
      return null;
    }
  }

  createDocument(): DocHandle<DocSchema> {
    this.handle = this.repo!.create<DocSchema>({ content: "", assets: {} });
    this.shared = false;
    this.rememberDocument();
    this.setSetting("docUrl", this.handle.url);
    return this.handle;
  }

  getFiles(): FileEntry[] {
    return this.getSetting("files", []);
  }

  removeDocument(url: AutomergeUrl): void {
    this.repo!.delete(url);
    this.setSetting(
      "files",
      this.getFiles().filter((file) => file.url !== url),
    );
  }

  rememberDocument(): void {
    if (!this.handle) return;
    const files = this.getFiles();
    const title =
      this.getContent()
        .match(/^=\s+(.+)$/m)?.[1]
        ?.trim() || "Untitled";
    const entry = { url: this.handle.url, title, shared: this.shared };
    const index = files.findIndex((file) => file.url === entry.url);
    if (index === -1) files.push(entry);
    else files[index] = entry;
    this.setSetting("files", files);
  }

  isShared(): boolean {
    return this.shared;
  }

  enableSharing(): void {
    this.shared = true;
    this.rememberDocument();
    this.enableNetwork();
  }

  private enableNetwork(): void {
    if (!this.networkEnabled && this.repo) {
      this.networkEnabled = true;
      this.repo.networkSubsystem.addNetworkAdapter(new BroadcastChannelNetworkAdapter());
      this.repo.networkSubsystem.addNetworkAdapter(new WebSocketClientAdapter(SYNC_SERVER_URL));
    }
  }

  getRepo(): Repo | null {
    return this.repo;
  }

  getHandle(): DocHandle<DocSchema> | null {
    return this.handle;
  }

  getDocUrl(): AutomergeUrl | null {
    return this.handle?.url ?? null;
  }

  getContent(fallback = ""): string {
    return this.handle?.doc()?.content ?? fallback;
  }

  updateContent(content: string): void {
    if (!this.handle) return;
    const current = this.handle.doc()?.content;
    if (current !== content) {
      this.handle.change((doc) => {
        Automerge.updateText(doc, ["content"], content);
      });
    }
  }

  trackAssets(names: string[]): void {
    if (!this.handle) return;
    const assets = this.handle.doc()?.assets;
    const missing = names.filter((name) => !(name in (assets ?? {})));
    if (missing.length === 0) return;
    this.handle.change((doc) => {
      doc.assets ??= {};
      for (const name of missing) doc.assets[name] = "";
    });
  }

  addAsset(name: string, key = ""): void {
    this.handle?.change((doc) => {
      doc.assets ??= {};
      doc.assets[name] = key;
    });
  }

  getAssetNames(): string[] {
    return Object.keys(this.handle?.doc()?.assets ?? {});
  }

  getPublishedAssetUrl(name: string): string | null {
    const key = this.handle?.doc()?.assets?.[name];
    return key ? this.getAssetUrl(key) : null;
  }

  getCursor(position: number): string | null {
    const doc = this.handle?.doc();
    if (!doc || typeof doc.content !== "string") return null;
    const clamped = Math.max(0, Math.min(position, doc.content.length));
    try {
      return Automerge.getCursor(doc, ["content"], clamped);
    } catch {
      return null;
    }
  }

  getCursorPosition(cursor: string | null | undefined): number | null {
    if (!cursor) return null;
    const doc = this.handle?.doc();
    if (!doc || typeof doc.content !== "string") return null;
    try {
      return Automerge.getCursorPosition(doc, ["content"], cursor);
    } catch {
      return null;
    }
  }

  getSetting<K extends keyof Settings>(key: K): Settings[K] | null;
  getSetting<K extends keyof Settings>(key: K, fallback: Settings[K]): Settings[K];
  getSetting<K extends keyof Settings>(
    key: K,
    fallback: Settings[K] | null = null,
  ): Settings[K] | null {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as Settings[K];
    } catch {
      return (raw as unknown as Settings[K]) ?? fallback;
    }
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    localStorage.setItem(key, JSON.stringify(value));
  }

  getAssetUrl(name: string): string {
    return `${ASSET_SERVER_URL}/assets/${encodeURIComponent(name)}`;
  }

  async uploadAsset(blob: Blob): Promise<string | null> {
    try {
      const response = await fetch(`${ASSET_SERVER_URL}/assets/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: blob.type }),
      });
      if (!response.ok) return null;
      const { key, uploadUrl } = (await response.json()) as { key: string; uploadUrl: string };
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      return upload.ok ? key : null;
    } catch {
      return null;
    }
  }

  async publishAssets(): Promise<void> {
    const assets = this.handle?.doc()?.assets ?? {};
    const pending = Object.entries(assets).filter(([, key]) => !key);
    const results = await Promise.allSettled(
      pending.map(async ([name]) => {
        const image = await this.getImage(name);
        if (!image) throw new Error(`Local image not found: ${name}`);
        const key = await this.uploadAsset(image);
        if (!key) throw new Error(`Failed to upload local image: ${name}`);
        this.addAsset(name, key);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to upload ${failures.length} image(s)`);
    }
  }

  private async getImageDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("images", { create: true });
  }

  async saveImage(name: string, blob: Blob): Promise<string> {
    const dir = await this.getImageDir();
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return name;
  }

  async getImage(name: string): Promise<Blob | null> {
    try {
      const dir = await this.getImageDir();
      const fileHandle = await dir.getFileHandle(name);
      return await fileHandle.getFile();
    } catch {
      return null;
    }
  }

  private toSnapshot(meta: Automerge.ChangeMetadata): Snapshot {
    return {
      id: meta.hash,
      heads: encodeHeads([meta.hash]),
      timestamp: meta.time ? meta.time * 1000 : Date.now(),
    };
  }

  getHistory(): Snapshot[] {
    const doc = this.handle?.doc();
    if (!this.handle || !doc) return [];
    return Automerge.getChangesMetaSince(doc, [])
      .filter((meta) => meta.message === "snapshot")
      .reverse()
      .map((meta) => this.toSnapshot(meta));
  }

  getSnapshotContent(heads: UrlHeads): string {
    return this.handle!.view(heads).doc()?.content ?? "";
  }

  addSnapshot(content: string): Snapshot | null {
    if (!this.handle || !content.trim()) return null;
    this.updateContent(content);
    const doc = this.handle.doc();
    if (!doc) return null;

    const changes = Automerge.getChangesMetaSince(doc, []);
    const lastSnapshot = changes.findLast((meta) => meta.message === "snapshot");
    if (!lastSnapshot || this.getSnapshotContent(encodeHeads([lastSnapshot.hash])) !== content) {
      this.handle.update((d) => Automerge.emptyChange(d, { message: "snapshot" }));
    }

    const latest = Automerge.getChangesMetaSince(this.handle.doc()!, []).findLast(
      (meta) => meta.message === "snapshot",
    );
    return latest ? this.toSnapshot(latest) : null;
  }
}
