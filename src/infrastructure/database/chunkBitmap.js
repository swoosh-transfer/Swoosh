/**
 * Chunk Completion Bitmap
 * 
 * Compact bit-level tracking of chunk completion status.
 * Uses 1 bit per chunk stored in a Uint8Array.
 * For a 50GB file at 64KB chunks (~781,250 chunks), the bitmap is ~96KB.
 * 
 * @module chunkBitmap
 */

/**
 * Create a new bitmap for tracking chunk completion.
 * 
 * @param {number} totalChunks - Total number of chunks to track
 * @returns {Uint8Array} Zeroed bitmap (all chunks incomplete)
 */
export function createBitmap(totalChunks) {
  if (totalChunks < 0 || !Number.isFinite(totalChunks)) {
    throw new Error(`Invalid totalChunks: ${totalChunks}`);
  }
  const byteCount = Math.ceil(totalChunks / 8);
  return new Uint8Array(byteCount);
}

/**
 * Mark a chunk as complete in the bitmap.
 * 
 * @param {Uint8Array} bitmap - The bitmap to mutate
 * @param {number} chunkIndex - Index of the chunk to mark complete
 */
export function markChunk(bitmap, chunkIndex) {
  const byteIndex = chunkIndex >>> 3; // Math.floor(chunkIndex / 8)
  const bitIndex = chunkIndex & 7;    // chunkIndex % 8
  bitmap[byteIndex] |= (1 << bitIndex);
}

/**
 * Check if a specific chunk is marked as complete.
 * 
 * @param {Uint8Array} bitmap - The bitmap to check
 * @param {number} chunkIndex - Index of the chunk to check
 * @returns {boolean} True if the chunk is complete
 */
export function isChunkComplete(bitmap, chunkIndex) {
  const byteIndex = chunkIndex >>> 3;
  const bitIndex = chunkIndex & 7;
  return (bitmap[byteIndex] & (1 << bitIndex)) !== 0;
}

/**
 * Count the number of completed chunks (popcount).
 * 
 * @param {Uint8Array} bitmap - The bitmap to count
 * @returns {number} Number of bits set to 1
 */
export function getCompletedCount(bitmap) {
  let count = 0;
  for (let i = 0; i < bitmap.length; i++) {
    // Brian Kernighan's bit counting
    let byte = bitmap[i];
    while (byte) {
      byte &= byte - 1;
      count++;
    }
  }
  return count;
}

/**
 * Get indices of all missing (incomplete) chunks.
 * 
 * @param {Uint8Array} bitmap - The bitmap to check
 * @param {number} totalChunks - Total expected chunk count
 * @returns {number[]} Array of missing chunk indices
 */
export function getMissingChunks(bitmap, totalChunks) {
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!isChunkComplete(bitmap, i)) {
      missing.push(i);
    }
  }
  return missing;
}

/**
 * Get the index of the first missing chunk.
 * 
 * @param {Uint8Array} bitmap - The bitmap to check
 * @param {number} totalChunks - Total expected chunk count
 * @returns {number} Index of first missing chunk, or -1 if all complete
 */
export function getFirstMissingChunk(bitmap, totalChunks) {
  for (let i = 0; i < totalChunks; i++) {
    if (!isChunkComplete(bitmap, i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Serialize bitmap to base64 string for IndexedDB storage.
 * 
 * @param {Uint8Array} bitmap - The bitmap to serialize
 * @returns {string} Base64-encoded string
 */
export function serializeBitmap(bitmap) {
  let binary = '';
  for (let i = 0; i < bitmap.length; i++) {
    binary += String.fromCharCode(bitmap[i]);
  }
  return btoa(binary);
}

/**
 * Deserialize a base64 string back into a bitmap.
 * 
 * @param {string} base64 - Base64-encoded bitmap string
 * @returns {Uint8Array} Deserialized bitmap
 */
export function deserializeBitmap(base64) {
  const binary = atob(base64);
  const bitmap = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bitmap[i] = binary.charCodeAt(i);
  }
  return bitmap;
}

/**
 * Mark all chunks as complete (e.g., for a fully completed file).
 * 
 * @param {Uint8Array} bitmap - The bitmap to mutate
 * @param {number} totalChunks - Total number of chunks
 */
export function markAllComplete(bitmap, totalChunks) {
  // Fill all full bytes with 0xFF
  const fullBytes = totalChunks >>> 3;
  for (let i = 0; i < fullBytes; i++) {
    bitmap[i] = 0xFF;
  }
  // Set remaining bits in the last byte
  const remainingBits = totalChunks & 7;
  if (remainingBits > 0) {
    bitmap[fullBytes] = (1 << remainingBits) - 1;
  }
}
