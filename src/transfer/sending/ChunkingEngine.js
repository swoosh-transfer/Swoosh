/**
 * Chunking Engine (Sender Side)
 * 
 * Reads files in network-sized chunks (16KB), buffers to storage size (64KB),
 * calculates checksums, and sends to receiver.
 * 
 * Supports pause/resume and adaptive chunking.
 */

import { createFileMetadata, saveFileMetadata, createTransferRecord } from '../metadata/fileMetadata.js';
import { resumableTransferManager, TransferState, TransferRole } from '../resumption/ResumableTransferManager.js';
import logger from '../../utils/logger.js';
import { progressTracker } from '../shared/ProgressTracker.js';
import { 
  NETWORK_CHUNK_SIZE, 
  STORAGE_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  SPEED_HIGH_THRESHOLD,
  SPEED_LOW_THRESHOLD,
  SPEED_ADJUSTMENT_INCREMENT
} from '../../constants/transfer.constants.js';
import { createBitmap, markChunk, serializeBitmap, deserializeBitmap, getCompletedCount } from '../../infrastructure/database/chunkBitmap.js';
import { updateTransfer, saveTransfer } from '../../infrastructure/database/transfers.repository.js';

export class ChunkingEngine {
  constructor() {
    this.activeChunkings = new Map(); // transferId -> chunking state
    this.storageBuffers = new Map(); // transferId -> storage buffer
    this.chunkSizes = new Map(); // transferId -> current chunk size (per-transfer)
    this.performanceMetrics = new Map(); // transferId -> metrics
    this.pauseControllers = new Map(); // transferId -> { isPaused, resumeResolve }
    this.fileReaders = new Map(); // transferId -> reader (for resume)
    this.chunkBitmaps = new Map(); // transferId -> Uint8Array bitmap (tracks sent chunks)
    this.lastFlushCount = new Map(); // transferId -> last chunk count when bitmap was flushed
    
    // Bitmap persistence settings
    this.BITMAP_FLUSH_INTERVAL = 50; // Flush bitmap every 50 chunks
  }

  /**
   * Pause a chunking operation
   */
  async pause(transferId) {
    const controller = this.pauseControllers.get(transferId);
    if (controller && !controller.isPaused) {
      controller.isPaused = true;
      
      // Flush bitmap to IndexedDB before pausing
      await this._flushBitmap(transferId);
      
      await resumableTransferManager.pauseTransfer(transferId);
      
      // Update transfer status
      try {
        await updateTransfer(transferId, {
          status: 'paused',
          pausedAt: Date.now(),
        });
      } catch (error) {
        logger.warn(`[ChunkingEngine] Failed to update pause status:`, error);
      }
      
      progressTracker.updateStatus(transferId, 'paused');
      logger.log(`[ChunkingEngine] Paused transfer: ${transferId}`);
      return true;
    }
    return false;
  }

  /**
   * Resume a paused chunking operation
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
      
      // Update transfer status
      try {
        await updateTransfer(transferId, {
          status: 'active',
          resumedAt: Date.now(),
        });
      } catch (error) {
        logger.warn(`[ChunkingEngine] Failed to update resume status:`, error);
      }
      
      progressTracker.updateStatus(transferId, 'active');
      logger.log(`[ChunkingEngine] Resumed transfer: ${transferId}`);
      return true;
    }
    return false;
  }

  /**
   * Check if transfer is paused
   */
  isPaused(transferId) {
    const controller = this.pauseControllers.get(transferId);
    return controller?.isPaused || false;
  }

  /**
   * Wait if paused, returns true if should continue, false if cancelled
   * @private
   */
  async _waitIfPaused(transferId) {
    const controller = this.pauseControllers.get(transferId);
    if (!controller) return true;

    while (controller.isPaused) {
      await new Promise(resolve => {
        controller.resumeResolve = resolve;
      });
    }

    // Check if cancelled
    const state = await resumableTransferManager.getTransferState(transferId);
    return state?.status !== TransferState.CANCELLED;
  }

