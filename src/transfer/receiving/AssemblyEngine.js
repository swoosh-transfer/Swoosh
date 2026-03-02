/**
 * Assembly Engine (Receiver Side)
 * 
 * Receives chunks, validates checksums, buffers to storage size,
 * and writes to file using File System Access API.
 * 
 * Complements ChunkingEngine on the receiver side.
 * 
 * Two-step initialization:
 *   1. initializeReceive(metadata)  — set up state, progress, validator (no user prompt)
 *   2. setupFileWriter(transferId, fileName) — prompt user for save location
 */

import { initFileWriter, writeChunk as writeFileChunk, completeWriter, cancelWriter } from '../../infrastructure/storage/FileWriter.js';
import logger from '../../utils/logger.js';
import { progressTracker } from '../shared/ProgressTracker.js';
import { chunkValidator } from './ChunkValidator.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { ValidationError } from '../../lib/errors.js';
import { createBitmap, markChunk, serializeBitmap, deserializeBitmap, getCompletedCount } from '../../infrastructure/database/chunkBitmap.js';
import { updateTransfer, saveTransfer } from '../../infrastructure/database/transfers.repository.js';

export class AssemblyEngine {
  constructor() {
    this.activeAssemblies = new Map(); // transferId -> assembly state
    this.receiveBuffers = new Map(); // transferId -> receive buffer
    this.fileWriters = new Map(); // transferId -> FileWriter instance
    this.chunkBitmaps = new Map(); // transferId -> Uint8Array bitmap
    this.lastFlushCount = new Map(); // transferId -> last chunk count when bitmap was flushed
    this.pendingAcks = new Map(); // transferId -> array of chunk indices to acknowledge

    // Event callbacks (set by consumer)
    this.onComplete = null; // (transferId, result) => void
    this.onError = null;    // (transferId, error) => void
    this.onChunkReceived = null; // (transferId, chunkIndices, totalChunks) => void - for sending ACKs to sender
    
    // Bitmap persistence settings
    this.BITMAP_FLUSH_INTERVAL = 50; // Flush bitmap every 50 chunks
    this.ACK_BATCH_SIZE = 10; // Send ACK every 10 chunks received
  }

  /**
   * Step 1: Initialize receive state (no user prompt).
   * Called when file-metadata arrives from sender.
   * 
   * @param {Object} metadata
   * @param {string} metadata.transferId
   * @param {string} metadata.name
   * @param {number} metadata.size
   * @param {string} [metadata.mimeType]
   * @param {number} [metadata.totalChunks]
   */
  async initializeReceive({ transferId, name, size, mimeType, totalChunks: providedTotalChunks }) {
    const totalChunks = providedTotalChunks || Math.ceil(size / STORAGE_CHUNK_SIZE);

    // Initialize progress tracking
    progressTracker.initialize(transferId, {
      totalChunks,
      fileSize: size,
      fileName: name,
      direction: 'receiving',
    });

    // Initialize chunk validator
    chunkValidator.initialize(transferId, totalChunks);

    // Initialize chunk bitmap for resume capability
    const chunkBitmap = createBitmap(totalChunks);
    this.chunkBitmaps.set(transferId, chunkBitmap);
    this.lastFlushCount.set(transferId, 0);

    // Initialize assembly state (file writer comes later in step 2)
    this.activeAssemblies.set(transferId, {
      fileMetadata: { name, size, mimeType },
      receivedChunks: 0,
      totalChunks,
      bytesReceived: 0,
      isComplete: false,
    });

    // Initialize receive buffer
    this.receiveBuffers.set(transferId, {
      buffer: new Uint8Array(STORAGE_CHUNK_SIZE),
      currentSize: 0,
      expectedSize: STORAGE_CHUNK_SIZE,
    });

    // Save initial transfer metadata to IndexedDB (for resume support)
    try {
      await saveTransfer({
        transferId,
        fileName: name,
        fileSize: size,
        mimeType,
        totalChunks,
        direction: 'receiving',
        status: 'active',
        chunkBitmap: serializeBitmap(chunkBitmap),
        lastProgress: 0,
        lastChunkIndex: -1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      logger.log(`[AssemblyEngine] Transfer metadata saved to IndexedDB for ${transferId}`);
    } catch (error) {
      logger.warn(`[AssemblyEngine] Failed to save transfer metadata:`, error);
      // Continue even if IndexedDB save fails (non-critical for active transfer)
    }

    logger.log(`[AssemblyEngine] Initialized receive for ${transferId}: ${totalChunks} chunks expected`);
    return { transferId, totalChunks, fileName: name, fileSize: size };
  }

  /**
   * Step 2: Prompt user for save location and set up file writer.
   * Called when user clicks "Select save location".
   * 
   * @param {string} transferId
   * @param {string} fileName
   * @returns {Promise<Object>} Writer info including method used
   */
  async setupFileWriter(transferId, fileName) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new ValidationError(
        `No assembly initialized for transfer ${transferId}`,
        { transferId }
      );
    }

    const writerInfo = await initFileWriter(transferId, fileName, assemblyState.fileMetadata.size);
    this.fileWriters.set(transferId, { transferId, ...writerInfo });

    logger.log(`[AssemblyEngine] File writer ready for ${transferId}`);
    return { ...writerInfo, method: 'file-system-access' };
  }

