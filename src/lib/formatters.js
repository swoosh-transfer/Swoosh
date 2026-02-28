/**
 * Formatting Utilities
 * 
 * Pure functions for formatting data for display.
 */

/**
 * Format bytes to human-readable string
 * 
 * Converts byte values into appropriate units (B, KB, MB, GB, TB) with 2 decimal places.
 * 
 * @param {number} bytes - The byte value to format
 * @returns {string} Formatted string with unit (e.g., "1.50 MB")
 * 
 * @example
 * formatBytes(0)          // "0 B"
 * formatBytes(1024)       // "1.00 KB"
 * formatBytes(1536)       // "1.50 KB"
 * formatBytes(1048576)    // "1.00 MB"
 * formatBytes(50000000000) // "46.57 GB"
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds to human-readable string
 * 
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "2h 30m", "45s")
 * 
 * @example
 * formatDuration(1000)      // "1s"
 * formatDuration(90000)     // "1m 30s"
 * formatDuration(3661000)   // "1h 1m"
 */
export function formatDuration(ms) {
  if (!ms || ms === 0) return '0s';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  
  return `${seconds}s`;
}

/**
 * Format transfer speed
 * 
 * @param {number} bytesPerSecond - Transfer speed in bytes per second
 * @returns {string} Formatted speed (e.g., "5.50 MB/s")
 * 
 * @example
 * formatSpeed(0)         // "0 B/s"
 * formatSpeed(1024)      // "1.00 KB/s"
 * formatSpeed(5242880)   // "5.00 MB/s"
 */
export function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Format percentage with fixed decimals
 * 
 * @param {number} value - Value between 0 and 100
 * @param {number} decimals - Number of decimal places (default: 1)
 * @returns {string} Formatted percentage (e.g., "75.5%")
 * 
 * @example
 * formatPercent(75.5)      // "75.5%"
 * formatPercent(75.567, 2) // "75.57%"
 * formatPercent(100)       // "100.0%"
 */
export function formatPercent(value, decimals = 1) {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format timestamp to readable date/time
 * 
 * @param {number | Date} timestamp - Unix timestamp (ms) or Date object
 * @returns {string} Formatted date/time
 * 
 * @example
 * formatTimestamp(Date.now()) // "Feb 27, 2026 3:45 PM"
 */
export function formatTimestamp(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Truncate string with ellipsis
 * 
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length before truncation
 * @returns {string} Truncated string with ellipsis if needed
 * 
 * @example
 * truncate("Hello World", 5)  // "Hello..."
 * truncate("Hi", 10)          // "Hi"
 */
export function truncate(str, maxLength) {
  if (!str || str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}
