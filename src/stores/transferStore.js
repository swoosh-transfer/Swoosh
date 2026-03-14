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
   * Record an initiated upload in history
   * @param {Object} metadata - Transfer metadata (transferId, fileName, fileSize, fileType, totalChunks)
   */
  initiateUpload: (metadata = {}) => {
    set((state) => ({
      transferHistory: [
        ...state.transferHistory,
        {
          id: metadata.transferId,
          status: 'uploading',
          direction: 'upload',
          startedAt: Date.now(),
          ...metadata,
        },
      ],
    }));
  },

  /**
   * Record an initiated download in history
   * @param {Object} metadata - Transfer metadata (transferId, fileName, fileSize, fileType, totalChunks)
   */
  initiateDownload: (metadata = {}) => {
    set((state) => ({
      transferHistory: [
        ...state.transferHistory,
        {
          id: metadata.transferId,
          status: 'downloading',
          direction: 'download',
          startedAt: Date.now(),
          ...metadata,
        },
      ],
    }));
  },

  /**
   * Record a completed transfer in history
   * @param {string} transferId - Transfer identifier
   * @param {Object} metadata - Transfer metadata
   */
  completeTransfer: (transferId, metadata = {}) => {
    set((state) => {
      const existing = state.transferHistory.findIndex((t) => t.id === transferId);
      if (existing !== -1) {
        // Update existing entry
        const updated = [...state.transferHistory];
        updated[existing] = {
          ...updated[existing],
          status: 'completed',
          completedAt: Date.now(),
          ...metadata,
        };
        return { transferHistory: updated };
      }
      // Fallback: create new entry if not found
      return {
        transferHistory: [
          ...state.transferHistory,
          {
            id: transferId,
            status: 'completed',
            completedAt: Date.now(),
            ...metadata,
          },
        ],
      };
    });
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
