/**
 * IndexedDB Client
 * 
 * Base database connection and schema management.
 * Provides connection pooling and automatic recovery from database errors.
 */

import logger from '../../utils/logger.js';

export const DB_NAME = 'P2PFileTransfer';
export const DB_VERSION = 5;

export const STORE_NAMES = {
  TRANSFERS: 'transfers',
  FILES: 'files',
  CHUNKS: 'chunks',
  SESSIONS: 'sessions',
};

const REQUIRED_STORES = Object.values(STORE_NAMES);

let dbInstance = null;
let dbInitPromise = null;

/**
 * Initialize database schema
 * 
 * Creates object stores and indexes if they don't exist.
 * Called during database upgrade or initial creation.
 * 
 * @param {IDBDatabase} db - Database instance
 * @param {IDBVersionChangeEvent} event - Version change event
 */
function initializeSchema(db, event) {
  logger.log('[IndexedDB] Upgrading database to version', DB_VERSION);
  
  // Transfers store: Active and completed transfers
  if (!db.objectStoreNames.contains(STORE_NAMES.TRANSFERS)) {
    logger.log('[IndexedDB] Creating transfers store');
    const transferStore = db.createObjectStore(STORE_NAMES.TRANSFERS, { keyPath: 'transferId' });
    transferStore.createIndex('status', 'status', { unique: false });
  } else {
    // Add status index if missing (v5 upgrade)
    const tx = event.currentTarget.transaction;
    const transferStore = tx.objectStore(STORE_NAMES.TRANSFERS);
    if (!transferStore.indexNames.contains('status')) {
      transferStore.createIndex('status', 'status', { unique: false });
    }
  }
  
  // Files store: File metadata
  if (!db.objectStoreNames.contains(STORE_NAMES.FILES)) {
    logger.log('[IndexedDB] Creating files store');
    const fileStore = db.createObjectStore(STORE_NAMES.FILES, { keyPath: 'fileId' });
    fileStore.createIndex('transferId', 'transferId', { unique: false });
  } else {
    // Add transferId index if missing (v5 upgrade)
    const tx = event.currentTarget.transaction;
    const fileStore = tx.objectStore(STORE_NAMES.FILES);
    if (!fileStore.indexNames.contains('transferId')) {
      fileStore.createIndex('transferId', 'transferId', { unique: false });
    }
  }
  
  // Chunks store: Chunk metadata (not chunk data)
  if (!db.objectStoreNames.contains(STORE_NAMES.CHUNKS)) {
    logger.log('[IndexedDB] Creating chunks store');
    const chunkStore = db.createObjectStore(STORE_NAMES.CHUNKS, { 
      keyPath: ['transferId', 'chunkIndex'] 
    });
    chunkStore.createIndex('transferId', 'transferId', { unique: false });
    chunkStore.createIndex('status', 'status', { unique: false });
  }
  
  // Sessions store: Room session data
  if (!db.objectStoreNames.contains(STORE_NAMES.SESSIONS)) {
    logger.log('[IndexedDB] Creating sessions store');
    db.createObjectStore(STORE_NAMES.SESSIONS, { keyPath: 'roomId' });
  }
}

/**
 * Validate database has all required stores
 * 
 * @param {IDBDatabase} db - Database instance
 * @returns {boolean} True if all stores exist
 */
function validateStores(db) {
  const missingStores = REQUIRED_STORES.filter(store => 
    !db.objectStoreNames.contains(store)
  );
  
  if (missingStores.length > 0) {
    logger.error('[IndexedDB] Missing stores:', missingStores);
    return false;
  }
  
  return true;
}

/**
 * Initialize and open database
 * 
 * @returns {Promise<IDBDatabase>}
 */
async function initDB() {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      initializeSchema(db, event);
    };

    req.onsuccess = () => {
      const db = req.result;
      
      // Verify all stores exist
      if (!validateStores(db)) {
        db.close();
        
        // Delete and retry
        logger.log('[IndexedDB] Deleting corrupt database...');
        const deleteReq = window.indexedDB.deleteDatabase(DB_NAME);
        deleteReq.onsuccess = () => {
          logger.log('[IndexedDB] Database deleted, recreating...');
          initDB().then(resolve).catch(reject);
        };
        deleteReq.onerror = () => {
          reject(new Error('Failed to delete corrupt database'));
        };
        return;
      }
      
      // Handle unexpected close
      db.onclose = () => {
        logger.warn('[IndexedDB] Database connection closed unexpectedly');
        dbInstance = null;
      };
      
      db.onerror = (event) => {
        logger.error('[IndexedDB] Database error:', event.target.error);
      };
      
      logger.log('[IndexedDB] Database ready with stores:', [...db.objectStoreNames]);
      resolve(db);
    };
    
    req.onerror = () => {
      logger.error('[IndexedDB] Failed to open database:', req.error);
      reject(req.error);
    };
    
    req.onblocked = () => {
      logger.warn('[IndexedDB] Database blocked - close other tabs');
    };
  });
}

/**
 * Get database instance
 * 
 * Returns cached instance if available, otherwise opens new connection.
 * Implements connection pooling and automatic retry.
 * 
 * @returns {Promise<IDBDatabase>}
 */
export async function getDatabase() {
  // Return cached instance if valid
  if (dbInstance && !dbInstance._closed && validateStores(dbInstance)) {
    return dbInstance;
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

/**
 * Execute operation within a transaction
 * 
 * Handles transaction lifecycle and error handling.
 * 
 * @param {string} storeName - Object store name
 * @param {string} mode - Transaction mode ('readonly' | 'readwrite')
 * @param {Function} callback - Operation to execute with store
 * @returns {Promise<any>} Result from callback
 */
export async function withTransaction(storeName, mode, callback) {
  const db = await getDatabase();
  
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
      logger.error('[IndexedDB] Transaction creation failed:', err);
      dbInstance = null;
      reject(err);
    }
  });
}

/**
 * Initialize database at app startup
 * 
 * @returns {Promise<{ success: boolean, stores?: string[], error?: string }>}
 */
export async function initializeDatabase() {
  try {
    const db = await getDatabase();
    logger.log('[IndexedDB] Database initialized successfully');
    return { success: true, stores: [...db.objectStoreNames] };
  } catch (err) {
    logger.error('[IndexedDB] Database initialization failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Reset database (delete and recreate)
 * 
 * Used for debugging or recovery from corruption.
 * 
 * @returns {Promise<{ success: boolean, stores?: string[], error?: string }>}
 */
export async function resetDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => {
      logger.log('[IndexedDB] Database deleted successfully');
      // Reinitialize
      initializeDatabase().then(resolve).catch(reject);
    };
    req.onerror = () => reject(req.error);
  });
}
