/**
 * File Receiver - Handles receiving large files with direct streaming disk writes
 * Supports chunk validation, missing chunk tracking, and resume capability
 * Writes chunks directly to disk in order for memory efficiency with large files
 * Supports pause/resume with progress synchronization
 */

import { saveChunkMeta, getChunksByTransfer } from './indexedDB.js';
import { 
  resumableTransferManager, 
  TransferState, 
  TransferRole 
} from './resumableTransfer.js';
import logger from './logger.js';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

export class FileReceiver {
  constructor() {
    this.activeTransfers = new Map(); // transferId -> transfer state
    this.pendingChunks = new Map(); // transferId -> Map of out-of-order chunks
    this.pauseControllers = new Map(); // transferId -> { isPaused, resumeResolve }
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
    this.onPauseStateChange = null;
    this.onRequestResync = null; // Callback to request sender to resync from a specific chunk
  }

  /**
   * Get the last received chunk index for a transfer (consecutive from start)
   * @param {string} transferId Transfer ID
   * @returns {number} Last consecutive chunk index (-1 if none)
   */
  getLastReceivedChunk(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return -1;
    
    // Find the highest consecutive chunk that was received
    let lastConsecutive = -1;
    for (let i = 0; i < state.totalChunks; i++) {
      if (state.receivedChunks.has(i)) {
        lastConsecutive = i;
      } else {
        break;
      }
    }
    return lastConsecutive;
  }

  /**
   * Pause receiving for a transfer
   * @param {string} transferId Transfer ID
   * @returns {Object} Pause info with lastChunk for sync
   */
  async pause(transferId) {
    const controller = this.pauseControllers.get(transferId);
    
    if (controller && !controller.isPaused) {
      controller.isPaused = true;
      await resumableTransferManager.pauseTransfer(transferId);
      
      const lastChunk = this.getLastReceivedChunk(transferId);
      
      if (this.onPauseStateChange) {
        this.onPauseStateChange(transferId, true, lastChunk);
      }
      
      logger.log(`[FileReceiver] Paused transfer: ${transferId} at chunk ${lastChunk}`);
      return { paused: true, lastChunk };
    }
    return { paused: false };
  }

  /**
   * Resume receiving for a transfer
   * @param {string} transferId Transfer ID
   * @returns {Object} Resume info with lastChunk for sync
   */
  async resume(transferId) {
    const controller = this.pauseControllers.get(transferId);
    
    if (controller && controller.isPaused) {
      controller.isPaused = false;
      if (controller.resumeResolve) {
        controller.resumeResolve();
        controller.resumeResolve = null;
      }
      await resumableTransferManager.resumeTransfer(transferId);
      resumableTransferManager.signalResume(transferId);
      
      const lastChunk = this.getLastReceivedChunk(transferId);
      
      if (this.onPauseStateChange) {
        this.onPauseStateChange(transferId, false, lastChunk);
      }
      
      logger.log(`[FileReceiver] Resumed transfer: ${transferId} from chunk ${lastChunk}`);
      return { resumed: true, lastChunk };
    }
    return { resumed: false };
  }

  /**
   * Check if transfer is paused
   */
  isPaused(transferId) {
    const controller = this.pauseControllers.get(transferId);
    return controller?.isPaused || false;
  }

  /**
   * Initialize a file receive operation
   */
  async initializeReceive(metadata) {
    const transferId = metadata.transferId || crypto.randomUUID();
    
    const state = {
      transferId,
      fileName: metadata.name,
      fileSize: metadata.size,
      mimeType: metadata.mimeType || 'application/octet-stream',
      totalChunks: Math.ceil(metadata.size / CHUNK_SIZE),
      receivedChunks: new Map(), // chunkIndex -> { validated, checksum }
      missingChunks: new Set(),
      bytesReceived: 0,
      bytesWritten: 0,
      fileHandle: null,
      writable: null,
      useFileSystemAPI: false,
      memoryChunks: [], // Fallback for browsers without File System API
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      nextExpectedChunk: 0, // Track next chunk to write sequentially
      isWriting: false, // Lock to prevent concurrent writes
    };

    this.activeTransfers.set(transferId, state);
    this.pendingChunks.set(transferId, new Map());
    
    // Initialize pause controller
    this.pauseControllers.set(transferId, {
      isPaused: false,
      resumeResolve: null
    });

    // Register with resumable transfer manager
    await resumableTransferManager.registerTransfer({
      transferId,
      role: TransferRole.RECEIVER,
      fileName: metadata.name,
      fileSize: metadata.size,
      totalChunks: state.totalChunks,
      peerId: metadata.peerId || null
    });
    
    return { transferId, state };
  }

