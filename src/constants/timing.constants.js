/**
 * Timing Constants
 * 
 * Delays, intervals, and timeout values used throughout the application.
 * All values in milliseconds.
 */

/**
 * CHUNK_ARRIVAL_DELAY: 300ms
 * 
 * Wait time before checking for missing chunks after transfer completion signal.
 * Accounts for in-flight chunks that may still be arriving on the DataChannel.
 */
export const CHUNK_ARRIVAL_DELAY = 300;

/**
 * COMPLETION_RETRY_DELAY: 1000ms (1 second)
 * 
 * Delay between retry attempts when completing a transfer with pending operations.
 * Used when waiting for:
 * - Sequential write queue to flush
 * - Retransmitted chunks to arrive
 * - Final chunk validation
 */
export const COMPLETION_RETRY_DELAY = 1000;

/**
 * PENDING_CHUNKS_WAIT: 3000ms (3 seconds)
 * 
 * Maximum wait time for pending chunks in sequential write queue.
 * Longer than COMPLETION_RETRY_DELAY to handle out-of-order chunk writes.
 */
export const PENDING_CHUNKS_WAIT = 3000;

/**
 * FILE_WRITE_DELAY: 100ms
 * 
 * Small delay between file system write operations.
 * Reduces I/O pressure and allows browser event loop to process other tasks.
 */
export const FILE_WRITE_DELAY = 100;

/**
 * COPY_NOTIFICATION_DURATION: 2000ms (2 seconds)
 * 
 * Duration to show "Copied!" notification after copying to clipboard.
 */
export const COPY_NOTIFICATION_DURATION = 2000;

/**
 * PROGRESS_UPDATE_INTERVAL: 100ms
 * 
 * Frequency of progress bar updates during transfer.
 * Balance between smooth UI updates and performance.
 */
export const PROGRESS_UPDATE_INTERVAL = 100;

/**
 * CONNECTION_MONITOR_INTERVAL: 1000ms (1 second)
 * 
 * Interval for checking connection health and statistics.
 */
export const CONNECTION_MONITOR_INTERVAL = 1000;

/**
 * TOFU_VERIFICATION_TIMEOUT: 30000ms (30 seconds)
 * 
 * Maximum time to wait for TOFU security verification to complete.
 */
export const TOFU_VERIFICATION_TIMEOUT = 30 * 1000;

/**
 * RESUME_HANDSHAKE_TIMEOUT: 20 seconds
 *
 * Maximum time to wait for resume negotiation before falling back to fresh transfer.
 */
export const RESUME_HANDSHAKE_TIMEOUT = 20 * 1000;

/**
 * RESUME_REQUEST_RETRY_DELAY: 1.5 seconds
 *
 * Interval for re-sending resume request while waiting for peer session handshake.
 */
export const RESUME_REQUEST_RETRY_DELAY = 1500;
