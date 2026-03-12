/**
 * Connection Heartbeat Monitor
 * 
 * Monitors peer connection health using periodic heartbeat messages.
 * Detects stale connections early and triggers reconnection attempts.
 * 
 * Features:
 * - Periodic heartbeat messages (every 10 seconds)
 * - RTT-adaptive timeout (adjusts to real network latency)
 * - Stale connection detection (3 missed heartbeats)
 * - Automatic ICE restart trigger on connection loss
 * - Event-based notifications for connection status changes
 */

import { MESSAGE_TYPE } from '../constants/messages.constants.js';
import logger from './logger.js';
import { notifyHeartbeatLost, notifyHeartbeatRecovered } from './transferNotifications.js';

/** Heartbeat interval in milliseconds (10 seconds) */
const HEARTBEAT_INTERVAL = 10000;

/** Maximum missed heartbeats before considering connection stale */
const MAX_MISSED_HEARTBEATS = 3;

/** Minimum heartbeat timeout regardless of RTT (15 seconds) */
const MIN_HEARTBEAT_TIMEOUT = 15000;

/** Default heartbeat timeout before RTT is measured */
const DEFAULT_HEARTBEAT_TIMEOUT = 20000;

/** Number of RTT samples to keep for rolling average */
const RTT_HISTORY_SIZE = 10;

/** RTT multiplier for adaptive timeout (timeout = avg RTT * multiplier) */
const RTT_TIMEOUT_MULTIPLIER = 5;

export class HeartbeatMonitor {
  constructor() {
    this.activeMonitors = new Map(); // roomId -> monitor state
    this._onLostCallbacks = new Set();
    this._onRestoredCallbacks = new Set();
  }

  /**
   * Start heartbeat monitoring for a connection
   * 
   * @param {string} roomId - Room identifier
   * @param {Function} sendMessage - Function to send heartbeat messages
   */
  start(roomId, sendMessage) {
    if (this.activeMonitors.has(roomId)) {
      logger.warn(`[Heartbeat] Monitor already active for room ${roomId}`);
      return;
    }

    const monitorState = {
      roomId,
      sendMessage,
      lastHeartbeatSent: Date.now(),
      lastHeartbeatReceived: Date.now(),
      missedHeartbeats: 0,
      isConnected: true,
      intervalId: null,
      // RTT tracking for adaptive timeout
      rttHistory: [],
      averageRtt: 0,
      adaptiveTimeout: DEFAULT_HEARTBEAT_TIMEOUT,
      pendingHeartbeatTimestamp: null,
    };

    // Start periodic heartbeat
    monitorState.intervalId = setInterval(() => {
      this._sendHeartbeat(roomId);
    }, HEARTBEAT_INTERVAL);

    this.activeMonitors.set(roomId, monitorState);
    logger.log(`[Heartbeat] Monitoring started for room ${roomId}`);

    // Send initial heartbeat
    this._sendHeartbeat(roomId);
  }

  /**
   * Stop heartbeat monitoring
   * 
   * @param {string} roomId - Room identifier
   */
  stop(roomId) {
    const monitor = this.activeMonitors.get(roomId);
    if (!monitor) {
      return;
    }

    if (monitor.intervalId) {
      clearInterval(monitor.intervalId);
    }

    this.activeMonitors.delete(roomId);
    logger.log(`[Heartbeat] Monitoring stopped for room ${roomId}`);
  }

  /**
   * Record received heartbeat from peer.
   * Handles both HEARTBEAT (from peer) and HEARTBEAT_ACK (response to ours).
   * 
   * @param {string} roomId - Room identifier
   * @param {number} [originalTimestamp] - Timestamp from HEARTBEAT_ACK to calculate RTT
   */
  recordHeartbeat(roomId, originalTimestamp) {
    const monitor = this.activeMonitors.get(roomId);
    if (!monitor) {
      return;
    }

    const wasDisconnected = !monitor.isConnected;
    const now = Date.now();
    
    monitor.lastHeartbeatReceived = now;
    monitor.missedHeartbeats = 0;
    monitor.isConnected = true;

    // Calculate RTT if this is an ACK with our original timestamp
    if (originalTimestamp && originalTimestamp > 0) {
      const rtt = now - originalTimestamp;
      if (rtt > 0 && rtt < 30000) { // Sanity check (0-30s)
        monitor.rttHistory.push(rtt);
        if (monitor.rttHistory.length > RTT_HISTORY_SIZE) {
          monitor.rttHistory.shift();
        }
        // Calculate rolling average RTT
        monitor.averageRtt = Math.round(
          monitor.rttHistory.reduce((sum, v) => sum + v, 0) / monitor.rttHistory.length
        );
        // Adaptive timeout: RTT * multiplier, but never below minimum
        monitor.adaptiveTimeout = Math.max(
          MIN_HEARTBEAT_TIMEOUT,
          monitor.averageRtt * RTT_TIMEOUT_MULTIPLIER
        );
        logger.log(`[Heartbeat] RTT=${rtt}ms avg=${monitor.averageRtt}ms timeout=${monitor.adaptiveTimeout}ms`);
      }
    }

    // Notify if connection was restored
    if (wasDisconnected) {
      logger.log(`[Heartbeat] Connection restored for room ${roomId}`);
      notifyHeartbeatRecovered();
      for (const cb of this._onRestoredCallbacks) {
        try { cb(roomId); } catch (e) { logger.error('[Heartbeat] onRestored callback error:', e); }
      }
    }
  }

