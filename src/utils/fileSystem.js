// File System API helper: Direct file writing with security and error handling
const CHUNK_SIZE = 16 * 1024; // 16KB

// Store for active file handles during transfer
let activeTransfers = new Map(); // transferId -> { handle, writable, receivedChunks, totalChunks }

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
    
    // Create writable stream with proper error handling
    const writable = await handle.createWritable({ 
      keepExistingData: false 
    });
    
    // Validate writable stream
    if (!writable || typeof writable.write !== 'function') {
      throw new Error('Failed to create writable stream');
    }
    
    activeTransfers.set(transferId, {
      handle,
      writable,
      receivedChunks: new Set(),
      totalChunks: Math.ceil(fileSize / CHUNK_SIZE),
      fileName,
      fileSize,
      startTime: Date.now()
    });
    
    return {
      transferId,
      fileName,
      fileSize,
      totalChunks: Math.ceil(fileSize / CHUNK_SIZE)
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

// Write chunk directly to file with position-based writing
export async function writeChunkToFile(transferId, chunkIndex, chunkBuffer) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) {
    throw new Error(`Transfer ${transferId} not found`);
  }
  
  try {
    // Validate writable stream
    if (!transfer.writable || transfer.writable.locked) {
      throw new Error('Writable stream is invalid or locked');
    }
    
    // Calculate offset for chunk positioning
    const offset = chunkIndex * CHUNK_SIZE;
    
    // Write chunk at specific position
    await transfer.writable.write({
      type: 'write',
      position: offset,
      data: new Uint8Array(chunkBuffer)
    });
    
    // Track progress
    transfer.receivedChunks.add(chunkIndex);
    
    return {
      chunkIndex,
      offset,
      size: chunkBuffer.byteLength,
      progress: {
        received: transfer.receivedChunks.size,
        total: transfer.totalChunks,
        percentage: (transfer.receivedChunks.size / transfer.totalChunks) * 100
      }
    };
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new Error('Permission denied during file write');
    } else if (error.name === 'QuotaExceededError') {
      throw new Error('Storage quota exceeded');
    } else if (error.name === 'InvalidStateError') {
      throw new Error('File writer in invalid state');
    }
    throw error;
  }
}

// Check if all chunks have been received
export function isTransferComplete(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) return false;
  return transfer.receivedChunks.size === transfer.totalChunks;
}

// Complete transfer and close file safely
export async function completeTransfer(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) {
    throw new Error(`Transfer ${transferId} not found`);
  }
  
  try {
    if (!isTransferComplete(transferId)) {
      const missing = transfer.totalChunks - transfer.receivedChunks.size;
      throw new Error(`Transfer incomplete: ${missing} chunks missing`);
    }
    
    // Close writable stream safely
    await transfer.writable.close();
    
    const result = {
      success: true,
      transferId,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      chunksReceived: transfer.receivedChunks.size,
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
      console.warn('Error aborting writable during cleanup:', abortError);
    }
    activeTransfers.delete(transferId);
    throw error;
  }
}

// Get real-time transfer progress
export function getTransferProgress(transferId) {
  const transfer = activeTransfers.get(transferId);
  if (!transfer) return null;
  
  const received = transfer.receivedChunks.size;
  const total = transfer.totalChunks;
  const percentage = (received / total) * 100;
  const elapsed = Date.now() - transfer.startTime;
  
  return {
    transferId,
    fileName: transfer.fileName,
    fileSize: transfer.fileSize,
    received,
    total,
    percentage,
    bytesReceived: received * CHUNK_SIZE,
    elapsed,
    estimatedTimeRemaining: received > 0 ? ((total - received) * elapsed) / received : null
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
    console.warn('Error during transfer cancellation:', error);
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
