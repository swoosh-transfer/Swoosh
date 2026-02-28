/**
 * Progress Tracker
 * 
 * Single source of truth for transfer progress tracking.
 * Eliminates duplicate progress tracking across chunking, receiving, and UI layers.
 * 
 * Event-based architecture allows multiple subscribers without coupling.
 */

import logger from '../../utils/logger.js';
import {
  SPEED_HIGH_THRESHOLD,
  SPEED_LOW_THRESHOLD,
  SPEED_ADJUSTMENT_INCREMENT,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  INITIAL_CHUNK_SIZE
} from '../../constants/transfer.constants.js';

export class ProgressTracker {
  constructor() {
    this.transfers = new Map(); // transferId -> progress state
    this.listeners = new Map(); // transferId -> Set of callbacks
    this.speedHistory = new Map(); // transferId -> array of speed samples for moving average
    this.SPEED_WINDOW_SIZE = 5; // Number of samples to keep for moving average
  }

  /**
   * Initialize progress tracking for a transfer
   * 
   * @param {string} transferId - Transfer ID
   * @param {Object} options - Progress options
   * @param {number} options.totalChunks - Total chunks in transfer
   * @param {number} options.fileSize - Total file size in bytes
   * @param {string} options.fileName - File name
   * @param {string} options.direction - 'send' or 'receive'
   * @param {number} options.initialChunkSize - Initial chunk size in bytes (optional)
   */
  initialize(transferId, { totalChunks, fileSize, fileName, direction = 'send', initialChunkSize = INITIAL_CHUNK_SIZE }) {
    const state = {
      transferId,
      fileName,
      fileSize,
      totalChunks,
      direction,
      chunksCompleted: 0,
      bytesTransferred: 0,
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      estimatedTimeRemaining: null,
      transferSpeed: 0, // bytes per second (current)
      averageSpeed: 0, // bytes per second (moving average)
      recommendedChunkSize: initialChunkSize,
      status: 'active', // active | paused | completed | failed
    };

    this.transfers.set(transferId, state);
    this.speedHistory.set(transferId, []);
    
    logger.log(`[ProgressTracker] Initialized ${direction} transfer: ${transferId}`);
    
    this._notifyListeners(transferId, state);
    return state;
  }

  /**
   * Update progress for a chunk
   * 
   * @param {string} transferId - Transfer ID
   * @param {number} chunkIndex - Chunk index (for validation)
   * @param {number} chunkSize - Size of this chunk in bytes
   */
  updateChunk(transferId, chunkIndex, chunkSize) {
    const state = this.transfers.get(transferId);
    if (!state) {
      logger.warn(`[ProgressTracker] Transfer not found: ${transferId}`);
      return null;
    }

    state.chunksCompleted++;
    state.bytesTransferred += chunkSize;
    const now = Date.now();
    const elapsed = now - state.startTime;
    const timeSinceLastUpdate = now - state.lastUpdateTime;

    // Calculate current transfer speed (bytes per second)
    if (elapsed > 0) {
      state.transferSpeed = Math.round((state.bytesTransferred / elapsed) * 1000);
    }

    // Update speed history for moving average
    const speedHistory = this.speedHistory.get(transferId);
    if (speedHistory) {
      speedHistory.push(state.transferSpeed);
      // Keep only recent samples
      if (speedHistory.length > this.SPEED_WINDOW_SIZE) {
        speedHistory.shift();
      }
      // Calculate moving average
      state.averageSpeed = Math.round(
        speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length
      );
    }

    // Calculate recommended chunk size based on average speed
    state.recommendedChunkSize = this._getRecommendedChunkSize(state.averageSpeed);

    // Estimate time remaining
    if (state.chunksCompleted > 0 && state.status === 'active') {
      const chunksRemaining = state.totalChunks - state.chunksCompleted;
      const avgTimePerChunk = elapsed / state.chunksCompleted;
      state.estimatedTimeRemaining = Math.round(chunksRemaining * avgTimePerChunk);
    }

    state.lastUpdateTime = now;

    // Notify listeners (throttle to avoid excessive updates)
    if (timeSinceLastUpdate >= 100 || state.chunksCompleted === state.totalChunks) {
      this._notifyListeners(transferId, state);
    }

    return this.getProgress(transferId);
  }

  /**
   * Batch update for multiple chunks
   * 
   * More efficient than calling updateChunk multiple times.
   * 
   * @param {string} transferId - Transfer ID
   * @param {number} chunkCount - Number of chunks completed
   * @param {number} totalBytes - Total bytes for these chunks
   */
  updateBatch(transferId, chunkCount, totalBytes) {
    const state = this.transfers.get(transferId);
    if (!state) return null;

    state.chunksCompleted += chunkCount;
    state.bytesTransferred += totalBytes;
    const now = Date.now();
    const elapsed = now - state.startTime;

    if (elapsed > 0) {
      state.transferSpeed = Math.round((state.bytesTransferred / elapsed) * 1000);
    }

    // Update speed history for moving average
    const speedHistory = this.speedHistory.get(transferId);
    if (speedHistory) {
      speedHistory.push(state.transferSpeed);
      if (speedHistory.length > this.SPEED_WINDOW_SIZE) {
        speedHistory.shift();
      }
      state.averageSpeed = Math.round(
        speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length
      );
    }

    // Calculate recommended chunk size based on average speed
    state.recommendedChunkSize = this._getRecommendedChunkSize(state.averageSpeed);

    if (state.chunksCompleted > 0 && state.status === 'active') {
      const chunksRemaining = state.totalChunks - state.chunksCompleted;
      const avgTimePerChunk = elapsed / state.chunksCompleted;
      state.estimatedTimeRemaining = Math.round(chunksRemaining * avgTimePerChunk);
    }

    state.lastUpdateTime = now;
    this._notifyListeners(transferId, state);

    return this.getProgress(transferId);
  }

