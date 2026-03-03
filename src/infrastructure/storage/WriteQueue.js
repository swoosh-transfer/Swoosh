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
    
    // Log early out-of-order arrivals
    if (chunkIndex < 10 && chunkIndex > this.nextExpected) {
      logger.log(`[WriteQueue] Early chunk ${chunkIndex} buffered (waiting for ${this.nextExpected}, ${this.queue.size} pending)`);
    }
    
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

        // Log early chunks to diagnose  corruption
        if (this.nextExpected < 10) {
          logger.log(`[WriteQueue] Writing early chunk ${this.nextExpected} (${data.byteLength} bytes, total written: ${this.bytesWritten})`);
        }

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
   * Wait for queue to be empty and all pending writes to complete.
   * Useful before closing the file.
   * 
   * Note: This waits for consecutive chunks from start to be written.
   * If there's a missing chunk, it will write everything up to the gap,
   * then timeout after MAX_FLUSH_WAIT and log any stuck chunks.
   * 
   * @param {number} timeoutMs - Max time to wait for missing chunks (default 500ms)
   * @returns {Promise<void>}
   */
  async flush(timeoutMs = 5000) {
    const startTime = Date.now();
    let lastProgressTime = startTime;
    let lastProgress = this.nextExpected;

    while (this.queue.size > 0 || this.processing) {
      // Check timeout — BUT keep going if we're still making progress (active writes)
      const elapsed = Date.now() - startTime;
      const stalled = elapsed > timeoutMs && (Date.now() - lastProgressTime > Math.min(timeoutMs, 3000));
      if (stalled) {
        // True stall: no progress for the timeout duration or 3s
        const stuckChunks = this.getPendingChunks();
        if (stuckChunks.length > 0) {
          logger.warn(`[WriteQueue] Flush timeout after ${elapsed}ms: ${stuckChunks.length} chunks stuck in buffer`);
          logger.warn(`[WriteQueue] Stuck chunks: ${stuckChunks.slice(0, 10).join(', ')}${stuckChunks.length > 10 ? '...' : ''}`);
          logger.warn(`[WriteQueue] Written so far: ${this.nextExpected} chunks, bytes: ${this.bytesWritten}`);
        }
        break;
      }

      // Wait for ongoing processing to finish
      if (this.processing) {
        await new Promise(resolve => setTimeout(resolve, 5));
        continue;
      }
      
      // If queue is empty, we're done
      if (this.queue.size === 0) break;
      
      // Process queue (writes consecutive chunks from nextExpected)
      await this.processQueue();
      
      // Track progress
      if (this.nextExpected > lastProgress) {
        lastProgress = this.nextExpected;
        lastProgressTime = Date.now();
      }
      
      // If processQueue didn't process anything (gap exists)
      if (this.nextExpected === lastProgress && this.queue.size > 0) {
        // No progress - there's a gap, wait briefly for missing chunk
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  /**
   * Force-flush remaining buffered chunks skipping any gaps.
   * WARNING: This will write out-of-order chunks and can corrupt sequential files!
   * Only use when you know remaining chunks are meant to be appended.
   * 
   * @returns {Promise<number>} Number of chunks force-written
   */
  async forceFlush() {
    const remaining = Array.from(this.queue.keys()).sort((a, b) => a - b);
    let written = 0;

    for (const chunkIndex of remaining) {
      const data = this.queue.get(chunkIndex);
      if (data) {
        try {
          await this.writable.write(new Uint8Array(data));
          this.bytesWritten += data.byteLength;
          this.queue.delete(chunkIndex);
          written++;
        } catch (err) {
          logger.error(`[WriteQueue] Force-flush error at chunk ${chunkIndex}:`, err);
          break;
        }
      }
    }

    if (written > 0) {
      logger.log(`[WriteQueue] Force-flushed ${written} buffered chunks`);
    }
    return written;
  }

  /**
   * Clear queue (for cancellation/cleanup)
   */
  clear() {
    this.queue.clear();
  }
}
