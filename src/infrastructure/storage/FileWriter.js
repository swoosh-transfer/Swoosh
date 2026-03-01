/**
 * File Writer
 * 
 * High-level interface for writing received files using File System Access API.
 * Manages file handles, write queues, and transfer lifecycle.
 */

import { WriteQueue } from './WriteQueue.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { FILE_WRITE_DELAY } from '../../constants/timing.constants.js';
import { StorageError } from '../../lib/errors.js';
import logger from '../../utils/logger.js';

// Active file writers by transfer ID
const activeWriters = new Map();

/**
 * Check if File System Access API is supported
 * 
 * @returns {boolean}
 */
export function supportsFileSystemAccess() {
  return !!(
    window.showSaveFilePicker && 
    window.FileSystemHandle && 
    window.FileSystemWritableFileStream
  );
}

/**
 * Check if file-open picker (showOpenFilePicker) is supported
 * 
 * @returns {boolean}
 */
export function supportsOpenFilePicker() {
  return typeof window.showOpenFilePicker === 'function';
}

/**
 * Open a file picker dialog for re-selecting files (e.g. during resume).
 * Uses the File System Access API's showOpenFilePicker.
 * 
 * Falls back to a hidden <input type="file"> on browsers without FSAPI.
 * 
 * @param {Object} [options]
 * @param {boolean} [options.multiple=false] - Allow multiple file selection
 * @param {Array<{description: string, accept: Object}>} [options.types] - File type filters
 * @param {string} [options.startIn] - Start directory hint ('desktop', 'documents', etc.)
 * @returns {Promise<File[]>} Array of selected File objects
 * @throws {StorageError} On cancellation or permission error
 */
export async function openFilePicker(options = {}) {
  const { multiple = false, types, startIn } = options;

  // Try File System Access API first
  if (supportsOpenFilePicker()) {
    try {
      const pickerOpts = { multiple };
      if (types) pickerOpts.types = types;
      if (startIn) pickerOpts.startIn = startIn;

      const handles = await window.showOpenFilePicker(pickerOpts);
      const files = await Promise.all(handles.map((h) => h.getFile()));
      return files;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new StorageError('File selection cancelled by user');
      }
      throw error;
    }
  }

  // Fallback: hidden <input type="file">
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (types && types.length > 0) {
      // Build accept attribute from types, e.g. ".jpg,.png"
      const accept = types
        .flatMap((t) => Object.values(t.accept || {}).flat())
        .join(',');
      if (accept) input.accept = accept;
    }
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      document.body.removeChild(input);
      if (files.length === 0) {
        reject(new StorageError('No files selected'));
      } else {
        resolve(files);
      }
    });

    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      reject(new StorageError('File selection cancelled by user'));
    });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Check browser support and throw if not available
 * 
 * @throws {StorageError} If required APIs are not supported
 */
export function checkBrowserSupport() {
  if (!window.isSecureContext) {
    throw new StorageError('File System Access API requires HTTPS or localhost');
  }
  
  if (!supportsFileSystemAccess()) {
    throw new StorageError('File System Access API not supported in this browser');
  }
  
  if (!window.crypto || !window.crypto.subtle) {
    throw new StorageError('Web Crypto API not supported');
  }
}

/**
 * Create file handle with user permission
 * 
 * Opens save file picker dialog and gets writable file handle.
 * 
 * @param {string} fileName - Suggested file name
 * @param {number} fileSize - Expected file size (for validation)
 * @returns {Promise<FileSystemFileHandle>}
 * @throws {StorageError} On permission denial or cancellation
 */
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
      throw new StorageError('Invalid file handle received');
    }
    
    return handle;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new StorageError('File save cancelled by user');
    } else if (error.name === 'NotAllowedError') {
      throw new StorageError('File access permission denied');
    } else if (error.name === 'SecurityError') {
      throw new StorageError('Security error: File access not allowed');
    }
    throw error;
  }
}

/**
 * Initialize file writer for a transfer
 * 
 * Creates file handle, opens writable stream, and sets up write queue.
 * 
 * @param {string} transferId - Transfer ID
 * @param {string} fileName - File name
 * @param {number} fileSize - File size in bytes
 * @returns {Promise<Object>} Writer info
 */
export async function initFileWriter(transferId, fileName, fileSize) {
  try {
    const handle = await createFileHandle(fileName, fileSize);
    
    // Create writable stream - start fresh
    const writable = await handle.createWritable({ 
      keepExistingData: false 
    });
    
    // Validate writable stream
    if (!writable || typeof writable.write !== 'function') {
      throw new StorageError('Failed to create writable stream');
    }

    const totalChunks = Math.ceil(fileSize / STORAGE_CHUNK_SIZE);
    const writeQueue = new WriteQueue(writable);
    
    activeWriters.set(transferId, {
      handle,
      writable,
      writeQueue,
      totalChunks,
      fileName,
      fileSize,
      startTime: Date.now(),
    });
    
    logger.info(`[FileWriter] Initialized for ${fileName} (${totalChunks} chunks)`);
    
    return {
      transferId,
      fileName,
      fileSize,
      totalChunks,
    };
  } catch (error) {
    // Clean up on error
    if (activeWriters.has(transferId)) {
      await cancelWriter(transferId);
    }
    throw error;
  }
}

