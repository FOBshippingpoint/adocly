export interface Snapshot {
  id: number;
  content: string;
  timestamp: number;
}

export class Database {
  name: string;
  version: number;
  connection: IDBDatabase | null;

  constructor(name = "AdoclyDB") {
    this.name = name;
    this.version = 3;
    this.connection = null;
  }

  async open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, this.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("history")) {
          const history = db.createObjectStore("history", {
            keyPath: "id",
            autoIncrement: true,
          });
          history.createIndex("timestamp", "timestamp", { unique: false });
        }
        if (!db.objectStoreNames.contains("settings"))
          db.createObjectStore("settings", { keyPath: "key" });
        if (!db.objectStoreNames.contains("images"))
          db.createObjectStore("images", { keyPath: "name" });
      };
      request.onsuccess = () => {
        this.connection = request.result;
        resolve(this.connection);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getSetting(
    key: string,
    fallback: string | null = null,
  ): Promise<string | null> {
    const connection = await this.open();
    return new Promise((resolve) => {
      const request = connection
        .transaction("settings", "readonly")
        .objectStore("settings")
        .get(key);
      request.onsuccess = () =>
        resolve(request.result ? request.result.value : fallback);
      request.onerror = () => resolve(fallback);
    });
  }

  async setSetting(key: string, value: string): Promise<void> {
    const connection = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction("settings", "readwrite");
      transaction.objectStore("settings").put({ key, value });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async saveImage(name: string, blob: Blob): Promise<string> {
    const connection = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction("images", "readwrite");
      transaction
        .objectStore("images")
        .put({ name, blob, timestamp: Date.now() });
      transaction.oncomplete = () => resolve(name);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getImage(name: string): Promise<Blob | null> {
    const connection = await this.open();
    return new Promise((resolve) => {
      const request = connection
        .transaction("images", "readonly")
        .objectStore("images")
        .get(name);
      request.onsuccess = () => resolve(request.result?.blob || null);
      request.onerror = () => resolve(null);
    });
  }

  async getHistory(): Promise<Snapshot[]> {
    const connection = await this.open();
    return new Promise((resolve, reject) => {
      const request = connection
        .transaction("history", "readonly")
        .objectStore("history")
        .getAll();
      request.onsuccess = () =>
        resolve(
          (request.result || []).sort((a, b) => b.timestamp - a.timestamp),
        );
      request.onerror = () => reject(request.error);
    });
  }

  async addSnapshot(content: string): Promise<Snapshot | null> {
    const connection = await this.open();
    if (!content.trim()) return null;
    const history = await this.getHistory();
    if (history[0]?.content === content) return history[0];
    const snapshot: Snapshot = { id: 0, content, timestamp: Date.now() };
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction("history", "readwrite");
      const request = transaction
        .objectStore("history")
        .add({ content, timestamp: snapshot.timestamp });
      request.onsuccess = () => {
        snapshot.id = request.result as number;
        resolve(snapshot);
      };
      request.onerror = () => reject(request.error);
    });
  }
}
