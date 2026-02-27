import { create } from 'zustand';
import logger from '../utils/logger.js';

/**
 * Transfer Store - Simplified (Phase 6 Refactoring)
 * 
 * WHAT THIS STORE MANAGES:
 * - Transfer history for UI display (completed/failed/cancelled transfers)
 * - Lightweight transfer metadata for UI
 * 
 * WHAT THIS STORE NO LONGER MANAGES (delegated to hooks/services):
 * - Progress tracking → useFileTransfer hook + ProgressTracker
 * - Pause/resume state → useFileTransfer hook + ResumableTransferManager
 * - Transfer lifecycle → useFileTransfer hook
 * - Persistence → IndexedDB via resumableTransferManager (not localStorage)
 * 
 * REMOVED:
 * - uploadProgress/downloadProgress objects (use callbacks from hooks)
 * - activeTransfers tracking (managed by useFileTransfer)
 * - Pause/resume methods (use useFileTransfer.pauseTransfer/resumeTransfer)
 * - Speed/ETA calculation (handled by ProgressTracker)
 * - localStorage persistence (conflicts with IndexedDB)
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

  // ============ DEPRECATED METHODS (kept for backward compatibility) ============
  // These are no-ops now, functionality moved to hooks
  
  /** @deprecated Use useFileTransfer hook instead */
  pauseTransfer: () => {
    logger.warn('[TransferStore] pauseTransfer is deprecated - use useFileTransfer hook');
    return false;
  },
  
  /** @deprecated Use useFileTransfer hook instead */
  resumeTransfer: () => {
    logger.warn('[TransferStore] resumeTransfer is deprecated - use useFileTransfer hook');
    return false;
  },
  
  /** @deprecated Use useFileTransfer hook instead */
  isTransferPaused: () => {
    logger.warn('[TransferStore] isTransferPaused is deprecated - use useFileTransfer hook');
    return false;
  },
  
  /** @deprecated Progress managed by ProgressTracker in transfer/ modules */
  updateUploadProgress: () => {},
  
  /** @deprecated Progress managed by ProgressTracker in transfer/ modules */
  updateDownloadProgress: () => {},
  
  /** @deprecated Transfer state managed by useFileTransfer hook */
  updateTransferStatus: () => {},
  
  /** @deprecated Use transfer hooks directly */
  getTransfer: () => null,
  
  /** @deprecated Progress tracked by ProgressTracker, use callbacks from hooks */
  getProgress: () => null,
  
  /** @deprecated Use useFileTransfer hook state */
  getActiveUploads: () => [],
  
  /** @deprecated Use useFileTransfer hook state */
  getActiveDownloads: () => [],
  
  /** @deprecated Use useFileTransfer hook state */
  getPausedTransfers: () => [],
  
  /** @deprecated Use useFileTransfer hook state */
  getOngoingUploads: () => [],
  
  /** @deprecated Use useFileTransfer hook state */
  getOngoingDownloads: () => [],
  
  /** @deprecated Crash recovery managed by resumableTransferManager */
  setRecoverableTransfers: () => {},
  
  /** @deprecated Crash recovery managed by resumableTransferManager */
  clearRecoverableTransfer: () => {},
  
  /** @deprecated Use individual cancel/complete/fail methods */
  resetAllTransfers: () => {
    set({ transferHistory: [] });
  },
}));