  /**
   * CHUNKING LOOP - Sender side implementation
   * Reads file, buffers chunks, calculates checksums, sends data
   * 
   * @param {string} transferId - Unique transfer identifier
   * @param {File} file - File object to send
   * @param {string} peerId - Receiver peer ID
   * @param {Function} onChunkReady - Callback when chunk is ready: ({ metadata, binaryData }) => void
   * @param {Function} [onProgress] - Progress callback: (bytesRead, totalSize) => void
   * @param {number} [resumeFromChunk=0] - Resume from specific chunk
   * @param {number} [initialChunkSize] - Initial chunk size from bandwidth test
   */
  async startChunking(transferId, file, peerId, onChunkReady, onProgress = null, resumeFromChunk = 0, initialChunkSize = NETWORK_CHUNK_SIZE) {
    // Create file metadata and transfer record
    const fileMetadata = createFileMetadata({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified
    });
    
    await saveFileMetadata(fileMetadata);
    const transferRecord = await createTransferRecord({ transferId, fileMeta: fileMetadata, peerId });
    const totalChunks = Math.ceil(file.size / STORAGE_CHUNK_SIZE);
    
    // Set initial chunk size from bandwidth test result (per-transfer tracking)
    const chunkSize = initialChunkSize || NETWORK_CHUNK_SIZE;
    this.chunkSizes.set(transferId, chunkSize);
    logger.log(`[ChunkingEngine] Starting with chunk size: ${chunkSize / 1024}KB`);
    
    // Initialize chunk bitmap for resume capability (sender tracks which chunks were sent)
    const chunkBitmap = createBitmap(totalChunks);
    this.chunkBitmaps.set(transferId, chunkBitmap);
    this.lastFlushCount.set(transferId, 0);
    
    // Initialize progress tracking with initial chunk size
    progressTracker.initialize(transferId, {
      totalChunks,
      fileSize: file.size,
      fileName: file.name,
      direction: 'sending',
      initialChunkSize: chunkSize
    });

    // Register with resumable transfer manager
    await resumableTransferManager.registerTransfer({
      transferId,
      role: TransferRole.SENDER,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      peerId,
      file
    });
    
    // Save initial transfer metadata to IndexedDB (for resume support)
    try {
      await saveTransfer({
        transferId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        totalChunks,
        direction: 'sending',
        status: 'active',
        chunkBitmap: serializeBitmap(chunkBitmap),
        lastProgress: 0,
        lastChunkIndex: resumeFromChunk - 1,
        peerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      logger.log(`[ChunkingEngine] Transfer metadata saved to IndexedDB for ${transferId}`);
    } catch (error) {
      logger.warn(`[ChunkingEngine] Failed to save transfer metadata:`, error);
      // Continue even if IndexedDB save fails (non-critical for active transfer)
    }

    // Initialize pause controller
    this.pauseControllers.set(transferId, {
      isPaused: false,
      resumeResolve: null
    });

    const reader = file.stream().getReader();
    this.fileReaders.set(transferId, reader);
    
    const totalSize = file.size;
    let bytesRead = 0;
    let storageChunkIndex = resumeFromChunk;
    
    // If resuming, skip to the correct position
    if (resumeFromChunk > 0) {
      const skipBytes = resumeFromChunk * STORAGE_CHUNK_SIZE;
      let skipped = 0;
      while (skipped < skipBytes) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        skipped += chunk.length;
      }
      bytesRead = skipped;
      logger.log(`[ChunkingEngine] Resuming from chunk ${resumeFromChunk}, skipped ${skipped} bytes`);
    }
    
    // Initialize chunking state
    this.activeChunkings.set(transferId, {
      file,
      fileMetadata,
      transferRecord,
      totalSize,
      bytesRead,
      storageChunkIndex,
      isComplete: false
    });

    // Initialize storage buffer
    this.storageBuffers.set(transferId, {
      buffer: new Uint8Array(STORAGE_CHUNK_SIZE),
      currentSize: 0,
      chunkStartOffset: bytesRead
    });

    // Initialize performance metrics
    this.performanceMetrics.set(transferId, {
      startTime: Date.now(),
      chunksProcessed: storageChunkIndex,
      bytesPerSecond: 0,
      adaptiveChunkSize: chunkSize
    });

    try {
      while (true) {
        // Check for pause
        const shouldContinue = await this._waitIfPaused(transferId);
        if (!shouldContinue) {
          logger.log(`[ChunkingEngine] Transfer ${transferId} cancelled`);
          break;
        }

        // Read chunk from file
        const { value: chunk, done } = await reader.read();
        
        if (done) {
          // Process final storage buffer if any data remains
          await this._processStorageBuffer(transferId, onChunkReady, true);
          break;
        }

        // Append to storage buffer
        await this._appendToStorageBuffer(transferId, chunk, onChunkReady);

        bytesRead += chunk.length;
        this.activeChunkings.get(transferId).bytesRead = bytesRead;

        // Notify caller of progress
        if (onProgress) {
          onProgress(bytesRead, totalSize);
        }

        // Update resumable transfer progress
        const chunkingState = this.activeChunkings.get(transferId);
        await resumableTransferManager.updateProgress(transferId, {
          chunkIndex: chunkingState.storageChunkIndex,
          bytesProcessed: bytesRead
        });

        // Adapt chunk size based on performance
        this._adaptChunkSize(transferId);
      }

      // Mark chunking as complete
      const chunkingState = this.activeChunkings.get(transferId);
      if (chunkingState) {
        chunkingState.isComplete = true;
        
        // Flush final bitmap state to IndexedDB
        await this._flushBitmap(transferId);
        
        // Update transfer status
        try {
          await updateTransfer(transferId, {
            status: 'completed',
            completedAt: Date.now(),
            lastProgress: 100,
          });
        } catch (error) {
          logger.warn(`[ChunkingEngine] Failed to update completion status:`, error);
        }
        
        await resumableTransferManager.completeTransfer(transferId);
        progressTracker.updateStatus(transferId, 'completed');
      }

    } catch (error) {
      logger.error('[ChunkingEngine] Chunking error:', error);
      progressTracker.updateStatus(transferId, 'failed');
      throw error;
    } finally {
      reader.releaseLock();
      this.cleanup(transferId);
    }
  }

  /**
   * Append to storage buffer and check if full
   * Handles variable-sized chunks from file stream
   * @private
   */
  async _appendToStorageBuffer(transferId, chunk, onChunkReady) {
    const bufferState = this.storageBuffers.get(transferId);
    
    // Convert to Uint8Array if needed
    const chunkData = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    
    let offset = 0;
    
    // Process the chunk in parts that fit in the buffer
    while (offset < chunkData.length) {
      const remainingSpace = STORAGE_CHUNK_SIZE - bufferState.currentSize;
      const remainingChunk = chunkData.length - offset;
      const bytesToCopy = Math.min(remainingSpace, remainingChunk);
      
      // Copy data to buffer
      bufferState.buffer.set(
        chunkData.subarray(offset, offset + bytesToCopy),
        bufferState.currentSize
      );
      bufferState.currentSize += bytesToCopy;
      offset += bytesToCopy;
      
      // Check if storage chunk is full
      if (bufferState.currentSize >= STORAGE_CHUNK_SIZE) {
        await this._processStorageBuffer(transferId, onChunkReady, false);
        // Reset buffer after processing
        bufferState.currentSize = 0;
      }
    }
  }

  /**
   * Process complete storage buffer
   * Calculates checksum, stores metadata, sends chunk
   * @private
   */
  async _processStorageBuffer(transferId, onChunkReady, isFinal) {
    const bufferState = this.storageBuffers.get(transferId);
    const chunkingState = this.activeChunkings.get(transferId);
    
    if (bufferState.currentSize === 0) return; // Nothing to process

    // Get actual data from buffer
    const chunkData = bufferState.buffer.slice(0, bufferState.currentSize);
    
    // Calculate SHA-256 checksum
    const checksum = await this._calculateChecksum(chunkData);
    
    // Build chunk metadata
    const chunkMetadata = {
      transferId,
      chunkIndex: chunkingState.storageChunkIndex,
      size: bufferState.currentSize,
      checksum,
      timestamp: Date.now(),
      isFinal,
      fileOffset: chunkingState.bytesRead - bufferState.currentSize
    };

    // Send chunk metadata and binary data (bitmap tracking is handled by useTransferTracking)
    if (onChunkReady) {
      await onChunkReady({
        metadata: chunkMetadata,
        binaryData: chunkData
      });
    }

    // Mark chunk as sent in bitmap
    const bitmap = this.chunkBitmaps.get(transferId);
    if (bitmap) {
      markChunk(bitmap, chunkingState.storageChunkIndex);
      
      // Periodically flush bitmap to IndexedDB (every N chunks)
      const sentChunks = chunkingState.storageChunkIndex + 1;
      const lastFlush = this.lastFlushCount.get(transferId) || 0;
      if (sentChunks - lastFlush >= this.BITMAP_FLUSH_INTERVAL) {
        await this._flushBitmap(transferId);
      }
    }

    // Update progress tracker
    progressTracker.updateChunk(transferId, chunkingState.storageChunkIndex, bufferState.currentSize);

    // Update performance metrics
    this._updatePerformanceMetrics(transferId, bufferState.currentSize);

    // Reset buffer and increment chunk index
    bufferState.currentSize = 0;
    chunkingState.storageChunkIndex++;
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
   * Persists current chunk sending state for resume capability
   * @private
   */
  async _flushBitmap(transferId) {
    const bitmap = this.chunkBitmaps.get(transferId);
    const chunkingState = this.activeChunkings.get(transferId);
    if (!bitmap || !chunkingState) return;

    try {
      const serialized = serializeBitmap(bitmap);
      const completedCount = getCompletedCount(bitmap);
      const totalChunks = Math.ceil(chunkingState.totalSize / STORAGE_CHUNK_SIZE);
      const progress = (completedCount / totalChunks) * 100;

      await updateTransfer(transferId, {
        chunkBitmap: serialized,
        lastProgress: progress,
        lastChunkIndex: chunkingState.storageChunkIndex,
        status: 'active',
      });

      this.lastFlushCount.set(transferId, chunkingState.storageChunkIndex + 1);
      logger.log(`[ChunkingEngine] Bitmap flushed for ${transferId}: ${completedCount}/${totalChunks} chunks (${progress.toFixed(1)}%)`);
    } catch (error) {
      logger.warn(`[ChunkingEngine] Failed to flush bitmap for ${transferId}:`, error);
      // Non-critical - continue transfer
    }
  }

  /**
   * Adaptive chunk size monitoring and adjustment
   * 
   * Uses speed bands to adjust chunk size:
   * - > 1.5 MB/s: increase chunk size by 15% (toward max)
   * - 750 KB/s - 1.5 MB/s: maintain current size
   * - 512 KB/s - 750 KB/s: decrease slightly (5%)
   * - < 512 KB/s: decrease by 15% (toward min)
   * 
   * @private
   */
  _adaptChunkSize(transferId) {
    const metrics = this.performanceMetrics.get(transferId);
    if (!metrics) return;

    const currentTime = Date.now();
    const timeDiff = currentTime - metrics.startTime;
    
    // Adjust every 1-2 seconds for stability
    if (timeDiff > 1000) {
      let chunkSize = this.chunkSizes.get(transferId) || NETWORK_CHUNK_SIZE;
      const bytesPerSecond = (metrics.chunksProcessed * chunkSize * 1000) / timeDiff;
      metrics.bytesPerSecond = bytesPerSecond;

      const oldChunkSize = chunkSize;

      // Speed-based adaptive algorithm (gradual 15% adjustments)
      if (bytesPerSecond >= SPEED_HIGH_THRESHOLD) {
        // Fast connection: increase chunk size
        chunkSize = Math.min(
          MAX_CHUNK_SIZE,
          Math.floor(chunkSize * (1 + SPEED_ADJUSTMENT_INCREMENT))
        );
      } else if (bytesPerSecond >= SPEED_HIGH_THRESHOLD / 2) {
        // Good connection: slightly increase or maintain
        if (chunkSize < (MAX_CHUNK_SIZE + NETWORK_CHUNK_SIZE) / 2) {
          chunkSize = Math.min(
            MAX_CHUNK_SIZE,
            Math.floor(chunkSize * (1 + SPEED_ADJUSTMENT_INCREMENT * 0.5))
          );
        }
      } else if (bytesPerSecond >= SPEED_LOW_THRESHOLD) {
        // Moderate connection: maintain or slightly decrease
        if (chunkSize > NETWORK_CHUNK_SIZE) {
          chunkSize = Math.max(
            MIN_CHUNK_SIZE,
            Math.floor(chunkSize * (1 - SPEED_ADJUSTMENT_INCREMENT * 0.3))
          );
        }
      } else {
        // Slow connection: decrease chunk size
        chunkSize = Math.max(
          MIN_CHUNK_SIZE,
          Math.floor(chunkSize * (1 - SPEED_ADJUSTMENT_INCREMENT))
        );
      }

      // Update per-transfer chunk size
      this.chunkSizes.set(transferId, chunkSize);

      // Log if chunk size changed
      if (oldChunkSize !== chunkSize) {
        logger.log(
          `[ChunkingEngine] ${transferId}: Speed ${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s ` +
          `→ chunk size ${Math.floor(oldChunkSize / 1024)}KB → ${Math.floor(chunkSize / 1024)}KB`
        );
      }

      metrics.adaptiveChunkSize = chunkSize;
      metrics.startTime = currentTime;
      metrics.chunksProcessed = 0;
    }
  }

  /**
   * Update performance metrics
   * @private
   */
  _updatePerformanceMetrics(transferId, bytesProcessed) {
    const metrics = this.performanceMetrics.get(transferId);
    if (metrics) {
      metrics.chunksProcessed++;
    }
  }

  /**
   * Retransmit specific chunks
   */
  async retransmitChunks(transferId, chunkIndices, file, onChunkReady) {
    if (!file) {
      return { success: false, error: 'File not available for retransmission' };
    }

    logger.log(`[ChunkingEngine] Retransmitting ${chunkIndices.length} chunks for transfer ${transferId}`);
    
    const results = { success: true, sent: 0, failed: 0, errors: [] };
    
    for (const chunkIndex of chunkIndices) {
      try {
        // Calculate file offset for this chunk
        const fileOffset = chunkIndex * STORAGE_CHUNK_SIZE;
        const endOffset = Math.min(fileOffset + STORAGE_CHUNK_SIZE, file.size);
        const chunkSize = endOffset - fileOffset;
        
        if (fileOffset >= file.size) {
          logger.warn(`[ChunkingEngine] Chunk ${chunkIndex} offset ${fileOffset} exceeds file size ${file.size}`);
          results.failed++;
          results.errors.push({ chunkIndex, error: 'Offset exceeds file size' });
          continue;
        }
        
        // Read the specific chunk from file
        const blob = file.slice(fileOffset, endOffset);
        const arrayBuffer = await blob.arrayBuffer();
        const chunkData = new Uint8Array(arrayBuffer);
        
        // Calculate checksum
        const checksum = await this._calculateChecksum(chunkData);
        
        const isFinal = endOffset >= file.size;
        
        const chunkMetadata = {
          transferId,
          chunkIndex,
          size: chunkSize,
          checksum,
          timestamp: Date.now(),
          isFinal,
          fileOffset,
          isRetransmit: true
        };
        
        // Send the chunk
        if (onChunkReady) {
          await onChunkReady({
            metadata: chunkMetadata,
            binaryData: chunkData
          });
        }
        
        results.sent++;
        logger.log(`[ChunkingEngine] Retransmitted chunk ${chunkIndex}`);
        
      } catch (err) {
        logger.error(`[ChunkingEngine] Failed to retransmit chunk ${chunkIndex}:`, err);
        results.failed++;
        results.errors.push({ chunkIndex, error: err.message });
      }
    }
    
    results.success = results.failed === 0;
    return results;
  }

  /**
   * Get pause state for a transfer
   */
  getPauseState(transferId) {
    const controller = this.pauseControllers.get(transferId);
    const state = this.activeChunkings.get(transferId);
    
    return {
      isPaused: controller?.isPaused || false,
      bytesRead: state?.bytesRead || 0,
      storageChunkIndex: state?.storageChunkIndex || 0,
      currentChunkIndex: state?.storageChunkIndex || 0,
      totalSize: state?.totalSize || 0,
      totalChunks: state ? Math.ceil(state.totalSize / STORAGE_CHUNK_SIZE) : 0
    };
  }

  /**
   * Apply receiver's bitmap to skip already-received chunks during resume
   * Called when RESUME_ACCEPTED arrives with receiver's chunk status
   * @param {string} transferId
   * @param {string} receiverBitmap - Base64 encoded bitmap from receiver
   * @param {number} totalChunks - Total number of chunks in file
   */
  async applyReceiverBitmap(transferId, receiverBitmap, totalChunks) {
    if (!receiverBitmap || !transferId) return;

    try {
      const decodedBitmap = deserializeBitmap(receiverBitmap);
      logger.log(`[ChunkingEngine] Applying receiver bitmap: ${totalChunks} chunks`);

      // Mark all chunks the receiver has as "sent" to skip them
      // This uses the same bitmap, so we just need to ensure we skip them in _processStorageBuffer
      const senderBitmap = this.chunkBitmaps.get(transferId);
      if (senderBitmap && decodedBitmap) {
        // Import the receiver's progress into sender bitmap
        // Copy completed chunks from receiver bitmap
        for (let i = 0; i < Math.min(decodedBitmap.length, senderBitmap.length); i++) {
          // Copy all bytes from receiver bitmap (marking what they have)
          // We'll use this to skip sending those chunks
          if (decodedBitmap[i] !== 0) {
            // Receiver has some chunks in this byte - we could theoretically skip them
            // but that requires more complex bit-level tracking here
            // For now, we mark them as "sent" so chunking can skip them
            senderBitmap[i] = decodedBitmap[i];
          }
        }

        // Persist the updated bitmap
        await this._flushBitmap(transferId);
        logger.log(`[ChunkingEngine] Receiver bitmap applied to sender tracker`);
      }
    } catch (error) {
      logger.warn(`[ChunkingEngine] Failed to apply receiver bitmap:`, error);
    }
  }

  /**
   * Cleanup chunking state
   */
  cleanup(transferId) {
    this.activeChunkings.delete(transferId);
    this.storageBuffers.delete(transferId);
    this.chunkSizes.delete(transferId);
    this.performanceMetrics.delete(transferId);
    this.pauseControllers.delete(transferId);
    this.fileReaders.delete(transferId);
    this.chunkBitmaps.delete(transferId);
    this.lastFlushCount.delete(transferId);
    progressTracker.clear(transferId);
  }
}

// Export singleton instance
export const chunkingEngine = new ChunkingEngine();
