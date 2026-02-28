/**
 * Write Queue
 * 
 * Sequential write queue for File System Access API.
 * Handles out-of-order chunk arrival by buffering and writing in sequence.
 * 
 * Browser File System Access API requires sequential writes to avoid
 * "state cached in an interface object" errors. This queue ensures chunks
 * are written in order even when they arrive out of order over the network.
 */

import logger from '../../utils/logger.js';

export class WriteQueue {
  /**
   * @param {FileSystemWritableFileStream} writable - Writable stream
   */
  constructor(writable) {
    this.writable = writable;
    this.queue = new Map(); // chunkIndex -> data
    this.nextExpected = 0;
    this.processing = false;
    this.bytesWritten = 0;
  }

  /**
   * Add chunk to queue and process if possible
   * 
   * Automatically writes sequential chunks when available.
   * Buffers out-of-order chunks until their predecessors arrive.
   * 
   * @param {number} chunkIndex - Chunk index
   * @param {ArrayBuffer} data - Chunk data
   * @returns {Promise<Object>} Write result with index and size
   */
  async add(chunkIndex, data) {
    this.queue.set(chunkIndex, data);
    await this.processQueue();
    
    return { 
      chunkIndex, 
      size: data.byteLength, 
      bytesWritten: this.bytesWritten 
    };
  }

  /**
   * Process queue and write sequential chunks
   * 
   * Writes all consecutive chunks starting from nextExpected.
   * Stops when a gap is encountered (missing chunk).
   */
  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      // Write chunks in order
      while (this.queue.has(this.nextExpected)) {
        const data = this.queue.get(this.nextExpected);
        this.queue.delete(this.nextExpected);

        // Simple sequential append - no position tracking needed
        await this.writable.write(new Uint8Array(data));
        this.bytesWritten += data.byteLength;
        this.nextExpected++;
      }
    } catch (err) {
      logger.error('[WriteQueue] Write error:', err);
      throw err;
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get queue progress
   * 
   * @returns {Object} Progress stats
   */
  getProgress() {
    return {
      written: this.nextExpected,
      pending: this.queue.size,
      bytesWritten: this.bytesWritten,
    };
  }

  /**
   * Check if a specific chunk has been written
   * 
   * @param {number} chunkIndex - Chunk index to check
   * @returns {boolean}
   */
  isChunkWritten(chunkIndex) {
    return chunkIndex < this.nextExpected;
  }

  /**
   * Check if chunk is in queue (not yet written)
   * 
   * @param {number} chunkIndex - Chunk index to check
   * @returns {boolean}
   */
  isChunkPending(chunkIndex) {
    return this.queue.has(chunkIndex);
  }

  /**
   * Get next expected chunk index
   * 
   * @returns {number}
   */
  getNextExpected() {
    return this.nextExpected;
  }

  /**
   * Get pending chunk indices
   * 
   * @returns {number[]} Array of pending chunk indices
   */
  getPendingChunks() {
    return Array.from(this.queue.keys());
  }

  /**
   * Clear queue (for cancellation/cleanup)
   */
  clear() {
    this.queue.clear();
  }
}