  /**
   * Legacy one-step init (combines initializeReceive + setupFileWriter).
   * Kept for multi-file path and resume.
   */
  async initializeAssembly(transferId, fileMetadata, peerId) {
    await this.initializeReceive({
      transferId,
      name: fileMetadata.name,
      size: fileMetadata.size,
      mimeType: fileMetadata.type,
    });

    const writerInfo = await this.setupFileWriter(transferId, fileMetadata.name);

    logger.log(`[AssemblyEngine] Full assembly initialized for ${transferId}`);
    return writerInfo;
  }

  /**
   * Receive and process a chunk
   */
  async receiveChunk(transferId, chunkData, chunkMetadata) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new ValidationError(
        `No assembly initialized for transfer ${transferId}`,
        { transferId }
      );
    }

    // Validate the chunk
    const validationResult = chunkValidator.validate(
      transferId, 
      {
        index: chunkMetadata.chunkIndex,
        data: chunkData,
        size: chunkMetadata.size,
        checksum: chunkMetadata.checksum
      },
      assemblyState.totalChunks
    );

    // Skip if duplicate
    if (validationResult.duplicate) {
      logger.log(`[AssemblyEngine] Skipping duplicate chunk ${chunkMetadata.chunkIndex}`);
      return { duplicate: true, chunkIndex: chunkMetadata.chunkIndex };
    }

    // Append to receive buffer and process
    await this._appendToReceiveBuffer(transferId, chunkData, chunkMetadata);

    return {
      success: true,
      chunkIndex: chunkMetadata.chunkIndex,
      ...validationResult
    };
  }

  /**
   * Append to receive buffer and process when complete
   * @private
   */
  async _appendToReceiveBuffer(transferId, chunkData, chunkMetadata) {
    const bufferState = this.receiveBuffers.get(transferId);
    const assemblyState = this.activeAssemblies.get(transferId);

    // Convert to Uint8Array if needed
    const data = chunkData instanceof Uint8Array ? chunkData : new Uint8Array(chunkData);

    // Validate buffer capacity
    if (bufferState.currentSize + data.length > STORAGE_CHUNK_SIZE) {
      throw new ValidationError(
        `Chunk data exceeds storage buffer capacity`,
        { transferId, currentSize: bufferState.currentSize, dataLength: data.length }
      );
    }

    // Append chunk data to buffer
    bufferState.buffer.set(data, bufferState.currentSize);
    bufferState.currentSize += data.length;

    // Check if storage chunk is complete
    const isComplete = chunkMetadata.isFinal || 
                      bufferState.currentSize >= STORAGE_CHUNK_SIZE ||
                      bufferState.currentSize >= bufferState.expectedSize;

    if (isComplete) {
      // Get actual data from buffer
      const actualData = bufferState.buffer.slice(0, bufferState.currentSize);

      // Calculate and validate checksum
      const calculatedChecksum = await this._calculateChecksum(actualData);
      if (calculatedChecksum !== chunkMetadata.checksum) {
        throw new ValidationError(
          `Checksum validation failed for chunk ${chunkMetadata.chunkIndex}`,
          { transferId, chunkIndex: chunkMetadata.chunkIndex, expected: chunkMetadata.checksum, actual: calculatedChecksum }
        );
      }

      // Write to file using functional FileWriter API (handles sequential writing and queuing)
      await writeFileChunk(transferId, chunkMetadata.chunkIndex, actualData);

      // Update progress
      assemblyState.bytesReceived += bufferState.currentSize;
      assemblyState.receivedChunks++;
      
      // Mark chunk as complete in bitmap
      const bitmap = this.chunkBitmaps.get(transferId);
      if (bitmap) {
        markChunk(bitmap, chunkMetadata.chunkIndex);
        
        // Add chunk to pending ACKs for sender-side tracking
        if (!this.pendingAcks.has(transferId)) {
          this.pendingAcks.set(transferId, []);
        }
        this.pendingAcks.get(transferId).push(chunkMetadata.chunkIndex);
        
        // Periodically send ACKs to sender (every N chunks)
        if (this.pendingAcks.get(transferId).length >= this.ACK_BATCH_SIZE) {
          this._sendChunkAcknowledgments(transferId);
        }
        
        // Periodically flush bitmap to IndexedDB (every N chunks)
        const lastFlush = this.lastFlushCount.get(transferId) || 0;
        if (assemblyState.receivedChunks - lastFlush >= this.BITMAP_FLUSH_INTERVAL) {
          await this._flushBitmap(transferId);
        }
      }
      
      // Update progress tracker (canonical progress — bitmap tracking is handled by useTransferTracking)
      progressTracker.updateChunk(transferId, chunkMetadata.chunkIndex, bufferState.currentSize);

      // Reset buffer
      bufferState.currentSize = 0;

      // Check if file transfer is complete
      if (chunkMetadata.isFinal) {
        await this._completeAssembly(transferId);
      }
    }
  }

  /**
   * Calculate SHA-256 checksum
   * @private
   */
  async _calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Flush bitmap to IndexedDB
   * Persists current chunk completion state for resume capability
   * @private
   */
  async _flushBitmap(transferId) {
    const bitmap = this.chunkBitmaps.get(transferId);
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!bitmap || !assemblyState) return;

    try {
      const serialized = serializeBitmap(bitmap);
      const completedCount = getCompletedCount(bitmap);
      const progress = (completedCount / assemblyState.totalChunks) * 100;

      await updateTransfer(transferId, {
        chunkBitmap: serialized,
        lastProgress: progress,
        lastChunkIndex: assemblyState.receivedChunks - 1,
        status: 'active',
      });

      this.lastFlushCount.set(transferId, assemblyState.receivedChunks);
      logger.log(`[AssemblyEngine] Bitmap flushed for ${transferId}: ${completedCount}/${assemblyState.totalChunks} chunks (${progress.toFixed(1)}%)`);
    } catch (error) {
      logger.warn(`[AssemblyEngine] Failed to flush bitmap for ${transferId}:`, error);
      // Non-critical - continue transfer
    }
  }

  /**
   * Send chunk acknowledgments to sender for sender-side tracking
   * Batches ACKs to avoid excessive messaging
   * @private
   */
  _sendChunkAcknowledgments(transferId) {
    const pendingAcks = this.pendingAcks.get(transferId);
    const assemblyState = this.activeAssemblies.get(transferId);
    
    if (!pendingAcks || pendingAcks.length === 0 || !assemblyState) {
      return;
    }

    // Send ACKs via callback if registered
    if (this.onChunkReceived) {
      try {
        this.onChunkReceived(transferId, [...pendingAcks], assemblyState.totalChunks);
        logger.log(`[AssemblyEngine] Sent ${pendingAcks.length} chunk ACKs for ${transferId}`);
      } catch (error) {
        logger.warn(`[AssemblyEngine] Failed to send chunk ACKs:`, error);
      }
    }

    // Clear pending ACKs after sending
    this.pendingAcks.set(transferId, []);
  }

  /**
   * Complete file assembly
   * @private
   */
  async _completeAssembly(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    
    // Send any remaining chunk ACKs before completing
    this._sendChunkAcknowledgments(transferId);
    
    // Flush final bitmap state to IndexedDB
    await this._flushBitmap(transferId);
    
    // Complete the file writing using functional API
    const result = await completeWriter(transferId);
    
    // Update progress tracker
    progressTracker.updateStatus(transferId, 'completed');
    
    // Update transfer status in IndexedDB
    try {
      await updateTransfer(transferId, {
        status: 'completed',
        completedAt: Date.now(),
        lastProgress: 100,
      });
    } catch (error) {
      logger.warn(`[AssemblyEngine] Failed to update transfer status:`, error);
    }
    
    // Mark as complete
    assemblyState.isComplete = true;

    logger.log(`[AssemblyEngine] File assembly complete: ${result.fileSize} bytes received`);

    // Notify consumer
    if (this.onComplete) this.onComplete(transferId, result);

    return result;
  }

  /**
   * Get assembly progress
   */
  getProgress(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) return null;

    return {
      bytesReceived: assemblyState.bytesReceived,
      totalBytes: assemblyState.fileMetadata.size,
      chunksReceived: assemblyState.receivedChunks,
      totalChunks: assemblyState.totalChunks,
      isComplete: assemblyState.isComplete,
      percentage: (assemblyState.receivedChunks / assemblyState.totalChunks) * 100
    };
  }

  /**
   * Resume assembly from existing chunks
   */
  async resumeAssembly(transferId, completedChunkIndices) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new Error(`No assembly state found for transfer ${transferId}`);
    }

    // Mark chunks as already received
    chunkValidator.markReceived(transferId, completedChunkIndices);
    
    // Update assembly state
    assemblyState.receivedChunks = completedChunkIndices.length;
    assemblyState.bytesReceived = completedChunkIndices.length * STORAGE_CHUNK_SIZE;

    logger.log(`[AssemblyEngine] Resumed assembly for ${transferId}: ${completedChunkIndices.length} chunks already received`);
    
    return {
      transferId,
      resumedChunks: completedChunkIndices.length,
      totalChunks: assemblyState.totalChunks,
      remainingChunks: assemblyState.totalChunks - completedChunkIndices.length
    };
  }

  /**
   * Pause receiving for a transfer.
   * Sets a paused flag so incoming chunks can be deferred.
   * Flushes bitmap to IndexedDB for resume capability.
   * 
   * @param {string} transferId
   */
  async pause(transferId) {
    if (!transferId) {
      logger.warn(`[AssemblyEngine] pause: invalid transferId (undefined/null)`);
      return;
    }

    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      // Assembly doesn't exist — might be paused already or never started on this side
      // Still update IndexedDB status if possible
      logger.warn(`[AssemblyEngine] pause: no active assembly for ${transferId} (may be paused already)`);
      try {
        await updateTransfer(transferId, {
          status: 'paused',
          pausedAt: Date.now(),
        });
      } catch (error) {
        logger.warn(`[AssemblyEngine] Could not update transfer to paused:`, error);
      }
      return;
    }
    
    // Flush bitmap to IndexedDB before pausing
    await this._flushBitmap(transferId);
    
    // Update transfer status
    try {
      await updateTransfer(transferId, {
        status: 'paused',
        pausedAt: Date.now(),
      });
    } catch (error) {
      logger.warn(`[AssemblyEngine] Failed to update pause status:`, error);
    }
    
    assemblyState.paused = true;
    logger.log(`[AssemblyEngine] Paused receiving for ${transferId}`);
  }

  /**
   * Resume receiving for a transfer.
   * 
   * @param {string} transferId
   */
  async resume(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      logger.warn(`[AssemblyEngine] resume: no assembly for ${transferId}`);
      return;
    }
    
    // Update transfer status
    try {
      await updateTransfer(transferId, {
        status: 'active',
        resumedAt: Date.now(),
      });
    } catch (error) {
      logger.warn(`[AssemblyEngine] Failed to update resume status:`, error);
    }
    
    assemblyState.paused = false;
    logger.log(`[AssemblyEngine] Resumed receiving for ${transferId}`);
  }

  /**
   * Cancel a transfer and clean up all state.
   * Alias for cleanup().
   * 
   * @param {string} transferId
   */
  async cancelTransfer(transferId) {
    logger.log(`[AssemblyEngine] Cancelling transfer ${transferId}`);
    return this.cleanup(transferId);
  }

  /**
   * Get missing chunks for retransmission
   */
  getMissingChunks(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) return [];

    return chunkValidator.getMissingChunks(transferId, assemblyState.totalChunks);
  }

  /**
   * Cleanup assembly state
   */
  async cleanup(transferId) {
    // Flush final bitmap state before cleanup
    await this._flushBitmap(transferId);
    
    try {
      await cancelWriter(transferId);
    } catch (err) {
      logger.warn(`[AssemblyEngine] Error cleaning up file writer for ${transferId}:`, err);
    }
    
    this.activeAssemblies.delete(transferId);
    this.receiveBuffers.delete(transferId);
    this.fileWriters.delete(transferId);
    this.chunkBitmaps.delete(transferId);
    this.lastFlushCount.delete(transferId);
    chunkValidator.clear(transferId);
    progressTracker.clear(transferId);
    
    logger.log(`[AssemblyEngine] Cleaned up assembly state for ${transferId}`);
  }
}

// Export singleton instance
export const assemblyEngine = new AssemblyEngine();
