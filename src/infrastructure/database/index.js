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

/**
 * Clean up all data for a completed transfer
 * 
 * Removes transfer metadata, file metadata, and all chunk metadata.
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
import { deleteTransfer } from './transfers.repository.js';
import { deleteChunksByTransfer } from './chunks.repository.js';
import { deleteFileMetadata } from './metadata.repository.js';
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
    
    // Delete file metadata (use transferId as fileId)
    await deleteFileMetadata(transferId);
    logger.log(`[Database] Deleted file metadata for: ${transferId}`);
    
    logger.log(`[Database] Cleanup completed for transfer: ${transferId}`);
    return { success: true };
  } catch (err) {
    logger.error(`[Database] Cleanup failed for transfer ${transferId}:`, err);
    return { success: false, error: err.message };
  }
}
