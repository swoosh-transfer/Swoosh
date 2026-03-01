import { create } from 'zustand';
import logger from '../utils/logger.js';

/**
 * Transfer Store
 * 
 * WHAT THIS STORE MANAGES:
 * - Transfer history for UI display (completed/failed/cancelled transfers)
 * - Lightweight transfer metadata for UI
 * 
 * WHAT IS MANAGED ELSEWHERE:
 * - Progress tracking → useFileTransfer hook + ProgressTracker
 * - Pause/resume state → useFileTransfer hook + ResumableTransferManager
 * - Transfer lifecycle → useFileTransfer hook
 * - Persistence → IndexedDB via useTransferTracking hook
 * 
 * See stores/README.md for state management guidelines.
 */
export const useTransferStore = create((set, get) => ({
  // ============ TRANSFER HISTORY ============
  // Completed, failed, or cancelled transfers (for UI display)
  transferHistory: [],

  // ============ ACTIONS ============

  /**
   * Record a transfer initiation (lightweight tracking for history)
   * @param {Object} transferData - Transfer metadata
   * @param {string} transferData.transferId - Unique transfer identifier
   * @param {string} transferData.fileName - Name of the file
   * @param {number} transferData.fileSize - Size of file in bytes
   * @param {string} transferData.fileType - MIME type of file
   * @param {number} transferData.totalChunks - Total number of chunks
   */
  initiateUpload: (transferData) => {
    const { transferId, fileName, fileSize, fileType, totalChunks } = transferData;
    
    // Lightweight tracking - just for history
    logger.log(`[TransferStore] Upload initiated: ${fileName} (${transferId})`);
    return transferId;
  },

  /**
   * Record a download initiation (lightweight tracking for history)
   * @param {Object} transferData - Transfer metadata
   * @param {string} transferData.transferId - Unique transfer identifier
   * @param {string} transferData.fileName - Name of the file
   * @param {number} transferData.fileSize - Size of file in bytes
   * @param {string} transferData.fileType - MIME type of file
   * @param {number} transferData.totalChunks - Total number of chunks
   */
  initiateDownload: (transferData) => {
    const { transferId, fileName, fileSize, fileType, totalChunks } = transferData;
    
    // Lightweight tracking - just for history
    logger.log(`[TransferStore] Download initiated: ${fileName} (${transferId})`);
    return transferId;
  },

  /**
   * Record a completed transfer in history
   * @param {string} transferId - Transfer identifier
   * @param {Object} metadata - Transfer metadata
   */
  completeTransfer: (transferId, metadata = {}) => {
    set((state) => ({
      transferHistory: [
        ...state.transferHistory,
        {
          id: transferId,
          status: 'completed',
          completedAt: Date.now(),
          ...metadata,
        },
      ],
    }));
  },

  /**
   * Record a failed transfer in history
   * @param {string} transferId - Transfer identifier
   * @param {string} error - Error message
   * @param {Object} metadata - Transfer metadata
   */
  failTransfer: (transferId, error, metadata = {}) => {
    set((state) => ({
      transferHistory: [
        ...state.transferHistory,
        {
          id: transferId,
          status: 'failed',
          error,
          failedAt: Date.now(),
          ...metadata,
        },
      ],
    }));
  },

  /**
   * Record a cancelled transfer in history
   * @param {string} transferId - Transfer identifier
   * @param {Object} metadata - Transfer metadata
   */
  cancelTransfer: (transferId, metadata = {}) => {
    set((state) => ({
      transferHistory: [
        ...state.transferHistory,
        {
          id: transferId,
          status: 'cancelled',
          cancelledAt: Date.now(),
          ...metadata,
        },
      ],
    }));
  },

  /**
   * Clear transfer history
   */
  clearHistory: () => {
    set({ transferHistory: [] });
  },

  /**
   * Get transfer history
   * @returns {Array} Array of transfer history entries
   */
  getHistory: () => {
    return get().transferHistory;
  },

}));