/**
 * Write chunk to file
 * 
 * Adds chunk to write queue, which handles sequential writing.
 * 
 * @param {string} transferId - Transfer ID
 * @param {number} chunkIndex - Chunk index
 * @param {ArrayBuffer} chunkBuffer - Chunk data
 * @returns {Promise<Object>} Write result with progress
 */
export async function writeChunk(transferId, chunkIndex, chunkBuffer) {
  const writer = activeWriters.get(transferId);
  if (!writer) {
    throw new StorageError(`Transfer ${transferId} not found`);
  }
  
  try {
    // Use write queue for sequential ordering
    const result = await writer.writeQueue.add(chunkIndex, chunkBuffer);
    const progress = writer.writeQueue.getProgress();
    
    return {
      chunkIndex,
      size: chunkBuffer.byteLength,
      progress: {
        received: progress.written,
        total: writer.totalChunks,
        percentage: (progress.written / writer.totalChunks) * 100,
        bytesWritten: progress.bytesWritten,
      },
    };
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new StorageError('Permission denied during file write');
    } else if (error.name === 'QuotaExceededError') {
      throw new StorageError('Storage quota exceeded');
    } else if (error.name === 'InvalidStateError') {
      throw new StorageError('File writer in invalid state - try refreshing the page');
    }
    throw error;
  }
}

/**
 * Check if transfer is complete
 * 
 * @param {string} transferId - Transfer ID
 * @returns {boolean}
 */
export function isWriterComplete(transferId) {
  const writer = activeWriters.get(transferId);
  if (!writer) return false;
  
  const progress = writer.writeQueue.getProgress();
  return progress.written >= writer.totalChunks;
}

/**
 * Get writer progress
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Object|null} Progress info or null
 */
export function getWriterProgress(transferId) {
  const writer = activeWriters.get(transferId);
  if (!writer) return null;
  
  const progress = writer.writeQueue.getProgress();
  const percentage = (progress.written / writer.totalChunks) * 100;
  const elapsed = Date.now() - writer.startTime;
  
  return {
    transferId,
    fileName: writer.fileName,
    fileSize: writer.fileSize,
    received: progress.written,
    total: writer.totalChunks,
    percentage,
    bytesReceived: progress.bytesWritten,
    pending: progress.pending,
    elapsed,
    estimatedTimeRemaining: progress.written > 0 
      ? ((writer.totalChunks - progress.written) * elapsed) / progress.written 
      : null,
  };
}

/**
 * Complete writer and close file
 * 
 * Waits for pending writes, then closes the writable stream.
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<Object>} Completion result
 */
export async function completeWriter(transferId) {
  const writer = activeWriters.get(transferId);
  if (!writer) {
    throw new StorageError(`Transfer ${transferId} not found`);
  }
  
  try {
    // Wait for any pending writes in queue
    const progress = writer.writeQueue.getProgress();
    
    if (progress.pending > 0) {
      logger.info(`[FileWriter] Waiting for ${progress.pending} pending chunks...`);
      await new Promise(resolve => setTimeout(resolve, FILE_WRITE_DELAY));
    }

    if (!isWriterComplete(transferId)) {
      const missing = writer.totalChunks - progress.written;
      logger.warn(`[FileWriter] Transfer incomplete: ${missing} chunks missing`);
    }
    
    // Close writable stream
    await writer.writable.close();
    
    const result = {
      success: true,
      transferId,
      fileName: writer.fileName,
      fileSize: writer.fileSize,
      chunksReceived: progress.written,
      bytesWritten: progress.bytesWritten,
      duration: Date.now() - writer.startTime,
    };
    
    // Clean up
    activeWriters.delete(transferId);
    
    logger.info(`[FileWriter] Completed: ${writer.fileName}`);
    return result;
  } catch (error) {
    // Attempt cleanup on error
    try {
      await writer.writable.abort();
    } catch (abortError) {
      logger.warn('[FileWriter] Error aborting writable:', abortError);
    }
    activeWriters.delete(transferId);
    throw error;
  }
}

/**
 * Cancel writer and clean up
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<boolean>}
 */
export async function cancelWriter(transferId) {
  const writer = activeWriters.get(transferId);
  if (!writer) return false;
  
  try {
    if (writer.writable && !writer.writable.locked) {
      await writer.writable.abort();
    }
  } catch (error) {
    logger.warn('[FileWriter] Error during cancellation:', error);
  } finally {
    activeWriters.delete(transferId);
  }
  
  logger.info(`[FileWriter] Cancelled: ${transferId}`);
  return true;
}

/**
 * Export CHUNK_SIZE for compatibility
 */
export const CHUNK_SIZE = STORAGE_CHUNK_SIZE;
