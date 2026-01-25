// File Chunking and Assembly System
// Implements dual-loop architecture: chunking loop for sending, receiving loop for assembly
// Supports pause/resume and crash recovery

import { saveChunkMeta, getChunkMeta, getChunksByTransfer, deleteChunksByTransfer } from './indexedDB.js';
import { createFileMetadata, saveFileMetadata, createTransferRecord, updateTransferProgress } from './fileMetadata.js';
import { initFileWriter, writeChunkToFile, completeTransfer, getTransferProgress as getFileProgress } from './fileSystem.js';
import { 
  resumableTransferManager, 
  TransferState, 
  TransferRole 
} from './resumableTransfer.js';
import logger from './logger.js';

const INITIAL_CHUNK_SIZE = 16 * 1024; // 16KB - WebRTC DataChannel limit
const STORAGE_BUFFER_SIZE = 64 * 1024; // 64KB storage chunks for IndexedDB
const MAX_CHUNK_SIZE = 32 * 1024; // Maximum adaptive chunk size
const MIN_CHUNK_SIZE = 8 * 1024; // Minimum adaptive chunk size

class ChunkingEngine {
  constructor() {
    this.activeChunkings = new Map(); // transferId -> chunking state
    this.storageBuffers = new Map(); // transferId -> storage buffer
    this.chunkSize = INITIAL_CHUNK_SIZE;
    this.performanceMetrics = new Map(); // transferId -> metrics
    this.pauseControllers = new Map(); // transferId -> { isPaused, resumeResolve }
    this.fileReaders = new Map(); // transferId -> reader (for resume)
  }

  /**
   * Pause a chunking operation
   * @param {string} transferId Transfer ID
   */
  async pause(transferId) {
    const controller = this.pauseControllers.get(transferId);
    if (controller && !controller.isPaused) {
      controller.isPaused = true;
      await resumableTransferManager.pauseTransfer(transferId);
      logger.log(`[ChunkingEngine] Paused transfer: ${transferId}`);
      return true;
    }
    return false;
  }

  /**
   * Resume a paused chunking operation
   * @param {string} transferId Transfer ID
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
      logger.log(`[ChunkingEngine] Resumed transfer: ${transferId}`);
      return true;
    }
    return false;
  }

  /**
   * Check if transfer is paused
   * @param {string} transferId Transfer ID
   */
  isPaused(transferId) {
    const controller = this.pauseControllers.get(transferId);
    return controller?.isPaused || false;
  }

