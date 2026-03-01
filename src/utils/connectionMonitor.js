/**
 * Connection Health Monitor
 * 
 * Monitors WebRTC connection quality by polling RTCPeerConnection statistics.
 * Tracks round-trip time (RTT) and packet loss for connection health.
 */

import logger from './logger.js';
import { CONNECTION_MONITOR_INTERVAL } from '../constants/timing.constants.js';

let monitorInterval = null;

/**
 * Start periodic monitoring of WebRTC connection statistics
 * 
 * Polls RTCPeerConnection.getStats() to extract:
 * - Round-trip time (RTT) in milliseconds
 * - Packet loss percentage
 * 
 * @param {RTCPeerConnection} pc - Active WebRTC peer connection
 * @param {Function} onStats - Callback receiving { rtt: number, packetLoss: string }
 * 
 * @example
 * startHealthMonitoring(peerConnection, ({ rtt, packetLoss }) => {
 *   console.log(`RTT: ${rtt}ms, Loss: ${packetLoss}%`);
 * });
 */
export function startHealthMonitoring(pc, onStats) {
  if (monitorInterval) clearInterval(monitorInterval);

  monitorInterval = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return;

    try {
      const stats = await pc.getStats();
      let rtt = 0;
      let packetsLost = 0;
      let packetsTotal = 0;

      stats.forEach(report => {
        // Calculate Round Trip Time from candidate pair
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = report.currentRoundTripTime * 1000; // convert to ms
        }
        
        // Calculate Packet Loss from inbound RTP
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          packetsLost = report.packetsLost;
          packetsTotal = report.packetsReceived + report.packetsLost;
        }
      });

      const packetLossPct = packetsTotal > 0 ? ((packetsLost / packetsTotal) * 100).toFixed(2) : 0;

      if (onStats) {
        onStats({ 
          rtt: Math.round(rtt), 
          packetLoss: packetLossPct 
        });
      }

    } catch (err) {
      logger.error("Stats monitoring error:", err);
    }
  }, CONNECTION_MONITOR_INTERVAL);
}

/**
 * Stop connection health monitoring
 * 
 * Clears the monitoring interval and stops collecting statistics.
 * 
 * @example
 * stopHealthMonitoring();
 */
export function stopHealthMonitoring() {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = null;
}

/**
 * Get current connection health snapshot.
 * Returns cached stats from last monitoring interval.
 * 
 * @param {RTCPeerConnection} pc - Active WebRTC peer connection
 * @returns {Promise<Object>} Health stats { rtt, packetLoss, connectionState }
 */
export async function getConnectionHealth(pc) {
  if (!pc) return { rtt: 0, packetLoss: '0', connectionState: 'closed' };
  
  const stats = { rtt: 0, packetLoss: '0', connectionState: pc.connectionState };
  try {
    const report = await pc.getStats();
    report.forEach(entry => {
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
        stats.rtt = entry.currentRoundTripTime ? entry.currentRoundTripTime * 1000 : 0;
      }
      if (entry.type === 'inbound-rtp') {
        const lost = entry.packetsLost || 0;
        const received = entry.packetsReceived || 0;
        const total = lost + received;
        stats.packetLoss = total > 0 ? ((lost / total) * 100).toFixed(1) : '0';
      }
    });
  } catch (err) {
    logger.error('Error getting connection health:', err);
  }
  return stats;
}