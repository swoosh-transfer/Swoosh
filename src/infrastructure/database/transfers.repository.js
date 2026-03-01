/**
 * Transfers Repository
 * 
 * CRUD operations for transfer metadata.
 * Manages active and completed file transfer records.
 */

import { STORE_NAMES, getDatabase, withTransaction } from './client.js';
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
 * 
 * @param {string} transferId - Transfer ID
 * @param {Object} patch - Properties to update
 * @returns {Promise<Object>} Updated transfer object
 * @throws {Error} If transfer not found
 */
export async function updateTransfer(transferId, patch) {
  const existing = await getTransfer(transferId);
  if (!existing) {
    throw new Error(`Transfer ${transferId} not found`);
  }
  
  const updated = { ...existing, ...patch, updatedAt: Date.now() };
  await saveTransfer(updated);
  return updated;
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
 * Clean up old completed transfers
 * 
 * Removes transfer records older than specified age.
 * 
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {Promise<number>} Number of transfers deleted
 */
export async function cleanupOldTransfers(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const transfers = await listTransfers();
  const cutoffTime = Date.now() - maxAgeMs;
  let deletedCount = 0;
  
  for (const transfer of transfers) {
    if (transfer.completedAt && transfer.completedAt < cutoffTime) {
      await deleteTransfer(transfer.transferId);
      deletedCount++;
      logger.info(`[TransfersRepo] Deleted old transfer: ${transfer.transferId}`);
    }
  }
  
  return deletedCount;
}

/**
 * Namespace adapter for object-style access.
 * Maps method names expected by consumers to actual functions.
 */
export const transfersRepository = {
  save: saveTransfer,
  saveTransfer,
  findById: getTransfer,
  getTransfer,
  update: updateTransfer,
  updateTransfer,
  delete: deleteTransfer,
  deleteTransfer,
  findAll: listTransfers,
  listTransfers,
  getTransfersByStatus,
  cleanupOldTransfers,
};