  /**
   * Wait if paused, returns true if should continue, false if cancelled
   * @param {string} transferId Transfer ID
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
   * Reads file in 16KB chunks, buffers to storage size, then processes
   * Now supports pause/resume
   */
  async startChunking(transferId, file, peerId, onChunkReady, onProgress, resumeFromChunk = 0) {
    // Create file metadata and transfer record
    const fileMetadata = createFileMetadata({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified
    });
    
    await saveFileMetadata(fileMetadata);
    const transferRecord = await createTransferRecord({ transferId, fileMeta: fileMetadata, peerId });
    
    // Register with resumable transfer manager
    await resumableTransferManager.registerTransfer({
      transferId,
      role: TransferRole.SENDER,
      fileName: file.name,
      fileSize: file.size,
      totalChunks: Math.ceil(file.size / STORAGE_BUFFER_SIZE),
      peerId,
      file
    });

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
      const skipBytes = resumeFromChunk * STORAGE_BUFFER_SIZE;
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
      isComplete: false,
      isPaused: false
    });

    // Initialize storage buffer
    this.storageBuffers.set(transferId, {
      buffer: new Uint8Array(STORAGE_BUFFER_SIZE),
      currentSize: 0,
      chunkStartOffset: bytesRead
    });

    // Initialize performance metrics
    this.performanceMetrics.set(transferId, {
      startTime: Date.now(),
      chunksProcessed: storageChunkIndex,
      bytesPerSecond: 0,
      adaptiveChunkSize: this.chunkSize
    });

    try {
      while (true) {
        // Check for pause
        const shouldContinue = await this._waitIfPaused(transferId);
        if (!shouldContinue) {
          logger.log(`[ChunkingEngine] Transfer ${transferId} cancelled`);
          break;
        }

        // 3. Read 16KB from file (or remaining bytes)
        const { value: chunk, done } = await reader.read();
        
        if (done) {
          // Process final storage buffer if any data remains
          await this._processStorageBuffer(transferId, onChunkReady, true);
          break;
        }

        // 4. Append to storage buffer
        await this._appendToStorageBuffer(transferId, chunk, onChunkReady);

        bytesRead += chunk.length;
        this.activeChunkings.get(transferId).bytesRead = bytesRead;

        // Report progress
        if (onProgress) {
          onProgress(bytesRead, totalSize);
        }

        // Update resumable transfer progress
        const chunkingState = this.activeChunkings.get(transferId);
        await resumableTransferManager.updateProgress(transferId, {
          chunkIndex: chunkingState.storageChunkIndex,
          bytesProcessed: bytesRead
        });

        // 9. Adapt chunk size based on performance monitoring
        this._adaptChunkSize(transferId);
      }

      // Mark chunking as complete
      const chunkingState = this.activeChunkings.get(transferId);
      if (chunkingState) {
        chunkingState.isComplete = true;
        await resumableTransferManager.completeTransfer(transferId);
      }

    } catch (error) {
      logger.error('Chunking error:', error);
      throw new Error(`File chunking failed: ${error.message}`);
    } finally {
      reader.releaseLock();
      this.cleanup(transferId);
    }
  }

  /**
   * 4-5. Append to storage buffer and check if full
   * Handles variable-sized chunks from file stream (can be larger than buffer)
   */
  async _appendToStorageBuffer(transferId, chunk, onChunkReady) {
    const bufferState = this.storageBuffers.get(transferId);
    
    // Convert to Uint8Array if needed
    const chunkData = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    
    let offset = 0;
    
    // Process the chunk in parts that fit in the buffer
    while (offset < chunkData.length) {
      const remainingSpace = STORAGE_BUFFER_SIZE - bufferState.currentSize;
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
      if (bufferState.currentSize >= STORAGE_BUFFER_SIZE) {
        await this._processStorageBuffer(transferId, onChunkReady, false);
        // Reset buffer after processing
        bufferState.currentSize = 0;
      }
    }
  }

  /**
   * 6-11. Process complete storage buffer
   */
  async _processStorageBuffer(transferId, onChunkReady, isFinal) {
    const bufferState = this.storageBuffers.get(transferId);
    const chunkingState = this.activeChunkings.get(transferId);
    
    if (bufferState.currentSize === 0) return; // Nothing to process

    // Get actual data from buffer
    const chunkData = bufferState.buffer.slice(0, bufferState.currentSize);
    
    // 6. Calculate SHA-256 checksum
    const checksum = await this._calculateChecksum(chunkData);
    
    // 7. Store metadata in IndexedDB (NOT the actual chunk data)
    const chunkMetadata = {
      transferId,
      chunkIndex: chunkingState.storageChunkIndex,
      size: bufferState.currentSize,
      checksum,
      timestamp: Date.now(),
      isFinal,
      fileOffset: chunkingState.bytesRead - bufferState.currentSize
    };

    await this._storeChunkMetadata(chunkMetadata);

    // 8. Send chunk metadata first, then binary data
    if (onChunkReady) {
      // 11. Send binary data via WebRTC
      await onChunkReady({
        metadata: chunkMetadata,
        binaryData: chunkData
      });
    }

    // Update performance metrics
    this._updatePerformanceMetrics(transferId, bufferState.currentSize);

    // 10. Reset buffer
    bufferState.currentSize = 0;
    chunkingState.storageChunkIndex++;
  }

  /**
   * 6. Calculate SHA-256 checksum
   */
  async _calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 7. Store chunk metadata in IndexedDB
   */
  async _storeChunkMetadata(metadata) {
    await saveChunkMeta({
      transferId: metadata.transferId,
      chunkIndex: metadata.chunkIndex,
      size: metadata.size,
      checksum: metadata.checksum,
      timestamp: metadata.timestamp,
      isFinal: metadata.isFinal,
      fileOffset: metadata.fileOffset,
      status: 'sent'
    });
  }

  /**
   * 9. Adaptive chunk size monitoring and adjustment
   */
  _adaptChunkSize(transferId) {
    const metrics = this.performanceMetrics.get(transferId);
    if (!metrics) return;

    const currentTime = Date.now();
    const timeDiff = currentTime - metrics.startTime;
    
    if (timeDiff > 1000) { // Adjust every second
      const bytesPerSecond = (metrics.chunksProcessed * this.chunkSize * 1000) / timeDiff;
      metrics.bytesPerSecond = bytesPerSecond;

      // Adapt based on throughput
      if (bytesPerSecond > 1024 * 1024) { // > 1MB/s - increase chunk size
        this.chunkSize = Math.min(MAX_CHUNK_SIZE, this.chunkSize * 1.2);
      } else if (bytesPerSecond < 512 * 1024) { // < 512KB/s - decrease chunk size
        this.chunkSize = Math.max(MIN_CHUNK_SIZE, this.chunkSize * 0.8);
      }

      metrics.adaptiveChunkSize = this.chunkSize;
      metrics.startTime = currentTime; // Reset timer
      metrics.chunksProcessed = 0; // Reset counter
    }
  }

  /**
   * Update performance metrics
   */
  _updatePerformanceMetrics(transferId, bytesProcessed) {
    const metrics = this.performanceMetrics.get(transferId);
    if (metrics) {
      metrics.chunksProcessed++;
    }
  }

  /**
   * Cleanup chunking state
   */
  cleanup(transferId) {
    this.activeChunkings.delete(transferId);
    this.storageBuffers.delete(transferId);
    this.performanceMetrics.delete(transferId);
    this.pauseControllers.delete(transferId);
    this.fileReaders.delete(transferId);
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
      totalSize: state?.totalSize || 0
    };
  }
}

