/**
 * Chunk Validator
 * 
 * Validates received chunks for integrity, ordering, and completeness.
 * Provides checksum verification and duplicate detection.
 */

import logger from '../../utils/logger.js';
import { NETWORK_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { ValidationError } from '../../lib/errors.js';

export class ChunkValidator {
  constructor() {
    this.receivedChunks = new Map(); // transferId -> Set of chunk indices
  }

  /**
   * Initialize validation for a transfer
   * 
   * @param {string} transferId - Transfer ID
   * @param {number} totalChunks - Expected total chunks
   */
  initialize(transferId, totalChunks) {
    this.receivedChunks.set(transferId, new Set());
    logger.log(`[ChunkValidator] Initialized for ${transferId}: ${totalChunks} chunks expected`);
  }

  /**
   * Validate a received chunk
   * 
   * @param {string} transferId - Transfer ID
   * @param {Object} chunk - Chunk data
   * @param {number} chunk.index - Chunk index
   * @param {ArrayBuffer} chunk.data - Chunk data
   * @param {number} chunk.size - Chunk size
   * @param {string} [chunk.checksum] - Optional checksum
   * @param {number} totalChunks - Total expected chunks
   * @returns {Object} Validation result
   * @throws {ValidationError} If validation fails
   */
  async validate(transferId, chunk, totalChunks) {
    const { index, data, size, checksum } = chunk;

    // 1. Validate chunk index
    if (typeof index !== 'number' || index < 0 || index >= totalChunks) {
      throw new ValidationError(
        `Invalid chunk index ${index} (total: ${totalChunks})`,
        { transferId, chunkIndex: index, totalChunks }
      );
    }

    // 2. Check for duplicate
    const received = this.receivedChunks.get(transferId);
    if (!received) {
      throw new ValidationError(
        `Transfer not initialized: ${transferId}`,
        { transferId }
      );
    }

    if (received.has(index)) {
      return {
        valid: true,
        duplicate: true,
        chunkIndex: index,
      };
    }

    // 3. Validate data exists
    if (!data || !(data instanceof ArrayBuffer)) {
      throw new ValidationError(
        `Invalid chunk data at index ${index}`,
        { transferId, chunkIndex: index }
      );
    }

    // 4. Validate size
    const actualSize = data.byteLength;
    const isLastChunk = index === totalChunks - 1;
    
    if (!isLastChunk && actualSize > NETWORK_CHUNK_SIZE) {
      throw new ValidationError(
        `Chunk ${index} size ${actualSize} exceeds max ${NETWORK_CHUNK_SIZE}`,
        { transferId, chunkIndex: index, actualSize, maxSize: NETWORK_CHUNK_SIZE }
      );
    }

    if (size !== actualSize) {
      throw new ValidationError(
        `Chunk ${index} size mismatch: expected ${size}, got ${actualSize}`,
        { transferId, chunkIndex: index, expectedSize: size, actualSize }
      );
    }

    // 5. Verify checksum if provided
    if (checksum) {
      const actualChecksum = await this._calculateChecksum(data);
      if (actualChecksum !== checksum) {
        throw new ValidationError(
          `Chunk ${index} checksum mismatch`,
          { transferId, chunkIndex: index, expectedChecksum: checksum, actualChecksum }
        );
      }
    }

    // Mark as received
    received.add(index);

    return {
      valid: true,
      duplicate: false,
      chunkIndex: index,
      receivedCount: received.size,
      remainingCount: totalChunks - received.size,
      isComplete: received.size === totalChunks,
    };
  }

  /**
   * Check if a specific chunk was received
   * 
   * @param {string} transferId - Transfer ID
   * @param {number} chunkIndex - Chunk index
   * @returns {boolean} True if chunk was received
   */
  hasChunk(transferId, chunkIndex) {
    const received = this.receivedChunks.get(transferId);
    return received ? received.has(chunkIndex) : false;
  }

  /**
   * Get missing chunk indices
   * 
   * @param {string} transferId - Transfer ID
   * @param {number} totalChunks - Total expected chunks
   * @returns {number[]} Array of missing chunk indices
   */
  getMissingChunks(transferId, totalChunks) {
    const received = this.receivedChunks.get(transferId);
    if (!received) return [];

    const missing = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!received.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  /**
   * Get validation statistics
   * 
   * @param {string} transferId - Transfer ID
   * @param {number} totalChunks - Total expected chunks
   * @returns {Object} Validation stats
   */
  getStats(transferId, totalChunks) {
    const received = this.receivedChunks.get(transferId);
    if (!received) {
      return {
        totalChunks,
        receivedChunks: 0,
        missingChunks: totalChunks,
        percentComplete: 0,
        isComplete: false,
      };
    }

    const receivedCount = received.size;
    return {
      totalChunks,
      receivedChunks: receivedCount,
      missingChunks: totalChunks - receivedCount,
      percentComplete: (receivedCount / totalChunks) * 100,
      isComplete: receivedCount === totalChunks,
    };
  }

  /**
   * Mark chunks as received for resumption
   * 
   * Used when resuming a transfer to avoid re-receiving chunks.
   * 
   * @param {string} transferId - Transfer ID
   * @param {number[]} chunkIndices - Array of chunk indices
   */
  markReceived(transferId, chunkIndices) {
    let received = this.receivedChunks.get(transferId);
    if (!received) {
      received = new Set();
      this.receivedChunks.set(transferId, received);
    }

    chunkIndices.forEach(index => received.add(index));
    logger.log(`[ChunkValidator] Marked ${chunkIndices.length} chunks as received for ${transferId}`);
  }

  /**
   * Clear validation state for a transfer
   * 
   * @param {string} transferId - Transfer ID
   */
  clear(transferId) {
    this.receivedChunks.delete(transferId);
    logger.log(`[ChunkValidator] Cleared validation state for ${transferId}`);
  }

  /**
   * Calculate SHA-256 checksum (matches ChunkingEngine format)
   * 
   * @private
   * @param {ArrayBuffer} data - Chunk data
   * @returns {Promise<string>} Base64-encoded SHA-256 checksum
   */
  async _calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hashBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

// Export singleton instance
export const chunkValidator = new ChunkValidator();
