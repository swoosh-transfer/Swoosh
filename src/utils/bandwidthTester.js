/**
 * Bandwidth Tester Utility
 * 
 * Measures P2P connection speed via WebRTC DataChannel using round-trip test packets.
 * Runs a quick 2-3 second test to determine optimal transfer settings.
 * 
 * Features:
 * - Round-trip latency measurement (RTT)
 * - Throughput measurement (bytes/second)
 * - Connection type detection (direct vs relay)
 * - Speed quality assessment
 * 
 * Usage:
 * const result = await runBandwidthTest(dataChannel, peerConnection, onProgress);
 */

import logger from './logger.js';
import {
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  INITIAL_CHUNK_SIZE,
  SPEED_HIGH_THRESHOLD,
  SPEED_LOW_THRESHOLD,
} from '../constants/transfer.constants.js';

/** Message types for bandwidth test protocol */
const TEST_MSG = {
  PING: 'bw-ping',
  PONG: 'bw-pong',
  DATA: 'bw-data',
  DATA_ACK: 'bw-data-ack',
  START: 'bw-start',
  RESULT: 'bw-result',
};

/**
 * Detect connection type from RTCPeerConnection stats
 * @param {RTCPeerConnection} pc
 * @returns {Promise<{type: string, isRelayed: boolean, localType: string, remoteType: string}>}
 */
export async function getConnectionType(pc) {
  if (!pc || pc.connectionState !== 'connected') {
    return { type: 'unknown', isRelayed: false, localType: 'unknown', remoteType: 'unknown' };
  }

  try {
    const stats = await pc.getStats();
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        const localCandidate = stats.get(report.localCandidateId);
        const remoteCandidate = stats.get(report.remoteCandidateId);
        
        const localType = localCandidate?.candidateType || 'unknown';
        const remoteType = remoteCandidate?.candidateType || 'unknown';
        const isRelayed = localType === 'relay' || remoteType === 'relay';
        
        let type = 'direct';
        if (isRelayed) {
          type = 'relay';
        } else if (localType === 'srflx' || remoteType === 'srflx') {
          type = 'nat-traversal';
        }
        
        return { type, isRelayed, localType, remoteType };
      }
    }
  } catch (err) {
    logger.error('[BandwidthTester] Failed to get connection type:', err);
  }
  
  return { type: 'unknown', isRelayed: false, localType: 'unknown', remoteType: 'unknown' };
}

/**
 * BandwidthTester class - handles round-trip bandwidth measurement
 */
export class BandwidthTester {
  constructor(dataChannel, peerConnection = null) {
    this.dataChannel = dataChannel;
    this.peerConnection = peerConnection;
    this.isTestRunning = false;
    this._pendingPings = new Map(); // id -> { timestamp, resolve }
    this._pendingDataAcks = new Map(); // id -> { timestamp, size, resolve }
    this._messageHandler = null;
    this._testResults = null;
  }

  /**
   * Run comprehensive bandwidth test
   * Measures RTT, throughput, and connection type
   * 
   * @param {Object} options
   * @param {number} options.testDuration - Duration in ms (default: 2500)
   * @param {number} options.packetSize - Test packet size (default: 32KB)
   * @param {Function} options.onProgress - Progress callback (phase, percent)
   * @returns {Promise<Object>} Test results
   */
  async runTest(options = {}) {
    const testDuration = options.testDuration || 2500;
    const packetSize = options.packetSize || 32 * 1024;
    const onProgress = options.onProgress || (() => {});

    if (this.isTestRunning) {
      return { status: 'already-running', error: 'Test already in progress' };
    }

    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      return { status: 'channel-not-ready', error: 'DataChannel not open' };
    }

    this.isTestRunning = true;
    this._setupMessageHandler();