class AssemblyEngine {
  constructor() {
    this.activeAssemblies = new Map(); // transferId -> assembly state
    this.receiveBuffers = new Map(); // transferId -> receive buffer
    this.expectedMetadata = new Map(); // transferId -> file metadata
  }

  /**
   * RECEIVING LOOP - Receiver side implementation
   * Receives chunks, validates, buffers to storage size, then writes
   */
  async initializeAssembly(transferId, fileMetadata, peerId) {
    // Create transfer record
    const transferRecord = await createTransferRecord({ transferId, fileMeta: fileMetadata, peerId });
    
    // Initialize file writer using existing file system utilities
    const fileWriter = await initFileWriter(transferId, fileMetadata.name, fileMetadata.size);
    
    // Initialize assembly state
    this.activeAssemblies.set(transferId, {
      fileWriter,
      fileMetadata,
      transferRecord,
      receivedChunks: 0,
      totalChunks: Math.ceil(fileMetadata.size / STORAGE_BUFFER_SIZE),
      bytesReceived: 0,
      isComplete: false,
      currentFileChunkIndex: 0 // Track 16KB file system chunks
    });

    // Initialize receive buffer
    this.receiveBuffers.set(transferId, {
      buffer: new Uint8Array(STORAGE_BUFFER_SIZE),
      currentSize: 0,
      expectedSize: STORAGE_BUFFER_SIZE
    });

    this.expectedMetadata.set(transferId, fileMetadata);
    
    return fileWriter;
  }

