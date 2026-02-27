/**
 * Validation Utilities
 * 
 * Pure functions for validating data and inputs.
 */

/**
 * Validate file metadata object
 * 
 * @param {Object} metadata - File metadata to validate
 * @returns {{ valid: boolean, errors: string[] }}
 * 
 * @example
 * const result = validateFileMetadata({ 
 *   name: 'test.txt', 
 *   size: 1024, 
 *   type: 'text/plain' 
 * });
 */
export function validateFileMetadata(metadata) {
  const errors = [];
  
  if (!metadata) {
    errors.push('Metadata is required');
    return { valid: false, errors };
  }
  
  if (!metadata.name || typeof metadata.name !== 'string') {
    errors.push('Invalid or missing file name');
  }
  
  if (typeof metadata.size !== 'number' || metadata.size < 0) {
    errors.push('Invalid or missing file size');
  }
  
  if (metadata.type && typeof metadata.type !== 'string') {
    errors.push('Invalid file type');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitize filename for safe storage
 * 
 * Removes or replaces characters that might cause issues in file systems.
 * 
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename
 * 
 * @example
 * sanitizeFilename('my/file:name.txt')  // "my-file-name.txt"
 * sanitizeFilename('../../../etc/passwd') // "etc-passwd"
 */
export function sanitizeFilename(filename) {
  if (!filename) return 'untitled';
  
  // Remove path separators and dangerous characters
  return filename
    .replace(/[\/\\:*?"<>|]/g, '-')  // Replace invalid chars with dash
    .replace(/\.{2,}/g, '.')          // Replace multiple dots with single dot
    .replace(/^\.+/, '')              // Remove leading dots
    .trim()
    || 'untitled';
}

/**
 * Validate room ID format
 * 
 * @param {string} roomId - Room ID to validate
 * @returns {boolean}
 * 
 * @example
 * isValidRoomId('abc123')  // true
 * isValidRoomId('ab')      // false (too short)
 * isValidRoomId(null)      // false
 */
export function isValidRoomId(roomId) {
  if (!roomId || typeof roomId !== 'string') return false;
  
  // Room IDs should be alphanumeric and of reasonable length
  return /^[a-zA-Z0-9]{4,32}$/.test(roomId);
}

/**
 * Validate chunk ID
 * 
 * @param {number} chunkId - Chunk ID to validate
 * @param {number} totalChunks - Total number of chunks
 * @returns {boolean}
 */
export function isValidChunkId(chunkId, totalChunks) {
  return (
    typeof chunkId === 'number' &&
    Number.isInteger(chunkId) &&
    chunkId >= 0 &&
    chunkId < totalChunks
  );
}

/**
 * Check if value is a valid positive number
 * 
 * @param {*} value - Value to check
 * @returns {boolean}
 */
export function isPositiveNumber(value) {
  return typeof value === 'number' && !isNaN(value) && value > 0;
}

/**
 * Check if browser supports required features
 * 
 * @returns {{ supported: boolean, missing: string[] }}
 */
export function checkBrowserSupport() {
  const missing = [];
  
  if (!window.RTCPeerConnection) {
    missing.push('WebRTC (RTCPeerConnection)');
  }
  
  if (!window.indexedDB) {
    missing.push('IndexedDB');
  }
  
  if (!window.crypto || !window.crypto.subtle) {
    missing.push('Web Crypto API');
  }
  
  return {
    supported: missing.length === 0,
    missing,
  };
}