  /**
   * Send heartbeat message to peer
   * @private
   */
  _sendHeartbeat(roomId) {
    const monitor = this.activeMonitors.get(roomId);
    if (!monitor) {
      return;
    }

    try {
      const timestamp = Date.now();
      
      // Send heartbeat message with timestamp for RTT measurement
      monitor.sendMessage({
        type: MESSAGE_TYPE.HEARTBEAT,
        timestamp,
      });

      monitor.lastHeartbeatSent = timestamp;
      monitor.pendingHeartbeatTimestamp = timestamp;

      // Check if we've received a heartbeat recently (using adaptive timeout)
      const timeSinceLastReceived = timestamp - monitor.lastHeartbeatReceived;
      
      if (timeSinceLastReceived > monitor.adaptiveTimeout) {
        monitor.missedHeartbeats++;
        
        // Check if connection should be considered stale
        if (monitor.missedHeartbeats >= MAX_MISSED_HEARTBEATS && monitor.isConnected) {
          monitor.isConnected = false;
          logger.warn(`[Heartbeat] Connection appears stale for room ${roomId} (${monitor.missedHeartbeats} missed, timeout=${monitor.adaptiveTimeout}ms)`);
          notifyHeartbeatLost();
          
          for (const cb of this._onLostCallbacks) {
            try { cb(roomId); } catch (e) { logger.error('[Heartbeat] onLost callback error:', e); }
          }
        }
      }
    } catch (error) {
      logger.error(`[Heartbeat] Failed to send heartbeat for room ${roomId}:`, error);
    }
  }

  /**
   * Get current measured RTT for a room
   * @param {string} roomId
   * @returns {number} average RTT in ms, or 0 if not yet measured
   */
  getRtt(roomId) {
    const monitor = this.activeMonitors.get(roomId);
    return monitor?.averageRtt || 0;
  }

  /**
   * Get connection status for a room
   * 
   * @param {string} roomId - Room identifier
   * @returns {Object} Connection status
   */
  getStatus(roomId) {
    const monitor = this.activeMonitors.get(roomId);
    if (!monitor) {
      return {
        monitoring: false,
        connected: false,
        missedHeartbeats: 0,
        rtt: 0,
      };
    }

    return {
      monitoring: true,
      connected: monitor.isConnected,
      missedHeartbeats: monitor.missedHeartbeats,
      lastHeartbeatSent: monitor.lastHeartbeatSent,
      lastHeartbeatReceived: monitor.lastHeartbeatReceived,
      timeSinceLastReceived: Date.now() - monitor.lastHeartbeatReceived,
      rtt: monitor.averageRtt,
      adaptiveTimeout: monitor.adaptiveTimeout,
    };
  }

  /**
   * Check if connection is healthy
   * 
   * @param {string} roomId - Room identifier
   * @returns {boolean} True if connection is healthy
   */
  isHealthy(roomId) {
    const monitor = this.activeMonitors.get(roomId);
    return monitor ? monitor.isConnected : false;
  }

  /**
   * Subscribe to connection loss events.
   * 
   * @param {Function} callback - Called with (roomId) when connection is lost
   * @returns {Function} Unsubscribe function
   */
  onLost(callback) {
    this._onLostCallbacks.add(callback);
    return () => this._onLostCallbacks.delete(callback);
  }

  /**
   * Subscribe to connection restoration events.
   * 
   * @param {Function} callback - Called with (roomId) when connection is restored
   * @returns {Function} Unsubscribe function
   */
  onRestored(callback) {
    this._onRestoredCallbacks.add(callback);
    return () => this._onRestoredCallbacks.delete(callback);
  }

  /**
   * Cleanup all monitors
   */
  cleanup() {
    for (const roomId of this.activeMonitors.keys()) {
      this.stop(roomId);
    }
  }
}

// Export singleton instance
export const heartbeatMonitor = new HeartbeatMonitor();

export default heartbeatMonitor;
