/**
 * Bandwidth Tester Utility
 * 
 * Measures internet speed via WebRTC DataChannel using small test packets.
 * Runs a quick 1-2 second test to determine optimal initial chunk size for transfers.
 * 
 * Usage:
 * const tester = new BandwidthTester(dataChannel);
 * const bandwidth = await tester.measureBandwidth();
 * // Returns: { bytesPerSecond, recommendedChunkSize, testDuration }
 */

import logger from './logger.js';
import {
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  INITIAL_CHUNK_SIZE,
  SPEED_HIGH_THRESHOLD,
  SPEED_LOW_THRESHOLD,
  SPEED_ADJUSTMENT_INCREMENT
} from '../constants/transfer.constants.js';

export class BandwidthTester {
  constructor(dataChannel) {
    this.dataChannel = dataChannel;
    this.testStartTime = null;
    this.testBytesTransferred = 0;
    this.testPacketCount = 0;
    this.isTestRunning = false;
  }

  /**
   * Measure bandwidth using test packets
   * Runs for ~1-2 seconds, sending small test packets and measuring throughput
   * 
   * @param {Object} options - Test options
   * @param {number} options.testDuration - Test duration in milliseconds (default: 1500)
   * @param {number} options.packetSize - Size of each test packet in bytes (default: 8KB)
   * @returns {Promise<Object>} - { bytesPerSecond, recommendedChunkSize, testDuration, status }
   */
  async measureBandwidth(options = {}) {
    const testDuration = options.testDuration || 1500; // 1.5 seconds
    const packetSize = options.packetSize || 8 * 1024; // 8KB packets

    if (this.isTestRunning) {
      logger.warn('[BandwidthTester] Test already running');
      return { status: 'already-running', bytesPerSecond: 0 };
    }

    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      logger.warn('[BandwidthTester] DataChannel not ready');
      return {
        status: 'channel-not-ready',
        bytesPerSecond: 0,
        recommendedChunkSize: INITIAL_CHUNK_SIZE
      };
    }

    this.isTestRunning = true;
    this.testBytesTransferred = 0;
    this.testPacketCount = 0;
    this.testStartTime = Date.now();

    try {
      // Create a test packet
      const testData = new Uint8Array(packetSize);
      crypto.getRandomValues(testData); // Fill with random data

      // Send packets for the specified duration
      const testPromise = new Promise((resolve) => {
        const intervalId = setInterval(() => {
          const elapsed = Date.now() - this.testStartTime;

          if (elapsed >= testDuration) {
            clearInterval(intervalId);
            resolve();
            return;
          }

          // Send test packet if channel can buffer it
          if (this.dataChannel.bufferedAmount < 1024 * 1024) { // 1MB buffer limit
            try {
              this.dataChannel.send(testData);
              this.testBytesTransferred += packetSize;
              this.testPacketCount++;
            } catch (err) {
              logger.warn('[BandwidthTester] Failed to send test packet:', err);
            }
          }
        }, 10); // Send packets every 10ms
      });

      await testPromise;

      const actualDuration = Date.now() - this.testStartTime;
      const bytesPerSecond = Math.round((this.testBytesTransferred / actualDuration) * 1000);
      const recommendedChunkSize = this._getRecommendedChunkSize(bytesPerSecond);

      const result = {
        status: 'success',
        bytesPerSecond,
        kilobytesPerSecond: Math.round(bytesPerSecond / 1024),
        megabytesPerSecond: (bytesPerSecond / (1024 * 1024)).toFixed(2),
        recommendedChunkSize,
        testDuration: actualDuration,
        packetsTransferred: this.testPacketCount
      };

      logger.log(
        `[BandwidthTester] Test complete: ${result.kilobytesPerSecond} KB/s, ` +
        `recommended chunk size: ${result.recommendedChunkSize / 1024}KB`
      );

      return result;
    } catch (err) {
      logger.error('[BandwidthTester] Test failed:', err);
      return {
        status: 'error',
        error: err.message,
        bytesPerSecond: 0,
        recommendedChunkSize: INITIAL_CHUNK_SIZE
      };
    } finally {
      this.isTestRunning = false;
    }
  }

  /**
   * Determine recommended chunk size based on measured bandwidth
   * Uses speed thresholds to map bandwidth to optimal chunk size
   * 
   * @private
   * @param {number} bytesPerSecond - Measured bandwidth
   * @returns {number} - Recommended chunk size in bytes
   */
  _getRecommendedChunkSize(bytesPerSecond) {
    if (bytesPerSecond >= SPEED_HIGH_THRESHOLD) {
      // Fast connection: use larger chunks
      return Math.min(MAX_CHUNK_SIZE, INITIAL_CHUNK_SIZE * 2);
    } else if (bytesPerSecond >= SPEED_HIGH_THRESHOLD / 2) {
      // Good connection: use initial chunk size
      return INITIAL_CHUNK_SIZE;
    } else if (bytesPerSecond >= SPEED_LOW_THRESHOLD) {
      // Moderate connection: use slightly smaller chunks
      return Math.max(MIN_CHUNK_SIZE, Math.floor(INITIAL_CHUNK_SIZE * 0.75));
    } else {
      // Slow connection: use minimum chunk size
      return MIN_CHUNK_SIZE;
    }
  }

  /**
   * Get the speed band description for display
   * Useful for UI messaging ("Testing connection speed...")
   * 
   * @param {number} bytesPerSecond - Bandwidth in bytes per second
   * @returns {string} - Human-readable speed description
   */
  static getSpeedDescription(bytesPerSecond) {
    const mbps = (bytesPerSecond / (1024 * 1024)).toFixed(1);

    if (bytesPerSecond >= SPEED_HIGH_THRESHOLD) {
      return `Fast (${mbps} Mbps)`;
    } else if (bytesPerSecond >= SPEED_HIGH_THRESHOLD / 2) {
      return `Good (${mbps} Mbps)`;
    } else if (bytesPerSecond >= SPEED_LOW_THRESHOLD) {
      return `Moderate (${mbps} Mbps)`;
    } else {
      return `Slow (${mbps} Mbps)`;
    }
  }
}

/**
 * Factory function to create and run bandwidth test
 * 
 * @param {RTCDataChannel} dataChannel - The DataChannel to test on
 * @param {Object} options - Test options
 * @returns {Promise<Object>} - Test results
 */
export async function testBandwidth(dataChannel, options = {}) {
  const tester = new BandwidthTester(dataChannel);
  return tester.measureBandwidth(options);
}
