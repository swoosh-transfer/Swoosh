// File System API helper: Direct file writing with security and error handling
// Using sequential append writes to avoid "state cached in an interface object" errors
// @deprecated Use infrastructure/storage/FileWriter.js instead. This file will be removed in a future release.
console.warn('[DEPRECATED] utils/fileSystem.js is deprecated. Use infrastructure/storage/FileWriter.js instead.');
import logger from './logger.js';

const CHUNK_SIZE = 64 * 1024; // 64KB - matches ChunkingEngine

// Store for active file handles during transfer
// Uses sequential write queue instead of position-based writes for better browser compatibility
let activeTransfers = new Map(); // transferId -> { handle, writable, writeQueue, nextChunk, buffer }

// Sequential write queue processor
class WriteQueue {
  constructor(writable) {
    this.writable = writable;
    this.queue = new Map(); // chunkIndex -> data
    this.nextExpected = 0;
    this.processing = false;
    this.bytesWritten = 0;
  }

  async add(chunkIndex, data) {
    this.queue.set(chunkIndex, data);
    await this.processQueue();
    return { chunkIndex, size: data.byteLength, bytesWritten: this.bytesWritten };
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      // Write chunks in order
      while (this.queue.has(this.nextExpected)) {
        const data = this.queue.get(this.nextExpected);
        this.queue.delete(this.nextExpected);

        // Simple sequential write - no position, just append
        await this.writable.write(new Uint8Array(data));
        this.bytesWritten += data.byteLength;
        this.nextExpected++;
      }
    } finally {
      this.processing = false;
    }
  }

  getProgress() {
    return {
      written: this.nextExpected,
      pending: this.queue.size,
      bytesWritten: this.bytesWritten,
    };
  }
}

export function supportsFileSystemAccess() {
  return !!(window.showSaveFilePicker && window.FileSystemHandle && window.FileSystemWritableFileStream);
}

export function checkBrowserSupport() {
  const support = {
    fileSystemAccess: supportsFileSystemAccess(),
    webCrypto: !!(window.crypto && window.crypto.subtle),
    isSecureContext: window.isSecureContext
  };
  
  if (!support.isSecureContext) {
    throw new Error('File System Access API requires HTTPS or localhost');
  }
  
  if (!support.fileSystemAccess) {
    throw new Error('File System Access API not supported in this browser');
  }
  
  if (!support.webCrypto) {
    throw new Error('Web Crypto API not supported - required for chunk verification');
  }
  
  return support;
}

// Request user permission and create file handle for saving
export async function createFileHandle(fileName, fileSize) {
  try {
    checkBrowserSupport();
    
    const handle = await window.showSaveFilePicker({
      suggestedName: fileName,
      types: [{
        description: 'Any files',
        accept: { '*/*': [] }
      }]
    });
    
    // Validate the handle
    if (!handle || typeof handle.createWritable !== 'function') {
      throw new Error('Invalid file handle received');
    }
    
    return handle;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('File save cancelled by user');
    } else if (error.name === 'NotAllowedError') {
      throw new Error('File access permission denied');
    } else if (error.name === 'SecurityError') {
      throw new Error('Security error: File access not allowed');
    }
    throw error;
  }
}

// Initialize writable stream for direct file writing
export async function initFileWriter(transferId, fileName, fileSize) {
  try {
    const handle = await createFileHandle(fileName, fileSize);
    
    // Create writable stream - no keepExistingData to start fresh
    const writable = await handle.createWritable({ 
      keepExistingData: false 
    });
    
    // Validate writable stream
    if (!writable || typeof writable.write !== 'function') {
      throw new Error('Failed to create writable stream');
    }

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    
    // Use WriteQueue for sequential writes
    const writeQueue = new WriteQueue(writable);
    
    activeTransfers.set(transferId, {
      handle,
      writable,
      writeQueue,
      totalChunks,
      fileName,
      fileSize,
      startTime: Date.now()
    });
    
    return {
      transferId,
      fileName,
      fileSize,
      totalChunks
    };
  } catch (error) {
    // Clean up on error
    if (activeTransfers.has(transferId)) {
      await cancelTransfer(transferId);
    }
    throw error;
  }
}

