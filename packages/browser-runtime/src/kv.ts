/**
 * A minimal IndexedDB key/value store for what lives outside Postgres in the
 * browser runtime: uploaded file bytes, the session cookie jar, the token
 * signing key and the sent-mail log.
 */
const DB_NAME = 'assets-runtime';
const STORES = ['blobs', 'meta', 'mail'] as const;
export type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => STORES.forEach((s) => req.result.objectStoreNames.contains(s) || req.result.createObjectStore(s));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const kv = {
  get: <T>(store: Store, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key)),
  set: (store: Store, key: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined),
  delete: (store: Store, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined),
  values: <T>(store: Store) => run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  clear: (store: Store) => run(store, 'readwrite', (s) => s.clear()).then(() => undefined),
};

/** Removes everything the runtime stored (used by "Reset this browser's data"). */
export async function deleteRuntimeStores(): Promise<void> {
  const db = await open();
  db.close();
  opening = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
