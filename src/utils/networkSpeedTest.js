/**
 * Network Speed Test
 *
 * Lightweight bandwidth measurement using the existing WebRTC data channel.
 * Sends a test payload and measures round-trip throughput.
 *
 * Designed to run once after peer connection is established
 * and cache results in localStorage for 24 hours.
 */
import logger from './logger.js';

const CACHE_KEY = 'swoosh-network-speed';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get cached speed test result if still valid.
 * @returns {Object|null} { downloadBps, uploadBps, rttMs, timestamp }
 */
export function getCachedSpeedResult() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const result = JSON.parse(raw);
    if (Date.now() - result.timestamp > CACHE_TTL) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Run a quick bandwidth estimate using an RTCDataChannel.
 *
 * Approach:
 *   1. Send a known-size binary payload on the channel.
 *   2. Wait for bufferedAmount to drain (= data is at least in OS socket buffer).
 *   3. Measure the time it took — gives a conservative upload throughput.
 *
 * For download estimation, the peer runs the same test in reverse.
 * If the channel isn't available, falls back to navigator.connection hints.
 *
 * @param {RTCDataChannel} channel  – An open data channel
 * @param {Object} [opts]
 * @param {number} [opts.payloadSize=262144] – bytes to send (default 256KB)
 * @param {number} [opts.timeoutMs=10000]     – abort after this many ms
 * @returns {Promise<{ uploadBps: number, rttMs: number }>}
 */
export async function measureChannelSpeed(channel, opts = {}) {
  const { payloadSize = 256 * 1024, timeoutMs = 10000 } = opts;

  if (!channel || channel.readyState !== 'open') {
    return fallbackEstimate();
  }

  const payload = new ArrayBuffer(payloadSize);

  const start = performance.now();

  try {
    channel.send(payload);

    // Wait for bufferedAmount to drain
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Speed test timeout')), timeoutMs);

      const check = () => {
        if (channel.bufferedAmount === 0) {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (channel.readyState !== 'open') {
          clearTimeout(timer);
          reject(new Error('Channel closed'));
          return;
        }
        setTimeout(check, 5);
      };
      check();
    });
  } catch (error) {
    logger.warn('[SpeedTest] Measurement failed:', error.message);
    return fallbackEstimate();
  }

  const elapsedMs = performance.now() - start;
  const uploadBps = Math.round((payloadSize * 1000) / elapsedMs);

  const result = {
    uploadBps,
    rttMs: Math.round(elapsedMs), // rough RTT proxy
    timestamp: Date.now(),
  };

  // Cache result
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch { /* ignore */ }

  logger.log(`[SpeedTest] Upload: ${(uploadBps / 1024 / 1024).toFixed(2)} MB/s over ${elapsedMs.toFixed(0)}ms`);
  return result;
}

/**
 * Fallback when data channel measurement isn't possible.
 * Uses navigator.connection effective type hints.
 * @returns {{ uploadBps: number, rttMs: number }}
 */
function fallbackEstimate() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const type = conn?.effectiveType || '4g';
  const rtt = conn?.rtt || 100;

  // Conservative estimates per effective type
  const estimates = {
    'slow-2g': 50 * 1024,    // 50 KB/s
    '2g': 100 * 1024,        // 100 KB/s
    '3g': 1 * 1024 * 1024,   // 1 MB/s
    '4g': 10 * 1024 * 1024,  // 10 MB/s
  };

  return {
    uploadBps: estimates[type] || 5 * 1024 * 1024,
    rttMs: rtt,
    timestamp: Date.now(),
  };
}

/**
 * Pick optimal chunk size based on measured speed.
 *
 * @param {number} bps – measured bytes per second
 * @returns {number} chunk size in bytes
 */
export function recommendChunkSize(bps) {
  if (bps < 500 * 1024) return 16 * 1024;   // <500 KB/s → 16KB
  if (bps < 2 * 1024 * 1024) return 64 * 1024;  // <2 MB/s → 64KB
  if (bps < 10 * 1024 * 1024) return 128 * 1024; // <10 MB/s → 128KB
  return 256 * 1024;                              // ≥10 MB/s → 256KB
}

/**
 * Pick optimal max channel count based on measured speed.
 *
 * @param {number} bps – measured bytes per second
 * @returns {number} channel count (1-8)
 */
export function recommendMaxChannels(bps) {
  const mbps = bps / (1024 * 1024);
  return Math.max(1, Math.min(8, Math.ceil(mbps / 2)));
}
