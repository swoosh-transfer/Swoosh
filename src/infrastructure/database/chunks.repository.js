/**
 * Chunks Repository
 * 
 * CRUD operations for chunk metadata.
 * Tracks chunk status, validation, and retransmission needs.
 */

import { STORE_NAMES, getDatabase, withTransaction } from './client.js';
import logger from '../../utils/logger.js';

/**
 * Save chunk metadata
 * 
 * @param {Object} chunk - Chunk metadata
 * @returns {Promise<Object>} Saved chunk object
 */
export async function saveChunk(chunk) {
  return withTransaction(STORE_NAMES.CHUNKS, 'readwrite', (store) => {
    store.put(chunk);
    return chunk;
  });
}

/**
 * Get chunk by transfer ID and index
 * 
 * @param {string} transferId - Transfer ID
 * @param {number} chunkIndex - Chunk index
 * @returns {Promise<Object|undefined>} Chunk metadata or undefined
 */
export async function getChunk(transferId, chunkIndex) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.CHUNKS);
    const req = store.get([transferId, chunkIndex]);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all chunks for a transfer
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<Object[]>} Array of chunk objects
 */
export async function getChunksByTransfer(transferId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.CHUNKS);
    const index = store.index('transferId');
    const req = index.getAll(transferId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get chunks by status
 * 
 * @param {string} transferId - Transfer ID
 * @param {string} status - Chunk status ('pending', 'received', 'validated', 'written')
 * @returns {Promise<Object[]>} Array of matching chunks
 */
export async function getChunksByStatus(transferId, status) {
  const allChunks = await getChunksByTransfer(transferId);
  return allChunks.filter(c => c.status === status);
}

/**
 * Get missing chunk indices
 * 
 * Returns indices of chunks that haven't been received yet.
 * 
 * @param {string} transferId - Transfer ID
 * @param {number} totalChunks - Total expected chunks
 * @returns {Promise<number[]>} Array of missing chunk indices
 */
export async function getMissingChunks(transferId, totalChunks) {
  const receivedChunks = await getChunksByTransfer(transferId);
  const receivedIndices = new Set(receivedChunks.map(c => c.chunkIndex));
  
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!receivedIndices.has(i)) {
      missing.push(i);
    }
  }
  
  return missing;
}

/**
 * Update chunk status
 * 
 * @param {string} transferId - Transfer ID
 * @param {number} chunkIndex - Chunk index
 * @param {string} status - New status
 * @param {Object} extraData - Additional data to merge
 * @returns {Promise<Object>} Updated chunk object
 */
export async function updateChunkStatus(transferId, chunkIndex, status, extraData = {}) {
  const existing = await getChunk(transferId, chunkIndex);
  
  const updated = {
    ...existing,
    transferId,
    chunkIndex,
    status,
    ...extraData,
    updatedAt: Date.now(),
  };
  
  await saveChunk(updated);
  return updated;
}

/**
 * Batch save chunks
 * 
 * Efficiently saves multiple chunks in a single transaction.
 * 
 * @param {Object[]} chunks - Array of chunk objects
 * @returns {Promise<number>} Number of chunks saved
 */
export async function saveChunksBatch(chunks) {
  return withTransaction(STORE_NAMES.CHUNKS, 'readwrite', (store) => {
    chunks.forEach(chunk => store.put(chunk));
    return chunks.length;
  });
}

/**
 * Delete chunks for a transfer
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<number>} Number of chunks deleted
 */
export async function deleteChunksByTransfer(transferId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.CHUNKS);
    const index = store.index('transferId');
    const req = index.openCursor(transferId);
    
    let count = 0;
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        count++;
        cursor.continue();
      } else {
        resolve(count);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get chunk statistics for a transfer
 * 
 * @param {string} transferId - Transfer ID
 * @param {number} totalChunks - Total expected chunks
 * @returns {Promise<Object>} Statistics object
 */
export async function getChunkStats(transferId, totalChunks) {
  const chunks = await getChunksByTransfer(transferId);
  
  const byStatus = chunks.reduce((acc, chunk) => {
    acc[chunk.status] = (acc[chunk.status] || 0) + 1;
    return acc;
  }, {});
  
  const received = chunks.length;
  const missing = totalChunks - received;
  const percentComplete = (received / totalChunks) * 100;
  
  return {
    total: totalChunks,
    received,
    missing,
    percentComplete,
    byStatus,
  };
}
