import * as Automerge from "@automerge/automerge/slim";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";
import {
  type AutomergeUrl,
  type DocHandle,
  isValidAutomergeUrl,
  Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

export interface Snapshot {
  id: string;
  content: string;
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

export interface Settings {
  docUrl: AutomergeUrl;
  theme: Theme;
  layout: LayoutSetting;
  identity: CollaboratorSetting;
}

export interface DocSchema {
  content: string;
}

const SYNC_SERVER_URL = "wss://sync.automerge.org";

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
          return this.handle;
        } catch {}
      }

      this.handle = this.repo.create<DocSchema>({ content: defaultContent });
      this.setSetting("docUrl", this.handle.url);
      return this.handle;
    })();

    return this.initPromise;
  }

  async openDocument(url: string): Promise<DocHandle<DocSchema> | null> {
    if (!this.repo || !isValidAutomergeUrl(url)) return null;
    this.enableSharing();
    if (this.handle?.url === url) return this.handle;
    try {
      const handle = await this.waitForHandle(url, 10000);
      this.handle = handle;
      this.setSetting("docUrl", handle.url);
      return handle;
    } catch {
      return null;
    }
  }

  isShared(): boolean {
    return this.shared;
  }

  enableSharing(): void {
    this.shared = true;
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

  private snapshotForHeads(handle: DocHandle<DocSchema>, heads: UrlHeads): Snapshot {
    const head = heads[0];
    const meta = handle.metadata(head);
    const viewDoc = handle.view(heads).doc();
    return {
      id: head,
      content: viewDoc?.content ?? "",
      timestamp: meta?.time ? meta.time * 1000 : Date.now(),
    };
  }

  getHistory(): Snapshot[] {
    if (!this.handle) return [];
    const handle = this.handle;
    return handle
      .history()
      .slice()
      .reverse()
      .map((heads) => this.snapshotForHeads(handle, heads));
  }

  addSnapshot(content: string): Snapshot | null {
    if (!this.handle || !content.trim()) return null;
    this.updateContent(content);
    const heads = this.handle.heads();
    if (!heads.length) return null;
    return this.snapshotForHeads(this.handle, heads);
  }
}
