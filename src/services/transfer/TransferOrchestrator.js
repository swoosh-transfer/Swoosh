/**
 * Transfer Orchestrator Service
 * 
 * **THE KEY SERVICE FOR NEW DEVELOPERS TO UNDERSTAND**
 * 
 * Orchestrates file transfer operations - both sending and receiving.
 * Coordinates ChunkingEngine, AssemblyEngine, and ResumableTransferManager.
 * Provides simple, high-level API for UI layer.
 * 
 * Transfer Lifecycle:
 * 1. Initialize: Setup transfer metadata
 * 2. Start: Begin chunking (send) or assembly (receive)
 * 3. Progress: Monitor transfer progress via events
 * 4. Pause/Resume: Control transfer flow
 * 5. Complete: Finalize transfer
 * 
 * @example
 * const orchestrator = new TransferOrchestrator(connectionService);
 * 
 * // Sending a file
 * orchestrator.on('progress', (progress) => {
 *   console.log(`${progress.percentage}% complete`);
 * });
 * 
 * await orchestrator.startSending(file, peerId);
 * 
 * // Receiving a file
 * orchestrator.on('complete', (result) => {
 *   console.log('File received:', result.fileName);
 * });
 * 
 * await orchestrator.startReceiving(transferId, fileMetadata, peerId);
 */

import {
  initializeFileTransfer,
  startFileChunking,
  pauseChunking,
  resumeChunking,
  initializeFileReception,
  processReceivedChunk,
  getMissingChunks,
  cleanupTransfer,
  createTransferId
} from '../../transfer/index.js';
import { progressTracker } from '../../transfer/shared/ProgressTracker.js';
import { BandwidthTester } from '../../utils/bandwidthTester.js';
import { 
  resumableTransferManager,
  TransferState,
  TransferRole 
} from '../../transfer/resumption/ResumableTransferManager.js';
import logger from '../../utils/logger.js';
import { TransferError } from '../../lib/errors.js';

/**
 * Transfer direction
 */
export const TransferDirection = {
  SENDING: 'sending',
  RECEIVING: 'receiving'
};

/**
 * Transfer status
 */
