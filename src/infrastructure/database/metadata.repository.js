/**
 * Metadata Repository
 * 
 * CRUD operations for file metadata.
 * Stores file information separate from transfer records.
 */

import { STORE_NAMES, getDatabase, withTransaction } from './client.js';

/**
 * Save file metadata
 * 
 * @param {Object} fileMeta - File metadata
 * @returns {Promise<Object>} Saved file object
 */
export async function saveFileMetadata(fileMeta) {
  return withTransaction(STORE_NAMES.FILES, 'readwrite', (store) => {
    store.put(fileMeta);
    return fileMeta;
  });
}

/**
 * Get file metadata by ID
 * 
 * @param {string} fileId - File ID
 * @returns {Promise<Object|undefined>} File metadata or undefined
 */
export async function getFileMetadata(fileId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.FILES, 'readonly');
    const store = tx.objectStore(STORE_NAMES.FILES);
    const req = store.get(fileId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete file metadata
 * 
 * @param {string} fileId - File ID
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteFileMetadata(fileId) {
  return withTransaction(STORE_NAMES.FILES, 'readwrite', (store) => {
    store.delete(fileId);
    return true;
  });
}

/**
 * List all file metadata
 * 
 * @returns {Promise<Object[]>} Array of file objects
 */
export async function listFiles() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.FILES, 'readonly');
    const store = tx.objectStore(STORE_NAMES.FILES);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