  /**
   * Setup file writer with streaming support - MUST be called from user gesture
   */
  async setupFileWriter(transferId, suggestedName) {
    const state = this.activeTransfers.get(transferId);
    if (!state) throw new Error('Transfer not found');

    if (window.showSaveFilePicker) {
      try {
        // Helper to format filename with counter before extension
        // This ensures files are saved as "name(1).jpg" instead of "name.jpg (1)"
        const formatSuggestedName = (filename) => {
          // Extract name and extension
          const lastDot = filename.lastIndexOf('.');
          if (lastDot === -1 || lastDot === 0) {
            // No extension or hidden file
            return filename;
          }
          // Return as-is, the browser will handle numbering correctly
          // Different browsers handle this differently, so we just provide clean name
          return filename;
        };
        
        const handle = await window.showSaveFilePicker({
          suggestedName: formatSuggestedName(suggestedName || state.fileName),
          types: [{
            description: 'All Files',
            accept: { '*/*': [] }
          }]
        });
        
        state.fileHandle = handle;
        state.useFileSystemAPI = true;
        
        // Create writable stream - use keepExistingData: false for clean start
        state.writable = await handle.createWritable({ keepExistingData: false });
        
        logger.log(`[FileReceiver] File System API ready (direct write mode)`);
        return { success: true, method: 'filesystem-direct' };
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error('File save cancelled by user');
        }
        logger.warn('[FileReceiver] File System API failed:', err);
      }
    }

