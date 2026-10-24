import * as Automerge from "@automerge/automerge/slim";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";
import {
  type AutomergeUrl,
  type DocHandle,
  Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
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

export interface Settings {
  docUrl: AutomergeUrl;
  theme: Theme;
  layout: LayoutSetting;
}

interface DocSchema {
  content: string;
}

export class Database {
  private handle: DocHandle<DocSchema> | null = null;
  private initPromise: Promise<DocHandle<DocSchema>> | null = null;

  async init(defaultContent: string): Promise<DocHandle<DocSchema>> {
    if (this.handle) return this.handle;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await Automerge.initializeWasm(wasmUrl);
      const repo = new Repo({
        storage: new IndexedDBStorageAdapter(),
      });
      const savedUrl = this.getSetting("docUrl");
      if (savedUrl) {
        try {
          this.handle = await repo.find<DocSchema>(savedUrl);
          return this.handle;
        } catch {
          // Fall through to create a new document if not found in storage
        }
      }
      this.handle = repo.create<DocSchema>({ content: defaultContent });
      this.setSetting("docUrl", this.handle.url);
      return this.handle;
    })();

    return this.initPromise;
  }

  getContent(fallback = ""): string {
    return this.handle?.doc()?.content ?? fallback;
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
    const current = this.handle.doc()?.content;
    if (current !== content) {
      this.handle.change((doc) => {
        Automerge.updateText(doc, ["content"], content);
      });
    }
    const heads = this.handle.heads();
    if (!heads.length) return null;
    return this.snapshotForHeads(this.handle, heads);
  }
}