// Validate file handle before operations
export function validateFileHandle(handle) {
  if (!handle) {
    throw new Error('File handle is null or undefined');
  }
  
  if (!window.FileSystemHandle || !(handle instanceof FileSystemHandle)) {
    throw new Error('Invalid file handle type');
  }
  
  if (typeof handle.createWritable !== 'function') {
    throw new Error('File handle does not support writing');
  }
  
  return true;
}

// Write chunk to file using sequential queue (avoids "state cached" error)
export async function writeChunkToFile(transferId, chunkIndex, chunkBuffer) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) {
    throw new Error(`Transfer ${transferId} not found`);
  }
  
  try {
    // Use write queue for proper sequential ordering
    const result = await transfer.writeQueue.add(chunkIndex, chunkBuffer);
    const progress = transfer.writeQueue.getProgress();
    
    return {
      chunkIndex,
      size: chunkBuffer.byteLength,
      progress: {
        received: progress.written,
        total: transfer.totalChunks,
        percentage: (progress.written / transfer.totalChunks) * 100,
        bytesWritten: progress.bytesWritten
      }
    };
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new Error('Permission denied during file write');
    } else if (error.name === 'QuotaExceededError') {
      throw new Error('Storage quota exceeded');
    } else if (error.name === 'InvalidStateError') {
      throw new Error('File writer in invalid state - try refreshing the page');
    }
    throw error;
  }
}

// Check if all chunks have been written
export function isTransferComplete(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) return false;
  const progress = transfer.writeQueue.getProgress();
  return progress.written >= transfer.totalChunks;
}

// Complete transfer and close file safely
export async function completeTransfer(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) {
    throw new Error(`Transfer ${transferId} not found`);
  }
  
  try {
    // Wait for any pending writes in queue
    const progress = transfer.writeQueue.getProgress();
    
    if (progress.pending > 0) {
      // Some out-of-order chunks still pending - wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!isTransferComplete(transferId)) {
      const missing = transfer.totalChunks - progress.written;
      logger.warn(`Transfer incomplete: ${missing} chunks missing, completing anyway`);
    }
    
    // Close writable stream safely
    await transfer.writable.close();
    
    const result = {
      success: true,
      transferId,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      chunksReceived: progress.written,
      bytesWritten: progress.bytesWritten,
      duration: Date.now() - transfer.startTime
    };
    
    // Clean up
    activeTransfers.delete(transferId);
    
    return result;
  } catch (error) {
    // Attempt cleanup even on error
    try {
      await transfer.writable.abort();
    } catch (abortError) {
      logger.warn('Error aborting writable during cleanup:', abortError);
    }
    activeTransfers.delete(transferId);
    throw error;
  }
}

// Get real-time transfer progress
export function getTransferProgress(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) return null;
  
  const progress = transfer.writeQueue.getProgress();
  const percentage = (progress.written / transfer.totalChunks) * 100;
  const elapsed = Date.now() - transfer.startTime;
  
  return {
    transferId,
    fileName: transfer.fileName,
    fileSize: transfer.fileSize,
    received: progress.written,
    total: transfer.totalChunks,
    percentage,
    bytesReceived: progress.bytesWritten,
    pending: progress.pending,
    elapsed,
    estimatedTimeRemaining: progress.written > 0 ? ((transfer.totalChunks - progress.written) * elapsed) / progress.written : null
  };
}

// Cancel transfer with proper cleanup
export async function cancelTransfer(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) return false;
  
  try {
    if (transfer.writable && !transfer.writable.locked) {
      await transfer.writable.abort();
    }
  } catch (error) {
    logger.warn('Error during transfer cancellation:', error);
  } finally {
    activeTransfers.delete(transferId);
  }
  
  return true;
}

export default {
  CHUNK_SIZE,
  supportsFileSystemAccess,
  checkBrowserSupport,
  createFileHandle,
  initFileWriter,
  validateFileHandle,
  writeChunkToFile,
  isTransferComplete,
  completeTransfer,
  getTransferProgress,
  cancelTransfer,
};
