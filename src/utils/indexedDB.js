// Minimal IndexedDB helper for transfer metadata (no chunk storage)
const DB_NAME = 'P2PFileTransfer';
const DB_VERSION = 3; // Updated to include chunks store

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
      if (!db.objectStoreNames.contains('chunks')) {
        const chunkStore = db.createObjectStore('chunks', { keyPath: ['transferId', 'chunkIndex'] });
        chunkStore.createIndex('transferId', 'transferId', { unique: false });
        chunkStore.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'roomId' });
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

// Chunk metadata storage functions
export async function saveChunkMeta(chunkMeta) {
  return withStore('chunks', 'readwrite', (store) => {
    store.put(chunkMeta);
    return chunkMeta;
  });
}

export async function getChunkMeta(transferId, chunkIndex) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const store = tx.objectStore('chunks');
    const req = store.get([transferId, chunkIndex]);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getChunksByTransfer(transferId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const store = tx.objectStore('chunks');
    const index = store.index('transferId');
    const req = index.getAll(transferId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteChunksByTransfer(transferId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const index = store.index('transferId');
    const req = index.openCursor(transferId);
    
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve(true);
      }
    };
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
  saveChunkMeta,
  getChunkMeta,
  getChunksByTransfer,
  deleteChunksByTransfer,
};