  /**
   * Update transfer status
   * 
   * @param {string} transferId - Transfer ID
   * @param {string} status - New status ('active' | 'paused' | 'completed' | 'failed')
   */
  updateStatus(transferId, status) {
    const state = this.transfers.get(transferId);
    if (!state) return null;

    state.status = status;

    if (status === 'completed') {
      state.estimatedTimeRemaining = 0;
      state.completedAt = Date.now();
    }

    this._notifyListeners(transferId, state);
    return this.getProgress(transferId);
  }

  /**
   * Get current progress
   * 
   * @param {string} transferId - Transfer ID
   * @returns {Object|null} Progress information
   */
  getProgress(transferId) {
    const state = this.transfers.get(transferId);
    if (!state) return null;

    const percentage = state.totalChunks > 0 
      ? (state.chunksCompleted / state.totalChunks) * 100 
      : 0;

    return {
      transferId: state.transferId,
      fileName: state.fileName,
      fileSize: state.fileSize,
      direction: state.direction,
      chunksCompleted: state.chunksCompleted,
      totalChunks: state.totalChunks,
      bytesTransferred: state.bytesTransferred,
      percentage: Math.min(100, Math.max(0, percentage)),
      transferSpeed: state.transferSpeed,
      estimatedTimeRemaining: state.estimatedTimeRemaining,
      status: state.status,
      elapsedTime: Date.now() - state.startTime,
      isComplete: state.chunksCompleted >= state.totalChunks,
    };
  }

  /**
   * Subscribe to progress updates
   * 
   * @param {string} transferId - Transfer ID
   * @param {Function} callback - Callback function receiving progress updates
   * @returns {Function} Unsubscribe function
   */
  subscribe(transferId, callback) {
    if (!this.listeners.has(transferId)) {
      this.listeners.set(transferId, new Set());
    }
    
    this.listeners.get(transferId).add(callback);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(transferId);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.listeners.delete(transferId);
        }
      }
    };
  }

  /**
   * Clear progress tracking for a transfer
   * 
   * @param {string} transferId - Transfer ID
   */
  clear(transferId) {
    this.transfers.delete(transferId);
    this.listeners.delete(transferId);
    this.speedHistory.delete(transferId);
    logger.log(`[ProgressTracker] Cleared transfer: ${transferId}`);
  }

  /**
   * Notify all listeners for a transfer
   * 
   * @private
   */
  _notifyListeners(transferId, state) {
    const listeners = this.listeners.get(transferId);
    if (!listeners) return;

    const progress = this.getProgress(transferId);
    listeners.forEach(callback => {
      try {
        callback(progress);
      } catch (err) {
        logger.error('[ProgressTracker] Listener error:', err);
      }
    });
  }

  /**
   * Get recommended chunk size based on measured speed
   * Uses speed bands to determine optimal chunk size
   * 
   * @private
   * @param {number} bytesPerSecond - Current average speed
   * @returns {number} - Recommended chunk size
   */
  _getRecommendedChunkSize(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond === 0) {
      return INITIAL_CHUNK_SIZE;
    }

    if (bytesPerSecond >= SPEED_HIGH_THRESHOLD) {
      // Fast connection: use larger chunks
      return Math.min(MAX_CHUNK_SIZE, Math.floor(INITIAL_CHUNK_SIZE * (1 + SPEED_ADJUSTMENT_INCREMENT)));
    } else if (bytesPerSecond >= SPEED_HIGH_THRESHOLD / 2) {
      // Good connection: use initial chunk size
      return INITIAL_CHUNK_SIZE;
    } else if (bytesPerSecond >= SPEED_LOW_THRESHOLD) {
      // Moderate connection: use slightly smaller chunks
      return Math.max(MIN_CHUNK_SIZE, Math.floor(INITIAL_CHUNK_SIZE * (1 - SPEED_ADJUSTMENT_INCREMENT * 0.5)));
    } else {
      // Slow connection: use minimum chunk size
      return MIN_CHUNK_SIZE;
    }
  }

  /**
   * Get all active transfers
   * 
   * @returns {Object[]} Array of progress objects
   */
  getAllProgress() {
    return Array.from(this.transfers.keys()).map(id => this.getProgress(id));
  }
}

// Export singleton instance
export const progressTracker = new ProgressTracker();
