/** 极简 IndexedDB 键值封装。所有数据都只存在用户自己的浏览器里。 */

export const STORES = ['papers', 'sync', 'vault', 'pdfs', 'pdfmeta', 'kv'] as const;
export type StoreName = (typeof STORES)[number];

export interface Idb {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  all<T>(store: StoreName): Promise<[string, T][]>;
  clear(store: StoreName): Promise<void>;
  close(): void;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function createIdb(name = 'paper-reader'): Idb {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  };

  return {
    async get<T>(store: StoreName, key: string) {
      const db = await open();
      return (await wrap(db.transaction(store).objectStore(store).get(key))) as T | undefined;
    },
    async put(store, key, value) {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      await txDone(tx);
    },
    async del(store, key) {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      await txDone(tx);
    },
    async all<T>(store: StoreName) {
      const db = await open();
      const os = db.transaction(store).objectStore(store);
      const [keys, values] = await Promise.all([wrap(os.getAllKeys()), wrap(os.getAll())]);
      return keys.map((k, i) => [String(k), values[i] as T] as [string, T]);
    },
    async clear(store) {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      await txDone(tx);
    },
    close() {
      dbp?.then((d) => d.close()).catch(() => {});
      dbp = null;
    },
  };
}