    try {
      // Phase 1: Connection type detection (10%)
      onProgress('detecting', 10);
      const connectionType = this.peerConnection 
        ? await getConnectionType(this.peerConnection)
        : { type: 'unknown', isRelayed: false };

      // Phase 2: RTT measurement - send 5 pings (30%)
      onProgress('measuring-latency', 20);
      const rttResults = await this._measureRTT(5);
      onProgress('measuring-latency', 40);

      // Phase 3: Throughput test (70%)
      onProgress('measuring-speed', 50);
      const throughputResults = await this._measureThroughput(testDuration, packetSize, (pct) => {
        onProgress('measuring-speed', 50 + Math.floor(pct * 0.4));
      });

      // Phase 4: Calculate results (100%)
      onProgress('calculating', 95);

      const avgRtt = rttResults.length > 0 
        ? Math.round(rttResults.reduce((a, b) => a + b, 0) / rttResults.length)
        : 0;
      const minRtt = rttResults.length > 0 ? Math.min(...rttResults) : 0;
      const maxRtt = rttResults.length > 0 ? Math.max(...rttResults) : 0;

      const result = {
        status: 'success',
        // Connection info
        connectionType: connectionType.type,
        isRelayed: connectionType.isRelayed,
        localCandidateType: connectionType.localType,
        remoteCandidateType: connectionType.remoteType,
        // Latency
        rtt: avgRtt,
        minRtt,
        maxRtt,
        jitter: maxRtt - minRtt,
        // Throughput
        bytesPerSecond: throughputResults.bytesPerSecond,
        kilobytesPerSecond: Math.round(throughputResults.bytesPerSecond / 1024),
        megabytesPerSecond: (throughputResults.bytesPerSecond / (1024 * 1024)).toFixed(2),
        megabitsPerSecond: ((throughputResults.bytesPerSecond * 8) / (1024 * 1024)).toFixed(1),
        // Recommendations
        quality: this._getQualityRating(throughputResults.bytesPerSecond, avgRtt, connectionType.isRelayed),
        recommendedChunkSize: this._getRecommendedChunkSize(throughputResults.bytesPerSecond),
        estimatedTransferTime: (size) => this._estimateTransferTime(size, throughputResults.bytesPerSecond),
        // Raw data
        testDuration: throughputResults.duration,
        packetsTransferred: throughputResults.packets,
      };

      this._testResults = result;
      onProgress('complete', 100);

      logger.log(`[BandwidthTester] Test complete: ${result.megabitsPerSecond} Mbps, RTT: ${avgRtt}ms, Type: ${connectionType.type}`);
      return result;

    } catch (err) {
      logger.error('[BandwidthTester] Test failed:', err);
      return {
        status: 'error',
        error: err.message,
        bytesPerSecond: 0,
        recommendedChunkSize: INITIAL_CHUNK_SIZE,
      };
    } finally {
      this._cleanup();
      this.isTestRunning = false;
    }
  }

  /**
   * Measure round-trip time with ping/pong
   * @private
   */
  async _measureRTT(count = 5) {
    const results = [];
    
    for (let i = 0; i < count; i++) {
      try {
        const rtt = await this._sendPing(i, 2000);
        results.push(rtt);
        // Small delay between pings
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        logger.warn(`[BandwidthTester] Ping ${i} failed:`, err.message);
      }
    }
    
    return results;
  }

  /**
   * Send a ping and wait for pong
   * @private
   */
  _sendPing(id, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const timestamp = performance.now();
      
      const timeoutId = setTimeout(() => {
        this._pendingPings.delete(id);
        reject(new Error('Ping timeout'));
      }, timeout);
      
      this._pendingPings.set(id, { timestamp, resolve: (rtt) => {
        clearTimeout(timeoutId);
        resolve(rtt);
      }});
      
      this._sendMessage({ type: TEST_MSG.PING, id, ts: timestamp });
    });
  }

  /**
   * Measure throughput by sending test data
   * @private
   */
  async _measureThroughput(duration, packetSize, onProgress) {
    const startTime = Date.now();
    let bytesSent = 0;
    let packetsAcked = 0;
    let packetId = 0;
    
    // Create test data packet
    const testData = new Uint8Array(packetSize);
    crypto.getRandomValues(testData);
    
    // Send packets continuously for the duration
    while (Date.now() - startTime < duration) {
      // Check buffer - don't overwhelm
      if (this.dataChannel.bufferedAmount < 512 * 1024) {
        const id = packetId++;
        this._sendDataPacket(id, testData);
        bytesSent += packetSize;
      }
      
      // Update progress
      const elapsed = Date.now() - startTime;
      onProgress(elapsed / duration);
      
      // Small yield to allow ACKs to be processed
      await new Promise(r => setTimeout(r, 5));
    }
    
    // Wait a bit for final ACKs
    await new Promise(r => setTimeout(r, 200));
    
    const actualDuration = Date.now() - startTime;
    const bytesPerSecond = Math.round((bytesSent / actualDuration) * 1000);
    
    return {
      bytesPerSecond,
      duration: actualDuration,
      bytesSent,
      packets: packetId,
    };
  }

  /**
   * Send a data packet for throughput test
   * @private
   */
  _sendDataPacket(id, data) {
    // Send as binary with header
    const header = new TextEncoder().encode(JSON.stringify({ type: TEST_MSG.DATA, id }));
    const packet = new Uint8Array(header.length + 1 + data.length);
    packet.set(header);
    packet[header.length] = 0; // Null separator
    packet.set(data, header.length + 1);
    
    try {
      this.dataChannel.send(packet);
    } catch (err) {
      logger.warn('[BandwidthTester] Failed to send data packet:', err);
    }
  }

  /**
   * Send JSON message
   * @private
   */
  _sendMessage(obj) {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(obj));
    }
  }

  /**
   * Setup message handler for test responses
   * @private
   */
  _setupMessageHandler() {
    this._messageHandler = (event) => {
      try {
        // Handle binary data packets
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const nullIdx = bytes.indexOf(0);
          if (nullIdx > 0) {
            const headerStr = new TextDecoder().decode(bytes.slice(0, nullIdx));
            const header = JSON.parse(headerStr);
            if (header.type === TEST_MSG.DATA) {
              // Send ACK back
              this._sendMessage({ type: TEST_MSG.DATA_ACK, id: header.id });
            }
          }
          return;
        }
        
        // Handle JSON messages
        const msg = JSON.parse(event.data);
        
        switch (msg.type) {
          case TEST_MSG.PING:
            // Respond with pong immediately
            this._sendMessage({ type: TEST_MSG.PONG, id: msg.id, ts: msg.ts });
            break;
            
          case TEST_MSG.PONG:
            // Calculate RTT
            const pending = this._pendingPings.get(msg.id);
            if (pending) {
              const rtt = performance.now() - pending.timestamp;
              this._pendingPings.delete(msg.id);
              pending.resolve(rtt);
            }
            break;
            
          case TEST_MSG.DATA_ACK:
            // Data acknowledged
            const ackPending = this._pendingDataAcks.get(msg.id);
            if (ackPending) {
              this._pendingDataAcks.delete(msg.id);
              ackPending.resolve();
            }
            break;
        }
      } catch (err) {
        // Ignore non-test messages
      }
    };
    
    this.dataChannel.addEventListener('message', this._messageHandler);
  }

  /**
   * Cleanup message handler
   * @private
   */
  _cleanup() {
    if (this._messageHandler && this.dataChannel) {
      this.dataChannel.removeEventListener('message', this._messageHandler);
    }
    this._pendingPings.clear();
    this._pendingDataAcks.clear();
    this._messageHandler = null;
  }

  /**
   * Get quality rating based on speed, RTT, and connection type
   * @private
   */
  _getQualityRating(bytesPerSecond, rtt, isRelayed) {
    const mbps = bytesPerSecond / (1024 * 1024);
    
    if (isRelayed) {
      // Relayed connections are always limited
      if (mbps >= 0.5 && rtt < 200) return { rating: 'fair', label: 'Fair (Relayed)', color: 'amber' };
      return { rating: 'poor', label: 'Poor (Relayed)', color: 'red' };
    }
    
    if (mbps >= 5 && rtt < 50) {
      return { rating: 'excellent', label: 'Excellent', color: 'emerald' };
    } else if (mbps >= 2 && rtt < 100) {
      return { rating: 'good', label: 'Good', color: 'green' };
    } else if (mbps >= 0.5 && rtt < 200) {
      return { rating: 'fair', label: 'Fair', color: 'amber' };
    } else {
      return { rating: 'poor', label: 'Poor', color: 'red' };
    }
  }

  /**
   * Get recommended chunk size based on bandwidth
   * @private
   */
  _getRecommendedChunkSize(bytesPerSecond) {
    if (bytesPerSecond >= SPEED_HIGH_THRESHOLD) {
      return Math.min(MAX_CHUNK_SIZE, INITIAL_CHUNK_SIZE * 2);
    } else if (bytesPerSecond >= SPEED_HIGH_THRESHOLD / 2) {
      return INITIAL_CHUNK_SIZE;
    } else if (bytesPerSecond >= SPEED_LOW_THRESHOLD) {
      return Math.max(MIN_CHUNK_SIZE, Math.floor(INITIAL_CHUNK_SIZE * 0.75));
    } else {
      return MIN_CHUNK_SIZE;
    }
  }

  /**
   * Estimate transfer time for a given file size
   * @private
   */
  _estimateTransferTime(fileSize, bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond === 0) return Infinity;
    return Math.ceil(fileSize / bytesPerSecond);
  }

  /**
   * Get human-readable speed description
   * @static
   */
  static getSpeedDescription(bytesPerSecond) {
    const mbps = (bytesPerSecond * 8 / (1024 * 1024)).toFixed(1);
    
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
 * Run bandwidth test (convenience function)
 * 
 * @param {RTCDataChannel} dataChannel
 * @param {RTCPeerConnection} peerConnection
 * @param {Function} onProgress - (phase, percent) => void
 * @returns {Promise<Object>} Test results
 */
export async function runBandwidthTest(dataChannel, peerConnection = null, onProgress = null) {
  const tester = new BandwidthTester(dataChannel, peerConnection);
  return tester.runTest({ onProgress });
}

/**
 * Quick connection type check (no full bandwidth test)
 * @param {RTCPeerConnection} pc
 * @returns {Promise<Object>}
 */
export async function checkConnectionType(pc) {
  return getConnectionType(pc);
}

// Legacy export for backward compatibility
export async function testBandwidth(dataChannel, options = {}) {
  const tester = new BandwidthTester(dataChannel);
  return tester.runTest(options);
}
