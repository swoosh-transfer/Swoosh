// Minimal IndexedDB helper for transfer metadata (no chunk storage)
const DB_NAME = 'P2PFileTransfer';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('transfers')) {
        db.createObjectStore('transfers', { keyPath: 'transferId' });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'fileId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = callback(store);
    } catch (err) {
      reject(err);
    }

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveTransferMeta(meta) {
  return withStore('transfers', 'readwrite', (store) => {
    store.put(meta);
    return meta;
  });
}

export async function getTransferMeta(transferId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('transfers', 'readonly');
    const store = tx.objectStore('transfers');
    const req = store.get(transferId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateTransferMeta(transferId, patch) {
  const existing = await getTransferMeta(transferId);
  if (!existing) throw new Error('transfer not found');
  const updated = { ...existing, ...patch };
  await saveTransferMeta(updated);
  return updated;
}

export async function deleteTransferMeta(transferId) {
  return withStore('transfers', 'readwrite', (store) => {
    store.delete(transferId);
    return true;
  });
}

export async function listTransfers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('transfers', 'readonly');
    const store = tx.objectStore('transfers');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFileMeta(fileMeta) {
  return withStore('files', 'readwrite', (store) => {
    store.put(fileMeta);
    return fileMeta;
  });
}

export async function getFileMeta(fileId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const req = store.get(fileId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export default {
  openDB,
  saveTransferMeta,
  getTransferMeta,
  updateTransferMeta,
  deleteTransferMeta,
  listTransfers,
  saveFileMeta,
  getFileMeta,
};
