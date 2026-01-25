/**
 * File Receiver - Handles receiving large files with direct disk writing
 * Supports chunk validation, missing chunk tracking, and resume capability
 * Uses sequential ordered writes to avoid "state cached" errors
 */

import { saveChunkMeta, getChunkMeta, getChunksByTransfer } from './indexedDB.js';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

export class FileReceiver {
  constructor() {
    this.activeTransfers = new Map(); // transferId -> transfer state
    this.writeQueues = new Map(); // transferId -> write queue for sequential writes
    this.pendingChunks = new Map(); // transferId -> Map of out-of-order chunks waiting to be written
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
  }

  /**
   * Initialize a file receive operation
   * Must be called from a user gesture (button click) for File System API
   * @param {Object} metadata - File metadata from sender
   * @returns {Promise<Object>} Transfer state
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
      fileHandle: null,
      writable: null,
      useFileSystemAPI: false,
      memoryChunks: [], // Fallback for browsers without File System API
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      nextExpectedChunk: 0, // Track next expected chunk for sequential writes
      bytesWritten: 0,
    };

    this.activeTransfers.set(transferId, state);
    
    // Initialize write queue for sequential writes
    this.writeQueues.set(transferId, Promise.resolve());
    
    // Initialize pending chunks map for out-of-order handling
    this.pendingChunks.set(transferId, new Map());
    
    return { transferId, state };
  }

  /**
   * Setup file writer - MUST be called from user gesture
   * @param {string} transferId - Transfer ID
   * @param {string} suggestedName - Suggested file name
   */
  async setupFileWriter(transferId, suggestedName) {
    const state = this.activeTransfers.get(transferId);
    if (!state) throw new Error('Transfer not found');

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggestedName || state.fileName,
          types: [{
            description: 'All Files',
            accept: { '*/*': [] }
          }]
        });
        
        const writable = await handle.createWritable();
        state.fileHandle = handle;
        state.writable = writable;
        state.useFileSystemAPI = true;
        
        console.log('[FileReceiver] File System API ready');
        return { success: true, method: 'filesystem' };
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error('File save cancelled by user');
        }
        console.warn('[FileReceiver] File System API failed:', err);
      }
    }

    // Fallback to in-memory
    state.useFileSystemAPI = false;
    state.memoryChunks = new Array(state.totalChunks).fill(null);
    console.log('[FileReceiver] Using in-memory fallback');
    return { success: true, method: 'memory' };
  }

  /**
   * Queue a write operation to ensure sequential execution
   * @param {string} transferId - Transfer ID
   * @param {Function} writeOperation - Async write operation
   */
  async queueWrite(transferId, writeOperation) {
    const currentQueue = this.writeQueues.get(transferId) || Promise.resolve();
    const newQueue = currentQueue.then(writeOperation).catch(err => {
      console.error('[FileReceiver] Queued write failed:', err);
      throw err;
    });
    this.writeQueues.set(transferId, newQueue);
    return newQueue;
  }

  /**
   * Write chunks in order - buffers out-of-order chunks and writes sequentially
   * This avoids "state cached in an interface object" errors
   * @param {string} transferId - Transfer ID
   * @param {number} chunkIndex - Index of the chunk
   * @param {Uint8Array} chunkData - The chunk data
   */
  async writeChunkInOrder(transferId, chunkIndex, chunkData) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;
    
    const pending = this.pendingChunks.get(transferId);
    
    // If this is not the next expected chunk, buffer it
    if (chunkIndex !== state.nextExpectedChunk) {
      pending.set(chunkIndex, chunkData);
      return;
    }
    
    // Write this chunk and any buffered sequential chunks
    await this.queueWrite(transferId, async () => {
      // Write current chunk
      await state.writable.write(chunkData);
      state.bytesWritten += chunkData.length;
      state.nextExpectedChunk++;
      
      // Write any pending chunks that are now in order
      while (pending.has(state.nextExpectedChunk)) {
        const nextData = pending.get(state.nextExpectedChunk);
        pending.delete(state.nextExpectedChunk);
        await state.writable.write(nextData);
        state.bytesWritten += nextData.length;
        state.nextExpectedChunk++;
      }
    });
  }

  /**
   * Receive and process a chunk
   * @param {string} transferId - Transfer ID
   * @param {Object} chunkMeta - Chunk metadata
   * @param {Uint8Array} chunkData - Chunk binary data
   */
  async receiveChunk(transferId, chunkMeta, chunkData) {
    const state = this.activeTransfers.get(transferId);
    if (!state) {
      console.error('[FileReceiver] Transfer not found:', transferId);
      return { success: false, error: 'Transfer not found' };
    }

    const { chunkIndex, checksum, size, fileOffset, isFinal } = chunkMeta;

    try {
      // Validate checksum
      const calculatedChecksum = await this.calculateChecksum(chunkData);
      const isValid = calculatedChecksum === checksum;

      if (!isValid) {
        console.error(`[FileReceiver] Checksum mismatch for chunk ${chunkIndex}`);
        state.missingChunks.add(chunkIndex);
        
        // Store metadata for retry
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

      // Write chunk to file using sequential ordered writes
      if (state.useFileSystemAPI && state.writable) {
        // Make a copy of the data to avoid issues with buffer reuse
        const chunkDataCopy = new Uint8Array(chunkData);
        
        // Queue this chunk for ordered sequential writing
        await this.writeChunkInOrder(transferId, chunkIndex, chunkDataCopy);
      } else {
        // Store in memory array at correct position
        state.memoryChunks[chunkIndex] = new Uint8Array(chunkData);
      }

      // Update state
      state.receivedChunks.set(chunkIndex, { validated: true, checksum });
      state.bytesReceived += chunkData.length;
      state.lastChunkTime = Date.now();
      state.missingChunks.delete(chunkIndex);

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
        });
      }

      return { success: true, chunkIndex, progress };
    } catch (err) {
      console.error('[FileReceiver] Chunk receive error:', err);
      state.missingChunks.add(chunkIndex);
      return { success: false, error: err.message, chunkIndex };
    }
  }

  /**
   * Complete the transfer - finalize file and cleanup
   * @param {string} transferId - Transfer ID
   */
  async completeTransfer(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) {
      return { success: false, error: 'Transfer not found' };
    }

    try {
      // Wait for all queued writes to complete
      const writeQueue = this.writeQueues.get(transferId);
      if (writeQueue) {
        await writeQueue;
      }
      
      // Flush any remaining pending chunks (write them even if out of order)
      const pending = this.pendingChunks.get(transferId);
      if (pending && pending.size > 0) {
        console.warn(`[FileReceiver] Flushing ${pending.size} out-of-order chunks`);
        // Sort by chunk index and write remaining
        const sortedChunks = [...pending.entries()].sort((a, b) => a[0] - b[0]);
        for (const [idx, data] of sortedChunks) {
          if (state.useFileSystemAPI && state.writable) {
            await state.writable.write(data);
            state.bytesWritten += data.length;
          }
        }
        pending.clear();
      }

      // Check for missing chunks
      const missingChunks = this.getMissingChunks(transferId);
      if (missingChunks.length > 0) {
        console.warn(`[FileReceiver] Transfer has ${missingChunks.length} missing chunks`);
        // Still try to complete if we got most chunks
        if (missingChunks.length > state.totalChunks * 0.1) {
          return { 
            success: false, 
            error: 'Missing chunks', 
            missingChunks,
            canResume: true 
          };
        }
      }

      if (state.useFileSystemAPI && state.writable) {
        await state.writable.close();
        
        if (this.onComplete) {
          this.onComplete(transferId, {
            fileName: state.fileName,
            fileSize: state.fileSize,
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
            fileSize: state.fileSize,
            savedToFileSystem: false,
            url,
            blob,
            duration: Date.now() - state.startTime,
          });
        }
        
        return { success: true, savedToFileSystem: false, url, blob };
      }
    } catch (err) {
      console.error('[FileReceiver] Complete transfer error:', err);
      return { success: false, error: err.message };
    } finally {
      // Cleanup
      this.activeTransfers.delete(transferId);
    }
  }

  /**
   * Get list of missing chunk indices
   * @param {string} transferId - Transfer ID
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
   * Request retransmission of missing chunks
   * @param {string} transferId - Transfer ID
   * @param {Function} requestCallback - Called with array of missing chunk indices
   */
  async requestMissingChunks(transferId, requestCallback) {
    const missingChunks = this.getMissingChunks(transferId);
    if (missingChunks.length > 0 && requestCallback) {
      await requestCallback(missingChunks);
    }
    return missingChunks;
  }

  /**
   * Calculate SHA-256 checksum
   * @param {Uint8Array} data - Data to hash
   */
  async calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Cancel a transfer
   * @param {string} transferId - Transfer ID
   */
  async cancelTransfer(transferId) {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;

    try {
      if (state.writable) {
        await state.writable.abort();
      }
    } catch (err) {
      console.error('[FileReceiver] Cancel error:', err);
    }

    this.activeTransfers.delete(transferId);
  }

  /**
   * Get transfer state
   * @param {string} transferId - Transfer ID
   */
  getTransferState(transferId) {
    return this.activeTransfers.get(transferId);
  }

  /**
   * Resume a previously started transfer
   * @param {string} transferId - Transfer ID
   */
  async resumeTransfer(transferId) {
    // Get existing chunks from IndexedDB
    const existingChunks = await getChunksByTransfer(transferId);
    const validatedChunks = existingChunks.filter(c => c.validated && c.status === 'received');
    
    const state = this.activeTransfers.get(transferId);
    if (!state) return null;

    // Restore received chunks map
    for (const chunk of validatedChunks) {
      state.receivedChunks.set(chunk.chunkIndex, {
        validated: true,
        checksum: chunk.checksum,
      });
      state.bytesReceived += chunk.size;
    }

    const missingChunks = this.getMissingChunks(transferId);
    return {
      resumedChunks: validatedChunks.length,
      missingChunks,
      bytesReceived: state.bytesReceived,
    };
  }
}

// Singleton instance
export const fileReceiver = new FileReceiver();
