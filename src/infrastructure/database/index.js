/**
 * Database Module
 * 
 * Central export for all database operations.
 * Use repositories for specific entity operations.
 * 
 * @example
 * import { saveTransfer, getChunksByTransfer } from '@/infrastructure/database';
 * import { initializeDatabase } from '@/infrastructure/database';
 */

// Client
export { 
  getDatabase, 
  withTransaction, 
  initializeDatabase, 
  resetDatabase,
  STORE_NAMES,
  DB_NAME,
  DB_VERSION,
} from './client.js';

// Repositories
export * from './transfers.repository.js';
export * from './chunks.repository.js';
export * from './metadata.repository.js';

// Bitmap utilities (NOTE: getMissingChunks exported from here for bitmap operations)
// chunks.repository also exports getMissingChunks for DB queries - this is intentional
export * from './chunkBitmap.js';



/**
 * Clean up all data for a completed transfer
 * 
 * Removes transfer metadata, file metadata, and all chunk metadata.
 * Uses transferId index on files store for efficient batch deletion.
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
import { deleteTransfer } from './transfers.repository.js';
import { deleteChunksByTransfer } from './chunks.repository.js';
import { getDatabase, STORE_NAMES } from './client.js';
import logger from '../../utils/logger.js';

export async function cleanupTransferData(transferId) {
  try {
    logger.log(`[Database] Cleaning up transfer data for: ${transferId}`);
    
    // Delete chunks first (most data)
    const chunksDeleted = await deleteChunksByTransfer(transferId);
    logger.log(`[Database] Deleted ${chunksDeleted} chunks for transfer: ${transferId}`);
    
    // Delete transfer metadata
    await deleteTransfer(transferId);
    logger.log(`[Database] Deleted transfer metadata for: ${transferId}`);
    
    // Delete file metadata by transferId index using cursor
    const db = await getDatabase();
    const deletedFiles = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAMES.FILES, 'readwrite');
      const store = tx.objectStore(STORE_NAMES.FILES);
      let count = 0;
      
      if (store.indexNames.contains('transferId')) {
        const index = store.index('transferId');
        const req = index.openCursor(IDBKeyRange.only(transferId));
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
      } else {
        // Fallback: try deleting by transferId as fileId (legacy)
        store.delete(transferId);
        resolve(1);
      }
      
      tx.onerror = () => reject(tx.error);
    });
    logger.log(`[Database] Deleted ${deletedFiles} file metadata records for transfer: ${transferId}`);
    
    logger.log(`[Database] Cleanup completed for transfer: ${transferId}`);
    return { success: true };
  } catch (err) {
    logger.error(`[Database] Cleanup failed for transfer ${transferId}:`, err);
    return { success: false, error: err.message };
  }
}
