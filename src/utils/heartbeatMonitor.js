/**
 * Connection Heartbeat Monitor
 * 
 * Monitors peer connection health using periodic heartbeat messages.
 * Detects stale connections early and triggers reconnection attempts.
 * 
 * Features:
 * - Periodic heartbeat messages (every 10 seconds)
 * - Automatic reconnection detection
 * - Stale connection detection (2 missed heartbeats)
 * - Event-based notifications for connection status changes
 */

import { MESSAGE_TYPE } from '../constants/messages.constants.js';
import logger from './logger.js';
import { notifyHeartbeatLost, notifyHeartbeatRecovered } from './transferNotifications.js';

/** Heartbeat interval in milliseconds (10 seconds) */
const HEARTBEAT_INTERVAL = 10000;

/** Maximum missed heartbeats before considering connection stale */
const MAX_MISSED_HEARTBEATS = 2;

/** Heartbeat timeout (slightly more than interval to account for latency) */
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 1.5;

export class HeartbeatMonitor {
  constructor() {
    this.activeMonitors = new Map(); // roomId -> monitor state
    this.onConnectionLost = null; // Callback for connection loss
    this.onConnectionRestored = null; // Callback for connection restoration
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
   * Record received heartbeat from peer
   * 
   * @param {string} roomId - Room identifier
   */
  recordHeartbeat(roomId) {
    const monitor = this.activeMonitors.get(roomId);
    if (!monitor) {
      return;
    }

    const wasDisconnected = !monitor.isConnected;
    
    monitor.lastHeartbeatReceived = Date.now();
    monitor.missedHeartbeats = 0;
    monitor.isConnected = true;

    // Notify if connection was restored
    if (wasDisconnected) {
      logger.log(`[Heartbeat] Connection restored for room ${roomId}`);
      notifyHeartbeatRecovered();
      if (this.onConnectionRestored) {
        this.onConnectionRestored(roomId);
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
      // Send heartbeat message
      monitor.sendMessage({
        type: MESSAGE_TYPE.HEARTBEAT,
        timestamp: Date.now(),
      });

      monitor.lastHeartbeatSent = Date.now();

      // Check if we've received a heartbeat recently
      const timeSinceLastReceived = Date.now() - monitor.lastHeartbeatReceived;
      
      if (timeSinceLastReceived > HEARTBEAT_TIMEOUT) {
        monitor.missedHeartbeats++;
        
        // Check if connection should be considered stale
        if (monitor.missedHeartbeats >= MAX_MISSED_HEARTBEATS && monitor.isConnected) {
          monitor.isConnected = false;
          logger.warn(`[Heartbeat] Connection appears stale for room ${roomId} (${monitor.missedHeartbeats} missed heartbeats)`);
          notifyHeartbeatLost();
          
          if (this.onConnectionLost) {
            this.onConnectionLost(roomId);
          }
        }
      }
    } catch (error) {
      logger.error(`[Heartbeat] Failed to send heartbeat for room ${roomId}:`, error);
    }
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
      };
    }

    return {
      monitoring: true,
      connected: monitor.isConnected,
      missedHeartbeats: monitor.missedHeartbeats,
      lastHeartbeatSent: monitor.lastHeartbeatSent,
      lastHeartbeatReceived: monitor.lastHeartbeatReceived,
      timeSinceLastReceived: Date.now() - monitor.lastHeartbeatReceived,
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
   * Set callback for connection loss events
   * 
   * @param {Function} callback - Called with (roomId) when connection is lost
   */
  onLost(callback) {
    this.onConnectionLost = callback;
  }

  /**
   * Set callback for connection restoration events
   * 
   * @param {Function} callback - Called with (roomId) when connection is restored
   */
  onRestored(callback) {
    this.onConnectionRestored = callback;
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
