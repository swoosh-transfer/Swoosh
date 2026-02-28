/**
 * File Metadata Utilities
 * 
 * Functions for creating and managing file metadata.
 * Metadata includes file information used for transfer coordination.
 */

import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { validateFileMetadata, sanitizeFilename } from '../../lib/validators.js';
import { ValidationError } from '../../lib/errors.js';

/**
 * Generate UUID
 * 
 * Uses crypto.randomUUID if available, otherwise generates v4 UUID.
 * 
 * @returns {string} UUID
 */
export function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback UUID v4 generation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create file metadata object
 * 
 * Generates structured metadata from File object.
 * 
 * @param {File} file - File object
 * @returns {Object} File metadata
 * @throws {ValidationError} If file is invalid
 * 
 * @example
 * const meta = createFileMetadata(selectedFile);
 * // {
 * //   fileId: 'abc-123...',
 * //   name: 'document.pdf',
 * //   size: 1048576,
 * //   type: 'application/pdf',
 * //   ...
 * // }
 */
export function createFileMetadata(file) {
  if (!file || !(file instanceof File)) {
    throw new ValidationError('Invalid file object');
  }

  const metadata = {
    fileId: generateUUID(),
    name: sanitizeFilename(file.name),
    size: file.size,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
    chunkSize: STORAGE_CHUNK_SIZE,
    totalChunks: Math.ceil(file.size / STORAGE_CHUNK_SIZE),
    createdAt: Date.now(),
  };

  // Validate created metadata
  const validation = validateFileMetadata(metadata);
  if (!validation.valid) {
    throw new ValidationError('Generated invalid metadata', { 
      errors: validation.errors 
    });
  }

  return metadata;
}

/**
 * Create transfer record
 * 
 * Creates a transfer record that links file metadata to a transfer session.
 * 
 * @param {Object} options - Transfer options
 * @param {string} options.transferId - Transfer ID (generated if not provided)
 * @param {Object} options.fileMeta - File metadata
 * @param {string} options.peerId - Peer ID (optional)
 * @param {string} options.direction - 'send' or 'receive'
 * @returns {Object} Transfer record
 * 
 * @example
 * const transfer = createTransferRecord({
 *   fileMeta: fileMetadata,
 *   peerId: 'peer-abc',
 *   direction: 'send'
 * });
 */
export function createTransferRecord({ transferId, fileMeta, peerId, direction = 'send' }) {
  return {
    transferId: transferId || generateUUID(),
    fileId: fileMeta.fileId,
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type,
    chunkSize: fileMeta.chunkSize,
    totalChunks: fileMeta.totalChunks,
    direction, // 'send' or 'receive'
    sentChunks: 0,
    receivedChunks: 0,
    status: 'pending', // pending | in-progress | paused | completed | failed | cancelled
    peerId: peerId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Calculate transfer progress
 * 
 * @param {number} chunksCompleted - Chunks sent/received
 * @param {number} totalChunks - Total chunks
 * @returns {Object} Progress information
 */
export function calculateProgress(chunksCompleted, totalChunks) {
  const percentage = totalChunks > 0 ? (chunksCompleted / totalChunks) * 100 : 0;
  
  return {
    completed: chunksCompleted,
    total: totalChunks,
    remaining: totalChunks - chunksCompleted,
    percentage: Math.min(100, Math.max(0, percentage)),
    isComplete: chunksCompleted >= totalChunks,
  };
}

/**
 * Estimate time remaining
 * 
 * @param {number} chunksCompleted - Chunks completed so far
 * @param {number} totalChunks - Total chunks
 * @param {number} elapsedMs - Time elapsed in milliseconds
 * @returns {number|null} Estimated ms remaining, or null if can't estimate
 */
export function estimateTimeRemaining(chunksCompleted, totalChunks, elapsedMs) {
  if (chunksCompleted === 0) return null;
  
  const remaining = totalChunks - chunksCompleted;
  const msPerChunk = elapsedMs / chunksCompleted;
  
  return Math.round(remaining * msPerChunk);
}