    // Fallback to in-memory
    state.useFileSystemAPI = false;
    state.memoryChunks = new Array(state.totalChunks).fill(null);
    logger.log('[FileReceiver] Using in-memory fallback');
    return { success: true, method: 'memory' };
  }

  /**
   * Wait if paused, returns true if should continue
   */
  async _waitIfPaused(transferId) {
    const controller = this.pauseControllers.get(transferId);
    if (!controller) return true;

    while (controller.isPaused) {
      await new Promise(resolve => {
        controller.resumeResolve = resolve;
      });
    }

    const transferState = await resumableTransferManager.getTransferState(transferId);
    return transferState?.status !== TransferState.CANCELLED;
  }

  /**
   * Process the write queue - writes chunks sequentially in order
   * Uses simple sequential writes (no position) to avoid File System API state issues
   */
  async _processWriteQueue(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state || !state.writable) return;
    if (state.isWriting) return; // Already processing
    
    state.isWriting = true;
    const pendingMap = this.pendingChunks.get(transferId);
    
    try {
      // Write chunks in order starting from nextExpectedChunk
      while (pendingMap.has(state.nextExpectedChunk)) {
        // Check if writable stream is still open before writing
        // This prevents "Cannot write to a closing writable stream" errors
        if (!state.writable) {
          logger.warn(`[FileReceiver] Writable stream closed, stopping write queue`);
          break;
        }
        
        const chunkIndex = state.nextExpectedChunk;
        const chunkData = pendingMap.get(chunkIndex);
        pendingMap.delete(chunkIndex);
        
        // Simple sequential write - just append data, no position needed
        // This avoids the "state cached in interface object" error
        await state.writable.write(chunkData);
        state.bytesWritten += chunkData.byteLength;
        state.nextExpectedChunk++;
        
        logger.log(`[FileReceiver] Wrote chunk ${chunkIndex} (${chunkData.byteLength} bytes), total written: ${state.bytesWritten}`);
      }
    } catch (err) {
      // Check if error is about closing stream - log as warning, not error
      if (err.message?.includes('closing writable stream')) {
        logger.warn(`[FileReceiver] Stream was closing during write, chunks may have been processed already`);
      } else {
        logger.error(`[FileReceiver] Write error:`, err);
        throw err;
      }
    } finally {
      state.isWriting = false;
    }
  }

  /**
   * Queue a chunk for writing - stores in pending map and triggers sequential write
   */
  async _queueChunkForWrite(transferId, chunkIndex, chunkData) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;
    
    // Don't queue if writable stream is closing or closed
    if (!state.writable) {
      logger.warn(`[FileReceiver] Writable stream not available, skipping chunk ${chunkIndex}`);
      return;
    }
    
    const pendingMap = this.pendingChunks.get(transferId);
    
    // Store chunk in pending map (make a copy to avoid buffer reuse issues)
    pendingMap.set(chunkIndex, new Uint8Array(chunkData));
    
    // Try to write any sequential chunks
    await this._processWriteQueue(transferId);
  }

  /**
   * Receive and process a chunk
   */
  async receiveChunk(transferId, chunkMeta, chunkData) {
    const state = this.activeTransfers.get(transferId);
    if (!state) {
      logger.error('[FileReceiver] Transfer not found:', transferId);
      return { success: false, error: 'Transfer not found' };
    }

    // Check for pause - wait if paused
    const shouldContinue = await this._waitIfPaused(transferId);
    if (!shouldContinue) {
      return { success: false, error: 'Transfer cancelled' };
    }

    const { chunkIndex, checksum, size, fileOffset, isFinal } = chunkMeta;

    // Check if chunk was already received (avoid duplicates)
    if (state.receivedChunks.has(chunkIndex)) {
      logger.log(`[FileReceiver] Chunk ${chunkIndex} already received, skipping`);
      return { success: true, chunkIndex, duplicate: true };
    }

    try {
      // Validate checksum
      const calculatedChecksum = await this.calculateChecksum(chunkData);
      const isValid = calculatedChecksum === checksum;

      if (!isValid) {
        logger.error(`[FileReceiver] Checksum mismatch for chunk ${chunkIndex}`);
        state.missingChunks.add(chunkIndex);
        
        await saveChunkMeta({
          transferId,
          chunkIndex,
          size,
          checksum,
          fileOffset,
          status: 'failed',
          validated: false,
          timestamp: Date.now(),
        });
        
        return { success: false, error: 'Checksum mismatch', chunkIndex };
      }

      // Mark as received BEFORE writing (so we track it even if write is pending)
      state.receivedChunks.set(chunkIndex, { validated: true, checksum });
      state.bytesReceived += chunkData.byteLength;
      state.lastChunkTime = Date.now();
      state.missingChunks.delete(chunkIndex);

      // Write chunk to file
      if (state.useFileSystemAPI && state.writable) {
        // Queue for sequential disk write
        await this._queueChunkForWrite(transferId, chunkIndex, chunkData);
      } else if (state.memoryChunks) {
        // Store in memory array at correct position
        state.memoryChunks[chunkIndex] = new Uint8Array(chunkData);
      }

      // Store validated chunk metadata
      await saveChunkMeta({
        transferId,
        chunkIndex,
        size,
        checksum,
        fileOffset,
        status: 'received',
        validated: true,
        timestamp: Date.now(),
      });

      // Update resumable transfer progress (ignore errors if transfer already cleaned up)
      try {
        await resumableTransferManager.updateProgress(transferId, {
          chunkIndex,
          bytesProcessed: state.bytesReceived
        });
      } catch (err) {
        // Ignore "transfer not found" errors - happens when transfer completes before last chunk finishes processing
        if (!err.message.includes('transfer not found')) {
          throw err;
        }
      }

      // Calculate progress
      const progress = Math.round((state.bytesReceived / state.fileSize) * 100);
      const elapsed = (Date.now() - state.startTime) / 1000;
      const speed = state.bytesReceived / elapsed;
      const remaining = state.fileSize - state.bytesReceived;
      const eta = speed > 0 ? remaining / speed : null;

      if (this.onProgress) {
        this.onProgress(transferId, {
          progress,
          bytesReceived: state.bytesReceived,
          totalBytes: state.fileSize,
          chunksReceived: state.receivedChunks.size,
          totalChunks: state.totalChunks,
          speed,
          eta,
          isPaused: this.isPaused(transferId),
        });
      }

      return { success: true, chunkIndex, progress };
    } catch (err) {
      // Log error unless it's "transfer not found" (happens during cleanup phase)
      if (!err.message || !err.message.includes('transfer not found')) {
        logger.error('[FileReceiver] Chunk receive error:', err);
      }
      state.missingChunks.add(chunkIndex);
      return { success: false, error: err.message, chunkIndex };
    }
  }

  /**
   * Complete the transfer - finalize file and cleanup
   */
  async completeTransfer(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) {
      return { success: false, error: 'Transfer not found' };
    }

    try {
      // Check for missing chunks first
      const missingChunks = this.getMissingChunks(transferId);
      if (missingChunks.length > 0) {
        logger.warn(`[FileReceiver] Transfer has ${missingChunks.length} missing chunks: ${missingChunks.slice(0, 10).join(', ')}...`);
        return { 
          success: false, 
          error: 'Missing chunks', 
          missingChunks,
          canResume: true 
        };
      }

      if (state.useFileSystemAPI && state.writable) {
        const pendingMap = this.pendingChunks.get(transferId);
        
        // Keep processing write queue until ALL pending chunks are written
        let maxAttempts = 100; // Prevent infinite loop
        let attempt = 0;
        
        while (pendingMap && pendingMap.size > 0 && attempt < maxAttempts) {
          const pendingCount = pendingMap.size;
          logger.log(`[FileReceiver] Processing ${pendingCount} pending chunks (attempt ${attempt + 1})...`);
          
          // Process the write queue
          await this._processWriteQueue(transferId);
          
          // Give time for chunks to be processed
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Check if we made progress
          if (pendingMap.size === pendingCount) {
            // No progress made - chunks might be out of order
            logger.warn(`[FileReceiver] No progress on pending chunks, waiting for sequential chunks...`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          
          attempt++;
        }
        
        if (pendingMap && pendingMap.size > 0) {
          logger.warn(`[FileReceiver] ${pendingMap.size} chunks still pending after ${attempt} attempts`);
          // These are likely out-of-order chunks waiting for earlier chunks
          // Don't close the stream yet - wait for retransmission
          return { 
            success: false, 
            error: `${pendingMap.size} chunks pending write`,
            pendingChunks: Array.from(pendingMap.keys()),
            canRetry: true 
          };
        }
        
        // Final verification
        if (state.bytesWritten !== state.fileSize) {
          logger.warn(`[FileReceiver] Bytes mismatch: written=${state.bytesWritten}, expected=${state.fileSize}`);
          // Check what chunks are actually missing vs just not written yet
          const missing = this.getMissingChunks(transferId);
          if (missing.length > 0) {
            return { 
              success: false, 
              error: 'Missing chunks', 
              missingChunks: missing,
              canResume: true 
            };
          }
        }
        
        // All chunks written successfully - close the stream
        logger.log(`[FileReceiver] All chunks written, closing stream (${state.bytesWritten} bytes)...`);
        await state.writable.close();
        state.writable = null;
        
        logger.log(`[FileReceiver] File saved successfully (${state.bytesWritten} bytes)`);
        
        if (this.onComplete) {
          this.onComplete(transferId, {
            fileName: state.fileName,
            fileSize: state.bytesWritten,
            savedToFileSystem: true,
            duration: Date.now() - state.startTime,
          });
        }
        
        return { success: true, savedToFileSystem: true };
      } else {
        // Combine memory chunks into blob
        const validChunks = state.memoryChunks.filter(c => c !== null);
        const blob = new Blob(validChunks, { type: state.mimeType });
        const url = URL.createObjectURL(blob);
        
        if (this.onComplete) {
          this.onComplete(transferId, {
            fileName: state.fileName,
            fileSize: blob.size,
            savedToFileSystem: false,
            url,
            blob,
            duration: Date.now() - state.startTime,
          });
        }
        
        return { success: true, savedToFileSystem: false, url, blob };
      }
    } catch (err) {
      logger.error('[FileReceiver] Complete transfer error:', err);
      return { success: false, error: err.message };
    } finally {
      // Only cleanup if transfer actually completed successfully
      // If there are missing chunks, keep state active for retransmission
      const state = this.activeTransfers.get(transferId);
      if (state && state.receivedChunks.size === state.totalChunks) {
        // All chunks received, safe to cleanup
        this.activeTransfers.delete(transferId);
        this.pendingChunks.delete(transferId);
        this.pauseControllers.delete(transferId);
      }
      // If chunks are missing, state stays active for retransmission
    }
  }

  /**
   * Get list of missing chunk indices
   */
  getMissingChunks(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return [];

    const missing = [];
    for (let i = 0; i < state.totalChunks; i++) {
      if (!state.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  /**
   * Calculate SHA-256 checksum
   */
  async calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Cancel a transfer
   */
  async cancelTransfer(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;

    try {
      if (state.writable) {
        await state.writable.abort();
      }
    } catch (err) {
      logger.error('[FileReceiver] Cancel error:', err);
    }

    await resumableTransferManager.cancelTransfer(transferId);

    this.activeTransfers.delete(transferId);
    this.pendingChunks.delete(transferId);
    this.pauseControllers.delete(transferId);
  }

  /**
   * Get transfer state with pause info
   */
  getTransferState(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return null;
    
    return {
      ...state,
      isPaused: this.isPaused(transferId),
      lastReceivedChunk: this.getLastReceivedChunk(transferId),
    };
  }

  /**
   * Get pause state with sync info
   */
  getPauseState(transferId) {
    const state = this.activeTransfers.get(transferId);
    const controller = this.pauseControllers.get(transferId);
    
    return {
      isPaused: controller?.isPaused || false,
      bytesReceived: state?.bytesReceived || 0,
      chunksReceived: state?.receivedChunks?.size || 0,
      totalChunks: state?.totalChunks || 0,
      fileSize: state?.fileSize || 0,
      lastReceivedChunk: this.getLastReceivedChunk(transferId),
    };
  }

  /**
   * Force cleanup of transfer state (for explicit cleanup after retransmission)
   */
  forceCleanup(transferId) {
    this.activeTransfers.delete(transferId);
    this.pendingChunks.delete(transferId);
    this.pauseControllers.delete(transferId);
    logger.log(`[FileReceiver] Force cleanup completed for transfer: ${transferId}`);
  }

  /**
   * Resume a previously started transfer
   */
  async resumeTransfer(transferId) {
    const existingChunks = await getChunksByTransfer(transferId);
    const validatedChunks = existingChunks.filter(c => c.validated && c.status === 'received');
    
    const state = this.activeTransfers.get(transferId);
    if (!state) return null;

    for (const chunk of validatedChunks) {
      state.receivedChunks.set(chunk.chunkIndex, {
        validated: true,
        checksum: chunk.checksum,
      });
      state.bytesReceived += chunk.size;
    }

    // Update nextExpectedChunk based on what we have
    state.nextExpectedChunk = 0;
    while (state.receivedChunks.has(state.nextExpectedChunk)) {
      state.nextExpectedChunk++;
    }

    const missingChunks = this.getMissingChunks(transferId);
    return {
      resumedChunks: validatedChunks.length,
      missingChunks,
      bytesReceived: state.bytesReceived,
      lastReceivedChunk: this.getLastReceivedChunk(transferId),
    };
  }
}

// Singleton instance
export const fileReceiver = new FileReceiver();
