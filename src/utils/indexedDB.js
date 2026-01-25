// Minimal IndexedDB helper for transfer metadata (no chunk storage)
const DB_NAME = 'P2PFileTransfer';
const DB_VERSION = 4; // Bumped to force re-creation of all stores

const REQUIRED_STORES = ['transfers', 'files', 'chunks', 'sessions'];

let dbInstance = null;
let dbInitPromise = null;

// Initialize and open the database - with retry logic
async function openDB() {
  // Return cached instance if available and valid
  if (dbInstance && !dbInstance._closed) {
    // Verify all stores exist
    const hasAllStores = REQUIRED_STORES.every(store => 
      dbInstance.objectStoreNames.contains(store)
    );
    if (hasAllStores) {
      return dbInstance;
    }
    // Stores missing - need to recreate
    console.warn('[IndexedDB] Missing stores detected, recreating database...');
    dbInstance.close();
    dbInstance = null;
  }

  // Prevent multiple simultaneous init attempts
  if (dbInitPromise) {
    return dbInitPromise;
  }

  dbInitPromise = initDB();
  
  try {
    dbInstance = await dbInitPromise;
    return dbInstance;
  } finally {
    dbInitPromise = null;
  }
}

async function initDB() {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      console.log('[IndexedDB] Upgrading database to version', DB_VERSION);
      
      // Create all required stores if they don't exist
      if (!db.objectStoreNames.contains('transfers')) {
        console.log('[IndexedDB] Creating transfers store');
        db.createObjectStore('transfers', { keyPath: 'transferId' });
      }
      if (!db.objectStoreNames.contains('files')) {
        console.log('[IndexedDB] Creating files store');
        db.createObjectStore('files', { keyPath: 'fileId' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        console.log('[IndexedDB] Creating chunks store');
        const chunkStore = db.createObjectStore('chunks', { keyPath: ['transferId', 'chunkIndex'] });
        chunkStore.createIndex('transferId', 'transferId', { unique: false });
        chunkStore.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        console.log('[IndexedDB] Creating sessions store');
        db.createObjectStore('sessions', { keyPath: 'roomId' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      
      // Verify all stores exist after open
      const missingStores = REQUIRED_STORES.filter(store => 
        !db.objectStoreNames.contains(store)
      );
      
      if (missingStores.length > 0) {
        console.error('[IndexedDB] Missing stores after open:', missingStores);
        db.close();
        
        // Delete and retry
        console.log('[IndexedDB] Deleting corrupt database...');
        const deleteReq = window.indexedDB.deleteDatabase(DB_NAME);
        deleteReq.onsuccess = () => {
          console.log('[IndexedDB] Database deleted, recreating...');
          // Retry opening
          initDB().then(resolve).catch(reject);
        };
        deleteReq.onerror = () => {
          reject(new Error('Failed to delete corrupt database'));
        };
        return;
      }
      
      // Handle unexpected close
      db.onclose = () => {
        console.warn('[IndexedDB] Database connection closed unexpectedly');
        dbInstance = null;
      };
      
      db.onerror = (event) => {
        console.error('[IndexedDB] Database error:', event.target.error);
      };
      
      console.log('[IndexedDB] Database ready with stores:', [...db.objectStoreNames]);
      resolve(db);
    };
    
    req.onerror = () => {
      console.error('[IndexedDB] Failed to open database:', req.error);
      reject(req.error);
    };
    
    req.onblocked = () => {
      console.warn('[IndexedDB] Database blocked - close other tabs');
    };
  });
}

// Ensure database is initialized before any operation
export async function ensureDB() {
  const db = await openDB();
  
  // Double-check stores exist
  const missingStores = REQUIRED_STORES.filter(store => 
    !db.objectStoreNames.contains(store)
  );
  
  if (missingStores.length > 0) {
    throw new Error(`IndexedDB missing stores: ${missingStores.join(', ')}`);
  }
  
  return db;
}

async function withStore(storeName, mode, callback) {
  const db = await ensureDB();
  
  // Validate store exists
  if (!db.objectStoreNames.contains(storeName)) {
    throw new Error(`Store '${storeName}' not found in database`);
  }
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      
      try {
        result = callback(store);
      } catch (err) {
        reject(err);
        return;
      }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('Transaction aborted'));
    } catch (err) {
      // If transaction fails, invalidate db instance
      console.error('[IndexedDB] Transaction creation failed:', err);
      dbInstance = null;
      reject(err);
    }
  });
}

export async function saveTransferMeta(meta) {
  return withStore('transfers', 'readwrite', (store) => {
    store.put(meta);
    return meta;
  });
}

export async function getTransferMeta(transferId) {
  const db = await ensureDB();
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
  const db = await ensureDB();
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
  const db = await ensureDB();
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
  const db = await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const store = tx.objectStore('chunks');
    const req = store.get([transferId, chunkIndex]);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getChunksByTransfer(transferId) {
  const db = await ensureDB();
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
  const db = await ensureDB();
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

// Initialize database - call this at app startup
export async function initializeDatabase() {
  try {
    const db = await ensureDB();
    console.log('[IndexedDB] Database initialized successfully');
    return { success: true, stores: [...db.objectStoreNames] };
  } catch (err) {
    console.error('[IndexedDB] Database initialization failed:', err);
    return { success: false, error: err.message };
  }
}

// Delete and recreate database (for debugging/recovery)
export async function resetDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => {
      console.log('[IndexedDB] Database deleted');
      // Reinitialize
      initializeDatabase().then(resolve).catch(reject);
    };
    req.onerror = () => reject(req.error);
  });
}

export default {
  openDB,
  ensureDB,
  initializeDatabase,
  resetDatabase,
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
