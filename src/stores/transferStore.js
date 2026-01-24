import { create } from 'zustand';

/**
 * Transfer Store
 * Handles file transfer operations and progress tracking.
 * Maintains active transfers and provides real-time progress updates.
 */
export const useTransferStore = create((set, get) => ({
  // State
  activeTransfers: [], // Array of transfer objects
  uploadProgress: {}, // { [transferId]: { current, total, percentage, speed, eta } }
  downloadProgress: {}, // { [transferId]: { current, total, percentage, speed, eta } }
  transferHistory: [], // Completed/cancelled transfers

  // Actions

  /**
   * Initiate a new file upload transfer
   * @param {Object} transferData - Transfer initialization data
   * @param {string} transferData.transferId - Unique transfer identifier
   * @param {string} transferData.fileName - Name of the file
   * @param {number} transferData.fileSize - Size of file in bytes
   * @param {string} transferData.fileType - MIME type of file
   * @param {number} transferData.totalChunks - Total number of chunks
   * @param {string} transferData.fileHash - SHA256 hash of complete file
   */
  initiateUpload: (transferData) => {
    const { transferId, fileName, fileSize, fileType, totalChunks, fileHash } = transferData;

    const transfer = {
      id: transferId,
      type: 'upload',
      fileName,
      fileSize,
      fileType,
      totalChunks,
      fileHash,
      status: 'pending', // 'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled'
      startTime: Date.now(),
      endTime: null,
    };

    const progress = {
      current: 0,
      total: fileSize,
      chunksCompleted: 0,
      totalChunks,
      percentage: 0,
      speed: 0, // bytes per second
      eta: null, // estimated time of arrival in seconds
      lastUpdate: Date.now(),
    };

    set((state) => ({
      activeTransfers: [...state.activeTransfers, transfer],
      uploadProgress: {
        ...state.uploadProgress,
        [transferId]: progress,
      },
    }));

    return transferId;
  },

  /**
   * Initiate a new file download transfer
   * @param {Object} transferData - Transfer initialization data
   * @param {string} transferData.transferId - Unique transfer identifier
   * @param {string} transferData.fileName - Name of the file
   * @param {number} transferData.fileSize - Size of file in bytes
   * @param {string} transferData.fileType - MIME type of file
   * @param {number} transferData.totalChunks - Total number of chunks
   * @param {string} transferData.fileHash - SHA256 hash of complete file
   */
  initiateDownload: (transferData) => {
    const { transferId, fileName, fileSize, fileType, totalChunks, fileHash } = transferData;

    const transfer = {
      id: transferId,
      type: 'download',
      fileName,
      fileSize,
      fileType,
      totalChunks,
      fileHash,
      status: 'pending',
      startTime: Date.now(),
      endTime: null,
    };

    const progress = {
      current: 0,
      total: fileSize,
      chunksCompleted: 0,
      totalChunks,
      percentage: 0,
      speed: 0,
      eta: null,
      lastUpdate: Date.now(),
    };

    set((state) => ({
      activeTransfers: [...state.activeTransfers, transfer],
      downloadProgress: {
        ...state.downloadProgress,
        [transferId]: progress,
      },
    }));

    return transferId;
  },

  /**
   * Update upload progress for a specific transfer
   * @param {string} transferId - Transfer identifier
   * @param {Object} progressData - Progress update data
   * @param {number} progressData.bytesTransferred - Bytes transferred in this update
   * @param {number} progressData.chunksCompleted - Number of chunks completed
   */
  updateUploadProgress: (transferId, progressData) => {
    const { bytesTransferred, chunksCompleted } = progressData;
    const currentProgress = get().uploadProgress[transferId];

    if (!currentProgress) {
      console.warn(`Upload progress not found for transfer: ${transferId}`);
      return;
    }

    const now = Date.now();
    const timeDiff = (now - currentProgress.lastUpdate) / 1000; // seconds
    const newCurrent = currentProgress.current + bytesTransferred;
    const percentage = Math.min((newCurrent / currentProgress.total) * 100, 100);
    
    // Calculate speed (bytes per second)
    const speed = timeDiff > 0 ? bytesTransferred / timeDiff : currentProgress.speed;
    
    // Calculate ETA (seconds)
    const remainingBytes = currentProgress.total - newCurrent;
    const eta = speed > 0 ? remainingBytes / speed : null;

    set((state) => ({
      uploadProgress: {
        ...state.uploadProgress,
        [transferId]: {
          ...currentProgress,
          current: newCurrent,
          chunksCompleted: chunksCompleted ?? currentProgress.chunksCompleted,
          percentage: parseFloat(percentage.toFixed(2)),
          speed: parseFloat(speed.toFixed(2)),
          eta: eta ? parseFloat(eta.toFixed(2)) : null,
          lastUpdate: now,
        },
      },
    }));

    // Update transfer status to active if it was pending
    const transfer = get().activeTransfers.find(t => t.id === transferId);
    if (transfer && transfer.status === 'pending') {
      get().updateTransferStatus(transferId, 'active');
    }
  },

  /**
   * Update download progress for a specific transfer
   * @param {string} transferId - Transfer identifier
   * @param {Object} progressData - Progress update data
   * @param {number} progressData.bytesTransferred - Bytes transferred in this update
   * @param {number} progressData.chunksCompleted - Number of chunks completed
   */
  updateDownloadProgress: (transferId, progressData) => {
    const { bytesTransferred, chunksCompleted } = progressData;
    const currentProgress = get().downloadProgress[transferId];

    if (!currentProgress) {
      console.warn(`Download progress not found for transfer: ${transferId}`);
      return;
    }

    const now = Date.now();
    const timeDiff = (now - currentProgress.lastUpdate) / 1000; // seconds
    const newCurrent = currentProgress.current + bytesTransferred;
    const percentage = Math.min((newCurrent / currentProgress.total) * 100, 100);
    
    // Calculate speed (bytes per second)
    const speed = timeDiff > 0 ? bytesTransferred / timeDiff : currentProgress.speed;
    
    // Calculate ETA (seconds)
    const remainingBytes = currentProgress.total - newCurrent;
    const eta = speed > 0 ? remainingBytes / speed : null;

    set((state) => ({
      downloadProgress: {
        ...state.downloadProgress,
        [transferId]: {
          ...currentProgress,
          current: newCurrent,
          chunksCompleted: chunksCompleted ?? currentProgress.chunksCompleted,
          percentage: parseFloat(percentage.toFixed(2)),
          speed: parseFloat(speed.toFixed(2)),
          eta: eta ? parseFloat(eta.toFixed(2)) : null,
          lastUpdate: now,
        },
      },
    }));

    // Update transfer status to active if it was pending
    const transfer = get().activeTransfers.find(t => t.id === transferId);
    if (transfer && transfer.status === 'pending') {
      get().updateTransferStatus(transferId, 'active');
    }
  },

  /**
   * Update transfer status
   * @param {string} transferId - Transfer identifier
   * @param {string} status - New status
   */
  updateTransferStatus: (transferId, status) => {
    set((state) => ({
      activeTransfers: state.activeTransfers.map((transfer) =>
        transfer.id === transferId
          ? {
              ...transfer,
              status,
              endTime: status === 'completed' || status === 'failed' || status === 'cancelled'
                ? Date.now()
                : transfer.endTime,
            }
          : transfer
      ),
    }));

    // Move to history if completed, failed, or cancelled
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      const transfer = get().activeTransfers.find(t => t.id === transferId);
      if (transfer) {
        set((state) => ({
          transferHistory: [...state.transferHistory, { ...transfer, status }],
        }));
      }
    }
  },

  /**
   * Cancel an ongoing transfer with proper cleanup
   * @param {string} transferId - Transfer identifier
   */
  cancelTransfer: (transferId) => {
    const transfer = get().activeTransfers.find(t => t.id === transferId);
    
    if (!transfer) {
      console.warn(`Transfer not found: ${transferId}`);
      return false;
    }

    // Update status to cancelled
    get().updateTransferStatus(transferId, 'cancelled');

    // Clean up progress data after a delay to allow UI to update
    setTimeout(() => {
      set((state) => {
        const newUploadProgress = { ...state.uploadProgress };
        const newDownloadProgress = { ...state.downloadProgress };
        
        delete newUploadProgress[transferId];
        delete newDownloadProgress[transferId];

        return {
          activeTransfers: state.activeTransfers.filter(t => t.id !== transferId),
          uploadProgress: newUploadProgress,
          downloadProgress: newDownloadProgress,
        };
      });
    }, 1000);

    return true;
  },

  /**
   * Complete a transfer
   * @param {string} transferId - Transfer identifier
   */
  completeTransfer: (transferId) => {
    get().updateTransferStatus(transferId, 'completed');

    // Clean up progress data after a delay
    setTimeout(() => {
      set((state) => {
        const newUploadProgress = { ...state.uploadProgress };
        const newDownloadProgress = { ...state.downloadProgress };
        
        delete newUploadProgress[transferId];
        delete newDownloadProgress[transferId];

        return {
          activeTransfers: state.activeTransfers.filter(t => t.id !== transferId),
          uploadProgress: newUploadProgress,
          downloadProgress: newDownloadProgress,
        };
      });
    }, 3000); // Keep completed status visible for 3 seconds
  },

  /**
   * Mark transfer as failed
   * @param {string} transferId - Transfer identifier
   * @param {string} error - Error message
   */
  failTransfer: (transferId, error) => {
    const transfer = get().activeTransfers.find(t => t.id === transferId);
    
    if (transfer) {
      set((state) => ({
        activeTransfers: state.activeTransfers.map(t =>
          t.id === transferId ? { ...t, error } : t
        ),
      }));
    }

    get().updateTransferStatus(transferId, 'failed');
  },

  /**
   * Get transfer by ID
   * @param {string} transferId - Transfer identifier
   * @returns {Object|null}
   */
  getTransfer: (transferId) => {
    return get().activeTransfers.find(t => t.id === transferId) || null;
  },

  /**
   * Get progress for a specific transfer
   * @param {string} transferId - Transfer identifier
   * @returns {Object|null}
   */
  getProgress: (transferId) => {
    const { uploadProgress, downloadProgress } = get();
    return uploadProgress[transferId] || downloadProgress[transferId] || null;
  },

  /**
   * Get all active uploads
   * @returns {Array}
   */
  getActiveUploads: () => {
    return get().activeTransfers.filter(t => t.type === 'upload' && t.status === 'active');
  },

  /**
   * Get all active downloads
   * @returns {Array}
   */
  getActiveDownloads: () => {
    return get().activeTransfers.filter(t => t.type === 'download' && t.status === 'active');
  },

  /**
   * Clear completed transfers from history
   */
  clearHistory: () => {
    set({ transferHistory: [] });
  },

  /**
   * Reset all transfers (use with caution)
   */
  resetAllTransfers: () => {
    set({
      activeTransfers: [],
      uploadProgress: {},
      downloadProgress: {},
      transferHistory: [],
    });
  },
}));
