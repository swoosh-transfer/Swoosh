/**
 * BandwidthMonitor — tracks aggregate throughput across all channels
 * and recommends when to scale the channel count up or down.
 *
 * Usage:
 *   const monitor = new BandwidthMonitor();
 *   monitor.start();
 *   // call monitor.recordBytes(n) every time data is sent
 *   // periodically check monitor.getRecommendedChannelCount(currentCount)
 *   monitor.stop();
 */
import {
  CHANNEL_SCALE_UP_THRESHOLD,
  CHANNEL_SCALE_DOWN_THRESHOLD,
  CHANNEL_SCALE_INTERVAL,
  CHANNEL_SCALE_SUSTAIN_COUNT,
  MIN_CHANNELS,
  MAX_CHANNELS,
} from '../../constants/transfer.constants.js';
import logger from '../../utils/logger.js';

export class BandwidthMonitor {
  constructor() {
    this._bytesSinceLastTick = 0;
    this._currentBps = 0;           // bytes per second (smoothed)
    this._history = [];              // last N throughput samples
    this._intervalId = null;
    this._smoothingAlpha = 0.3;      // EMA smoothing factor
    this._sustainUpCount = 0;
    this._sustainDownCount = 0;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Start periodic sampling. */
  start() {
    if (this._intervalId) return;
    this._bytesSinceLastTick = 0;
    this._currentBps = 0;
    this._sustainUpCount = 0;
    this._sustainDownCount = 0;
    this._history = [];
    this._lastTickTime = Date.now();

    this._intervalId = setInterval(() => this._tick(), CHANNEL_SCALE_INTERVAL);
    logger.log('[BandwidthMonitor] Started');
  }

  /** Stop periodic sampling. */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    logger.log('[BandwidthMonitor] Stopped');
  }

  /** Reset all state. */
  reset() {
    this.stop();
    this._bytesSinceLastTick = 0;
    this._currentBps = 0;
    this._history = [];
    this._sustainUpCount = 0;
    this._sustainDownCount = 0;
  }

  // ─── Recording ────────────────────────────────────────────────────

  /**
   * Record bytes that were just sent or received.
   * Call this every time a chunk is transmitted.
   * @param {number} bytes
   */
  recordBytes(bytes) {
    this._bytesSinceLastTick += bytes;
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /** @returns {number} current smoothed bytes-per-second */
  get bytesPerSecond() {
    return this._currentBps;
  }

  /** @returns {number} megabits per second (rounded to 1 decimal) */
  get mbps() {
    return Math.round((this._currentBps * 8) / (1024 * 1024) * 10) / 10;
  }

  /** Should we add another channel? */
  shouldScaleUp() {
    return this._sustainUpCount >= CHANNEL_SCALE_SUSTAIN_COUNT;
  }

  /** Should we remove a channel? */
  shouldScaleDown() {
    return this._sustainDownCount >= CHANNEL_SCALE_SUSTAIN_COUNT;
  }

  /**
   * Get the recommended channel count given the current metrics.
   * @param {number} currentCount — how many data channels currently open
   * @returns {number} recommended count (clamped to MIN_CHANNELS..MAX_CHANNELS)
   */
  getRecommendedChannelCount(currentCount) {
    let target = currentCount;

    if (this.shouldScaleUp() && currentCount < MAX_CHANNELS) {
      target = Math.min(currentCount + 1, MAX_CHANNELS);
      this._sustainUpCount = 0; // reset after acting
    } else if (this.shouldScaleDown() && currentCount > MIN_CHANNELS) {
      target = Math.max(currentCount - 1, MIN_CHANNELS);
      this._sustainDownCount = 0;
    }

    return target;
  }

  // ─── Internals ────────────────────────────────────────────────────

  _tick() {
    const now = Date.now();
    const elapsed = Math.max((now - (this._lastTickTime || now)) / 1000, 0.1); // actual seconds
    this._lastTickTime = now;
    const instantBps = this._bytesSinceLastTick / elapsed;

    // Exponential moving average
    this._currentBps = this._currentBps === 0
      ? instantBps
      : this._smoothingAlpha * instantBps + (1 - this._smoothingAlpha) * this._currentBps;

    // Keep history for debugging (last 20 samples)
    this._history.push({ ts: Date.now(), bps: this._currentBps });
    if (this._history.length > 20) this._history.shift();

    // Evaluate sustained thresholds
    if (this._currentBps > CHANNEL_SCALE_UP_THRESHOLD) {
      this._sustainUpCount++;
      this._sustainDownCount = 0;
    } else if (this._currentBps < CHANNEL_SCALE_DOWN_THRESHOLD) {
      this._sustainDownCount++;
      this._sustainUpCount = 0;
    } else {
      // In the middle zone — reset both
      this._sustainUpCount = 0;
      this._sustainDownCount = 0;
    }

    this._bytesSinceLastTick = 0;

    logger.log(
      `[BandwidthMonitor] ${(this._currentBps / 1024 / 1024).toFixed(2)} MB/s` +
      ` | up:${this._sustainUpCount} down:${this._sustainDownCount}`
    );
  }
}
