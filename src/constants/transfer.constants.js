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
 * Speed Thresholds for Adaptive Chunking
 * 
 * Used by BandwidthTester and ChunkingEngine to determine optimal chunk sizes.
 * SPEED_HIGH_THRESHOLD: Threshold above which chunks increase (~1.5 MB/s)
 * SPEED_LOW_THRESHOLD: Threshold below which chunks decrease (~512 KB/s)
 * SPEED_ADJUSTMENT_INCREMENT: How much to adjust in each direction (10-20%)
 */
export const SPEED_HIGH_THRESHOLD = 1.5 * 1024 * 1024;  // 1.5 MB/s
export const SPEED_LOW_THRESHOLD = 512 * 1024;          // 512 KB/s
export const SPEED_ADJUSTMENT_INCREMENT = 0.15;          // 15% adjustment per step

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
// ============ MULTI-CHANNEL CONSTANTS ============

/**
 * Dynamic channel scaling — auto-detect optimal channel count based on bandwidth.
 * Starts with 1 channel, scales up to MAX_CHANNELS when throughput is high.
 */
export const MIN_CHANNELS = 1;
export const MAX_CHANNELS = 8;
export const INITIAL_CHANNELS = 1;

/**
 * Channel scaling thresholds.
 * CHANNEL_SCALE_UP_THRESHOLD: sustained throughput above this triggers adding a channel (~1.5 MB/s)
 * CHANNEL_SCALE_DOWN_THRESHOLD: sustained throughput below this triggers removing a channel (~500 KB/s)
 * CHANNEL_SCALE_INTERVAL: how often (ms) to evaluate scaling decisions
 * CHANNEL_SCALE_SUSTAIN_COUNT: how many consecutive intervals the threshold must be sustained
 */
export const CHANNEL_SCALE_UP_THRESHOLD = 1.5 * 1024 * 1024;   // 1.5 MB/s
export const CHANNEL_SCALE_DOWN_THRESHOLD = 500 * 1024;         // 500 KB/s
export const CHANNEL_SCALE_INTERVAL = 3000;                     // 3 seconds
export const CHANNEL_SCALE_SUSTAIN_COUNT = 1;                   // consecutive intervals

/** Prefix for data channel labels: file-transfer-0, file-transfer-1, etc. */
export const CHANNEL_LABEL_PREFIX = 'file-transfer-';

/** Low watermark for per-channel bufferedAmount before sending more data */
export const CHANNEL_BUFFER_LOW_WATERMARK = 64 * 1024;  // 64KB

/** High watermark — pause sending on a channel when bufferedAmount exceeds this */
export const CHANNEL_BUFFER_HIGH_WATERMARK = 256 * 1024; // 256KB

// ============ TRANSFER MODE ============

export const TRANSFER_MODE = {
  SEQUENTIAL: 'sequential',
  PARALLEL: 'parallel',
};

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
