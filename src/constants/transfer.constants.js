/**
 * Transfer and Chunking Constants
 * 
 * These constants define chunk sizes and buffer configurations for file transfers.
 * Different chunk sizes are used for different purposes to optimize performance.
 */

/**
 * NETWORK_CHUNK_SIZE: 16KB
 * 
 * Used for WebRTC DataChannel transmission.
 * Limited by browser DataChannel message size constraints.
 * Smaller chunks enable better real-time progress updates and adaptive bandwidth management.
 */
export const NETWORK_CHUNK_SIZE = 16 * 1024;

/**
 * STORAGE_CHUNK_SIZE: 64KB
 * 
 * Used for IndexedDB storage and file system operations.
 * Larger chunks reduce storage overhead and improve disk I/O performance.
 * Optimal size for browser IndexedDB and File System Access API.
 */
export const STORAGE_CHUNK_SIZE = 64 * 1024;

/**
 * Adaptive Chunk Size Limits
 * 
 * The ChunkingEngine adjusts chunk sizes dynamically based on network conditions.
 * - Fast connection: increases toward MAX_CHUNK_SIZE
 * - Slow connection: decreases toward MIN_CHUNK_SIZE
 * - Default: INITIAL_CHUNK_SIZE
 */
export const INITIAL_CHUNK_SIZE = 16 * 1024; // 16KB - starting size
export const MAX_CHUNK_SIZE = 32 * 1024;     // 32KB - ceiling for good connections
export const MIN_CHUNK_SIZE = 8 * 1024;      // 8KB - floor for poor connections

/**
 * BUFFER_SIZE: Maximum buffered chunks in memory
 * 
 * Limits the number of chunks held in memory before writing to storage.
 * Prevents excessive memory usage for large file transfers.
 */
export const BUFFER_SIZE = 100; // ~6.4MB with 64KB chunks

/**
 * Transfer State Constants
 */
export const TRANSFER_STATE = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  TRANSFERRING: 'transferring',
  PAUSED: 'paused',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
