// On-device storage for setups made with setup.html, so a new frame can be
// tested on the phone straight away (index.html?setup=local:<id>) before the
// files are committed to the site. Data stays in this browser only.

const DB_NAME = 'frame-ar';
const STORE = 'setups';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser has no on-device storage (IndexedDB).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** record: { id, setup, mind: ArrayBuffer, target: Blob, photo?: Blob, savedAt } */
export const saveLocalSetup = (record) => withStore('readwrite', (s) => s.put(record));
export const getLocalSetup = (id) => withStore('readonly', (s) => s.get(id));
export const listLocalSetups = () => withStore('readonly', (s) => s.getAll());
export const deleteLocalSetup = (id) => withStore('readwrite', (s) => s.delete(id));