export const TransferStatus = {
  IDLE: 'idle',
  INITIALIZING: 'initializing',
  ACTIVE: 'active',
  PAUSED: 'paused',
  RESUMING: 'resuming',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Transfer Orchestrator Service
 * High-level transfer management and coordination
 */
export class TransferOrchestrator {
  constructor(connectionService) {
    this.connectionService = connectionService;
    
    // Active transfers
    this.activeTransfers = new Map(); // transferId -> transfer state
    
    // Event listeners
    this.eventListeners = new Map();
    
    // Current transfer (for single-transfer mode)
    this.currentTransfer = null;
  }

  /**
   * Subscribe to transfer events
   * 
   * Events:
   * - 'initialized': (transferInfo) => {}
   * - 'started': (transferId) => {}
   * - 'progress': (progress) => {}
   * - 'paused': (transferId) => {}
   * - 'resumed': (transferId) => {}
   * - 'complete': (result) => {}
   * - 'error': (error) => {}
   * - 'cancelled': (transferId) => {}
   * - 'chunkSent': (chunkInfo) => {}
   * - 'chunkReceived': (chunkInfo) => {}
   * 
   * @param {string} event - Event name
   * @param {Function} callback - Event handler
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    
    this.eventListeners.get(event).add(callback);
    
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(callback);
      }
    };
  }

  /**
   * Emit event to all subscribers
   * @private
   */
  _emit(event, ...args) {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    
    listeners.forEach(callback => {
      try {
        callback(...args);
      } catch (err) {
        logger.error(`[TransferOrchestrator] Event handler error (${event}):`, err);
      }
    });
  }

  /**
   * Start sending a file
   * 
   * @param {File} file - File to send
   * @param {string} peerId - Receiver peer ID
   * @param {Object} options - Transfer options
   * @returns {Promise<string>} Transfer ID
   */
  async startSending(file, peerId, options = {}) {
    try {
      this._updateStatus(null, TransferStatus.INITIALIZING);
      
      // Initialize transfer
      const { transferId, fileMetadata, transferRecord } = await initializeFileTransfer(file, peerId);
      
      logger.log(`[TransferOrchestrator] Initialized send transfer: ${transferId}`);
      
      // Track transfer state
      const transferState = {
        transferId,
        direction: TransferDirection.SENDING,
        status: TransferStatus.INITIALIZING,
        file,
        fileMetadata,
        transferRecord,
        peerId,
        startTime: Date.now()
      };
      
      this.activeTransfers.set(transferId, transferState);
      this.currentTransfer = transferId;
      
      this._emit('initialized', {
        transferId,
        direction: TransferDirection.SENDING,
        fileName: file.name,
        fileSize: file.size,
        peerId
      });
      
      // Subscribe to progress updates
      const unsubscribe = progressTracker.subscribe(transferId, (progress) => {
        this._emit('progress', progress);
      });
      
      transferState.unsubscribeProgress = unsubscribe;
      
      // Setup chunk ready callback for sending over connection
      const onChunkReady = async (chunkPacket) => {
        try {
          const { metadata, binaryData } = chunkPacket;
          
          // Send metadata as JSON first
          await this.connectionService.send({
            type: 'chunk-metadata',
            transferId,
            metadata
          });
          
          // Send binary data directly (no base64 encoding)
          await this.connectionService.sendBinary(binaryData);
          
          this._emit('chunkSent', {
            transferId,
            chunkIndex: metadata.chunkIndex,
            size: metadata.size
          });
          
        } catch (err) {
          logger.error('[TransferOrchestrator] Failed to send chunk:', err);
          throw err;
        }
      };

      // Measure bandwidth before starting transfer (optional, ~1-2 seconds)
      let recommendedChunkSize = undefined; // Will use default if test fails
      try {
        const dataChannel = this.connectionService.getDataChannel?.(peerId);
        if (dataChannel && dataChannel.readyState === 'open') {
          this._emit('bandwidth-testing', {
            transferId,
            message: 'Testing connection speed...'
          });

          const tester = new BandwidthTester(dataChannel);
          const testResult = await tester.measureBandwidth({
            testDuration: 1500, // 1.5 seconds
            packetSize: 8 * 1024 // 8KB packets
          });

          if (testResult.status === 'success') {
            recommendedChunkSize = testResult.recommendedChunkSize;
            logger.log(
              `[TransferOrchestrator] Bandwidth test: ${testResult.kilobytesPerSecond} KB/s, ` +
              `recommended chunk: ${recommendedChunkSize / 1024}KB`
            );

            this._emit('bandwidth-tested', {
              transferId,
              kilobytesPerSecond: testResult.kilobytesPerSecond,
              megabytesPerSecond: testResult.megabytesPerSecond,
              recommendedChunkSize
            });
          } else {
            logger.warn('[TransferOrchestrator] Bandwidth test failed, using default chunk size');
          }
        }
      } catch (err) {
        logger.warn('[TransferOrchestrator] Bandwidth test error, using default chunk size:', err);
      }
      
      // Start chunking process
      this._updateStatus(transferId, TransferStatus.ACTIVE);
      this._emit('started', transferId);
      
      await startFileChunking(transferId, file, peerId, onChunkReady, 0, recommendedChunkSize);
      
      // Transfer complete
      this._updateStatus(transferId, TransferStatus.COMPLETED);
      
      const result = {
        transferId,
        fileName: file.name,
        fileSize: file.size,
        duration: Date.now() - transferState.startTime
      };
      
      this._emit('complete', result);
      
      logger.log(`[TransferOrchestrator] Send transfer complete: ${transferId}`);
      
      return transferId;
      
    } catch (err) {
      logger.error('[TransferOrchestrator] Send transfer failed:', err);
      this._updateStatus(this.currentTransfer, TransferStatus.FAILED);
      this._emit('error', new TransferError('Send transfer failed', { cause: err }));
      throw err;
    }
  }

  /**
   * Start receiving a file
   * 
   * @param {string} transferId - Transfer ID from sender
   * @param {Object} fileMetadata - File metadata from sender
   * @param {string} peerId - Sender peer ID
   * @returns {Promise<string>} Transfer ID
   */
  async startReceiving(transferId, fileMetadata, peerId) {
    try {
      this._updateStatus(null, TransferStatus.INITIALIZING);
      
      // Initialize reception
      await initializeFileReception(transferId, fileMetadata, peerId);
      
      logger.log(`[TransferOrchestrator] Initialized receive transfer: ${transferId}`);
      
      // Track transfer state
      const transferState = {
        transferId,
        direction: TransferDirection.RECEIVING,
        status: TransferStatus.INITIALIZING,
        fileMetadata,
        peerId,
        startTime: Date.now()
      };
      
      this.activeTransfers.set(transferId, transferState);
      this.currentTransfer = transferId;
      
      this._emit('initialized', {
        transferId,
        direction: TransferDirection.RECEIVING,
        fileName: fileMetadata.name,
        fileSize: fileMetadata.size,
        peerId
      });
      
      // Subscribe to progress updates
      const unsubscribe = progressTracker.subscribe(transferId, (progress) => {
        this._emit('progress', progress);
      });
      
      transferState.unsubscribeProgress = unsubscribe;
      
      this._updateStatus(transferId, TransferStatus.ACTIVE);
      this._emit('started', transferId);
      
      logger.log(`[TransferOrchestrator] Receive transfer started: ${transferId}`);
      
      return transferId;
      
    } catch (err) {
      logger.error('[TransferOrchestrator] Receive transfer failed:', err);
      this._updateStatus(this.currentTransfer, TransferStatus.FAILED);
      this._emit('error', new TransferError('Receive transfer failed', { cause: err }));
      throw err;
    }
  }

  /**
   * Handle received chunk (called by message handler)
   * 
   * @param {string} transferId - Transfer ID
   * @param {Object} chunkMetadata - Chunk metadata
   * @param {ArrayBuffer} chunkData - Chunk binary data
   */
  async handleReceivedChunk(transferId, chunkMetadata, chunkData) {
    try {
      // Process the chunk directly (no base64 conversion needed)
      const result = await processReceivedChunk(transferId, chunkData, chunkMetadata);
      
      this._emit('chunkReceived', {
        transferId,
        chunkIndex: chunkMetadata.chunkIndex,
        size: chunkMetadata.size
      });
      
      // Check if transfer is complete
      if (chunkMetadata.isFinal) {
        const transferState = this.activeTransfers.get(transferId);
        this._updateStatus(transferId, TransferStatus.COMPLETED);
        
        const completionResult = {
          transferId,
          fileName: transferState.fileMetadata.name,
          fileSize: transferState.fileMetadata.size,
          duration: Date.now() - transferState.startTime
        };
        
        this._emit('complete', completionResult);
        
        logger.log(`[TransferOrchestrator] Receive transfer complete: ${transferId}`);
      }
      
      return result;
      
    } catch (err) {
      logger.error('[TransferOrchestrator] Failed to handle received chunk:', err);
      this._emit('error', new TransferError('Failed to process chunk', { 
        cause: err, 
        transferId, 
        chunkIndex: chunkMetadata.chunkIndex 
      }));
      throw err;
    }
  }

  /**
   * Pause a transfer
   * 
   * @param {string} transferId - Transfer ID (optional, uses current if not provided)
   * @returns {Promise<boolean>} Success status
   */
  async pause(transferId = this.currentTransfer) {
    if (!transferId) {
      throw new TransferError('No active transfer to pause');
    }
    
    try {
      const transferState = this.activeTransfers.get(transferId);
      
      if (!transferState) {
        throw new TransferError('Transfer not found', { transferId });
      }
      
      if (transferState.direction === TransferDirection.SENDING) {
        await pauseChunking(transferId);
      } else {
        // For receiving, just update state (sender will pause)
        await resumableTransferManager.pauseTransfer(transferId);
      }
      
      this._updateStatus(transferId, TransferStatus.PAUSED);
      this._emit('paused', transferId);
      
      logger.log(`[TransferOrchestrator] Paused transfer: ${transferId}`);
      
      return true;
      
    } catch (err) {
      logger.error('[TransferOrchestrator] Failed to pause transfer:', err);
      throw new TransferError('Pause failed', { cause: err, transferId });
    }
  }

  /**
   * Resume a paused transfer
   * 
   * @param {string} transferId - Transfer ID (optional, uses current if not provided)
   * @returns {Promise<boolean>} Success status
   */
  async resume(transferId = this.currentTransfer) {
    if (!transferId) {
      throw new TransferError('No paused transfer to resume');
    }
    
    try {
      const transferState = this.activeTransfers.get(transferId);
      
      if (!transferState) {
        throw new TransferError('Transfer not found', { transferId });
      }
      
      this._updateStatus(transferId, TransferStatus.RESUMING);
      
      if (transferState.direction === TransferDirection.SENDING) {
        await resumeChunking(transferId);
      } else {
        // For receiving, just update state (sender will resume)
        await resumableTransferManager.resumeTransfer(transferId);
      }
      
      this._updateStatus(transferId, TransferStatus.ACTIVE);
      this._emit('resumed', transferId);
      
      logger.log(`[TransferOrchestrator] Resumed transfer: ${transferId}`);
      
      return true;
      
    } catch (err) {
      logger.error('[TransferOrchestrator] Failed to resume transfer:', err);
      throw new TransferError('Resume failed', { cause: err, transferId });
    }
  }

  /**
   * Cancel a transfer
   * 
   * @param {string} transferId - Transfer ID (optional, uses current if not provided)
   * @param {boolean} cleanup - Whether to delete metadata
   * @returns {Promise<void>}
   */
  async cancel(transferId = this.currentTransfer, cleanup = false) {
    if (!transferId) {
      logger.warn('[TransferOrchestrator] No active transfer to cancel');
      return;
    }
    
    try {
      const transferState = this.activeTransfers.get(transferId);
      
      if (transferState?.unsubscribeProgress) {
        transferState.unsubscribeProgress();
      }
      
      await cleanupTransfer(transferId, cleanup);
      
      this.activeTransfers.delete(transferId);
      
      if (this.currentTransfer === transferId) {
        this.currentTransfer = null;
      }
      
      this._emit('cancelled', transferId);
      
      logger.log(`[TransferOrchestrator] Cancelled transfer: ${transferId}`);
      
    } catch (err) {
      logger.error('[TransferOrchestrator] Failed to cancel transfer:', err);
      throw new TransferError('Cancel failed', { cause: err, transferId });
    }
  }

  /**
   * Get transfer state and progress
   * 
   * @param {string} transferId - Transfer ID (optional, uses current if not provided)
   * @returns {Object|null} Transfer state and progress
   */
  getTransferState(transferId = this.currentTransfer) {
    if (!transferId) return null;
    
    const transferState = this.activeTransfers.get(transferId);
    if (!transferState) return null;
    
    const progress = progressTracker.getProgress(transferId);
    
    return {
      transferId,
      direction: transferState.direction,
      status: transferState.status,
      fileName: transferState.fileMetadata?.name || transferState.file?.name,
      fileSize: transferState.fileMetadata?.size || transferState.file?.size,
      peerId: transferState.peerId,
      startTime: transferState.startTime,
      progress
    };
  }

  /**
   * Get missing chunks for retransmission
   * 
   * @param {string} transferId - Transfer ID
   * @returns {number[]} Array of missing chunk indices
   */
  getMissingChunks(transferId) {
    return getMissingChunks(transferId);
  }

  /**
   * Update transfer status
   * @private
   */
  _updateStatus(transferId, status) {
    if (transferId) {
      const transferState = this.activeTransfers.get(transferId);
      if (transferState) {
        transferState.status = status;
      }
    }
  }

  /**
   * Convert ArrayBuffer to base64 (kept for compatibility if needed)
   * @private
   * @deprecated Use binary DataChannel transfer instead
   */
  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 to ArrayBuffer
   * @private
   */
  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Destroy service and cleanup all transfers
   */
  async destroy() {
    // Cancel all active transfers
    for (const transferId of this.activeTransfers.keys()) {
      await this.cancel(transferId, false);
    }
    
    this.activeTransfers.clear();
    this.eventListeners.clear();
    this.currentTransfer = null;
    
    logger.log('[TransferOrchestrator] Destroyed');
  }
}