  /**
   * 3-10. Receive and process chunk
   */
  async receiveChunk(transferId, chunkData, chunkMetadata) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new Error(`No assembly initialized for transfer ${transferId}`);
    }

    // 3. Receive 16KB chunk (chunkData)
    // 4. Append to storage buffer
    await this._appendToReceiveBuffer(transferId, chunkData, chunkMetadata);
  }

  /**
   * 4-9. Append to receive buffer and process when complete
   */
  async _appendToReceiveBuffer(transferId, chunkData, chunkMetadata) {
    const bufferState = this.receiveBuffers.get(transferId);
    const assemblyState = this.activeAssemblies.get(transferId);

    // Append chunk data to buffer
    if (bufferState.currentSize + chunkData.length <= STORAGE_BUFFER_SIZE) {
      bufferState.buffer.set(chunkData, bufferState.currentSize);
      bufferState.currentSize += chunkData.length;
    } else {
      throw new Error('Chunk data exceeds storage buffer capacity');
    }

    // 5. Check if storage chunk is complete
    const isComplete = chunkMetadata.isFinal || 
                      bufferState.currentSize >= STORAGE_BUFFER_SIZE ||
                      bufferState.currentSize >= bufferState.expectedSize;

    if (isComplete) {
      // 6. Calculate SHA-256 checksum for validation
      const actualData = bufferState.buffer.slice(0, bufferState.currentSize);
      const calculatedChecksum = await this._calculateChecksum(actualData);

      // 7. Validate checksum
      if (calculatedChecksum !== chunkMetadata.checksum) {
        throw new Error(`Checksum validation failed for chunk ${chunkMetadata.chunkIndex}`);
      }

      // 8. Store validated chunk metadata in IndexedDB
      await this._storeValidatedChunk(transferId, chunkMetadata);

      // Break storage buffer into 16KB chunks for file system writing
      const fileSystemChunkSize = 16 * 1024;
      for (let offset = 0; offset < actualData.length; offset += fileSystemChunkSize) {
        const chunkEnd = Math.min(offset + fileSystemChunkSize, actualData.length);
        const fileChunk = actualData.slice(offset, chunkEnd);
        
        // Write 16KB chunk to file using existing file system utilities
        await writeChunkToFile(transferId, assemblyState.currentFileChunkIndex, fileChunk);
        assemblyState.currentFileChunkIndex++;
      }

      // Update progress
      assemblyState.bytesReceived += bufferState.currentSize;
      assemblyState.receivedChunks++;
      
      // Update transfer progress in metadata
      await updateTransferProgress(transferId, {
        receivedChunks: assemblyState.receivedChunks,
        status: 'in-progress'
      });

      // 9. Reset buffer
      bufferState.currentSize = 0;

      // Check if file transfer is complete
      if (chunkMetadata.isFinal) {
        await this._completeAssembly(transferId);
      }
    }
  }

  /**
   * 6. Calculate SHA-256 checksum
   */
  async _calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 8. Store validated chunk in IndexedDB
   */
  async _storeValidatedChunk(transferId, chunkMetadata) {
    await saveChunkMeta({
      transferId: chunkMetadata.transferId,
      chunkIndex: chunkMetadata.chunkIndex,
      size: chunkMetadata.size,
      checksum: chunkMetadata.checksum,
      timestamp: chunkMetadata.timestamp,
      isFinal: chunkMetadata.isFinal,
      fileOffset: chunkMetadata.fileOffset,
      status: 'received',
      validated: true,
      receivedAt: Date.now()
    });
  }

  /**
   * Complete file assembly
   */
  async _completeAssembly(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    
    // Complete transfer using file system utilities
    const result = await completeTransfer(transferId);
    
    // Update transfer record
    await updateTransferProgress(transferId, {
      status: 'completed',
      receivedChunks: assemblyState.totalChunks,
      completedAt: Date.now()
    });
    
    // Mark as complete
    assemblyState.isComplete = true;

    logger.log(`File assembly complete: ${result.fileSize} bytes received in ${result.duration}ms`);
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
      isComplete: assemblyState.isComplete
    };
  }

  /**
   * Cleanup assembly state
   */
  cleanup(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (assemblyState && assemblyState.fileWriter) {
      // File system utilities handle cleanup automatically
      // No need to manually close streams
    }
    
    this.activeAssemblies.delete(transferId);
    this.receiveBuffers.delete(transferId);
    this.expectedMetadata.delete(transferId);
  }
}

