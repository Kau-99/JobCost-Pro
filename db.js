/* ─── IndexedDB factory ──────────────────────────────────── */
export function createIDB(APP) {
  let db;
  const wrap = (r) =>
    new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror  = () => rej(r.error);
    });

  return {
    open: () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open(APP.dbName, APP.dbVersion);
        r.onupgradeneeded = () => {
          const d = r.result;
          Object.values(APP.stores).forEach((s) => {
            if (!d.objectStoreNames.contains(s))
              d.createObjectStore(s, { keyPath: "id" });
          });
        };
        r.onsuccess = () => { db = r.result; resolve(db); };
        r.onerror   = () => reject(r.error);
      }),
    getAll: (s) =>
      wrap(db.transaction(s, "readonly").objectStore(s).getAll()),
    put: (s, v) =>
      wrap(db.transaction(s, "readwrite").objectStore(s).put(v)),
    del: (s, id) =>
      wrap(db.transaction(s, "readwrite").objectStore(s).delete(id)),
  };
}
