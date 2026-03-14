/**
 * Transfers Repository
 * 
 * CRUD operations for transfer metadata.
 * Manages active and completed file transfer records.
 */

import { STORE_NAMES, getDatabase, withTransaction } from './client.js';
import { deleteChunksByTransfer } from './chunks.repository.js';
import logger from '../../utils/logger.js';

/**
 * Save transfer metadata
 * 
 * @param {Object} transfer - Transfer metadata
 * @returns {Promise<Object>} Saved transfer object
 */
export async function saveTransfer(transfer) {
  return withTransaction(STORE_NAMES.TRANSFERS, 'readwrite', (store) => {
    store.put(transfer);
    return transfer;
  });
}

/**
 * Get transfer by ID
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<Object|undefined>} Transfer metadata or undefined
 */
export async function getTransfer(transferId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.TRANSFERS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.TRANSFERS);
    const req = store.get(transferId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Update transfer metadata
 * 
 * Merges provided patch with existing transfer data.
 * Uses atomic transaction to prevent race conditions.
 * 
 * @param {string} transferId - Transfer ID
 * @param {Object} patch - Properties to update
 * @returns {Promise<Object>} Updated transfer object
 * @throws {Error} If transfer not found
 */
export async function updateTransfer(transferId, patch) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.TRANSFERS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.TRANSFERS);
    const getReq = store.get(transferId);
    let updated;
    
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        reject(new Error(`Transfer ${transferId} not found`));
        return;
      }
      updated = { ...existing, ...patch, updatedAt: Date.now() };
      const putReq = store.put(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
}

/**
 * Delete transfer
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteTransfer(transferId) {
  return withTransaction(STORE_NAMES.TRANSFERS, 'readwrite', (store) => {
    store.delete(transferId);
    return true;
  });
}

/**
 * List all transfers
 * 
 * @returns {Promise<Object[]>} Array of transfer objects
 */
export async function listTransfers() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES.TRANSFERS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.TRANSFERS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get transfers by status
 * 
 * @param {string} status - Transfer status to filter by
 * @returns {Promise<Object[]>} Array of matching transfers
 */
export async function getTransfersByStatus(status) {
  const allTransfers = await listTransfers();
  return allTransfers.filter(t => t.status === status);
}

/**
 * Clean up old transfers (batch delete)
 * 
 * Removes transfer records older than specified age.
 * Also deletes associated chunks and file metadata to prevent orphaned data.
 * 
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 7 days)
 * @returns {Promise<number>} Number of transfers deleted
 */
export async function cleanupOldTransfers(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const transfers = await listTransfers();
  const cutoffTime = Date.now() - maxAgeMs;
  
  const toDelete = transfers
    .filter((t) => {
      // Completed transfers older than cutoff
      if (t.completedAt && t.completedAt < cutoffTime) return true;
      // Stale incomplete transfers older than cutoff
      if (t.createdAt && t.createdAt < cutoffTime) return true;
      return false;
    });

  if (toDelete.length === 0) return 0;

  // For each old transfer, also delete associated chunks and file metadata
  const db = await getDatabase();

  for (const t of toDelete) {
    try {
      // Delete chunks for this transfer
      await deleteChunksByTransfer(t.transferId);

      // Delete file metadata by transferId index
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAMES.FILES, 'readwrite');
        const store = tx.objectStore(STORE_NAMES.FILES);
        if (store.indexNames.contains('transferId')) {
          const index = store.index('transferId');
          const req = index.openCursor(IDBKeyRange.only(t.transferId));
          req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
            else resolve();
          };
          req.onerror = () => reject(req.error);
        } else {
          resolve();
        }
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      logger.warn(`[TransfersRepo] Failed to clean associated data for ${t.transferId}:`, e);
    }
  }

  // Batch delete transfer records
  const idsToDelete = toDelete.map((t) => t.transferId);
  await withTransaction(STORE_NAMES.TRANSFERS, 'readwrite', (store) => {
    for (const id of idsToDelete) {
      store.delete(id);
    }
  });

  logger.info(`[TransfersRepo] Batch-deleted ${idsToDelete.length} old transfers`);
  return idsToDelete.length;
}

/**
 * Namespace adapter object for consumers that import { transfersRepository }
 * Maps method names used in transfer layer to repository functions.
 */
export const transfersRepository = {
  save: saveTransfer,
  findById: getTransfer,
  update: updateTransfer,
  delete: deleteTransfer,
  findAll: listTransfers,
  getByStatus: getTransfersByStatus,
  cleanup: cleanupOldTransfers,
};