// Global instances
export const chunkingEngine = new ChunkingEngine();
export const assemblyEngine = new AssemblyEngine();

// Utility functions
export async function createTransferId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Initialize a complete file transfer (sender side)
export async function initializeFileTransfer(file, peerId) {
  const transferId = await createTransferId();
  
  // Create file metadata
  const fileMetadata = createFileMetadata({
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified
  });
  
  await saveFileMetadata(fileMetadata);
  const transferRecord = await createTransferRecord({ transferId, fileMeta: fileMetadata, peerId });
  
  return {
    transferId,
    fileMetadata,
    transferRecord
  };
}

// Initialize file reception (receiver side)
export async function initializeFileReception(transferId, fileMetadata, peerId) {
  return await assemblyEngine.initializeAssembly(transferId, fileMetadata, peerId);
}

// Start file chunking process (with optional resume)
export async function startFileChunking(transferId, file, peerId, onChunkReady, onProgress, resumeFromChunk = 0) {
  return await chunkingEngine.startChunking(transferId, file, peerId, onChunkReady, onProgress, resumeFromChunk);
}

// Pause file chunking
export async function pauseChunking(transferId) {
  return await chunkingEngine.pause(transferId);
}

// Resume file chunking
export async function resumeChunking(transferId) {
  return await chunkingEngine.resume(transferId);
}

// Check if chunking is paused
export function isChunkingPaused(transferId) {
  return chunkingEngine.isPaused(transferId);
}

// Get chunking pause state
export function getChunkingPauseState(transferId) {
  return chunkingEngine.getPauseState(transferId);
}

// Process received chunk
export async function processReceivedChunk(transferId, chunkData, chunkMetadata) {
  return await assemblyEngine.receiveChunk(transferId, chunkData, chunkMetadata);
}

// Get transfer progress (combines chunking and file system progress)
export function getTransferProgress(transferId) {
  const chunkingProgress = chunkingEngine.activeChunkings.get(transferId);
  const assemblyProgress = assemblyEngine.getProgress(transferId);
  const fileSystemProgress = getFileProgress(transferId);
  const pauseState = chunkingEngine.getPauseState(transferId);
  
  return {
    chunking: chunkingProgress,
    assembly: assemblyProgress,
    fileSystem: fileSystemProgress,
    isPaused: pauseState.isPaused
  };
}

// Resume transfer from existing chunks
export async function resumeTransfer(transferId) {
  const chunks = await getChunksByTransfer(transferId);
  const completedChunks = chunks.filter(chunk => chunk.status === 'received' && chunk.validated);
  
  return {
    transferId,
    completedChunks: completedChunks.length,
    totalChunks: chunks.length,
    canResume: completedChunks.length > 0
  };
}

// Clean up completed or cancelled transfer
export async function cleanupTransfer(transferId, deleteMetadata = false) {
  // Clean up chunking engine
  chunkingEngine.cleanup(transferId);
  
  // Clean up assembly engine  
  assemblyEngine.cleanup(transferId);
  
  if (deleteMetadata) {
    // Remove chunk metadata
    await deleteChunksByTransfer(transferId);
    
    // Remove transfer metadata
    const { deleteTransferMeta } = await import('./indexedDB.js');
    await deleteTransferMeta(transferId);
  }
}

export function getChunkingProgress(transferId) {
  return chunkingEngine.activeChunkings.get(transferId) || null;
}

export function getAssemblyProgress(transferId) {
  return assemblyEngine.getProgress(transferId);
}

// Export classes for advanced usage
export { ChunkingEngine, AssemblyEngine };