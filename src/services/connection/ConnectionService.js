/**
 * Connection Service
 * 
 * Manages WebRTC peer-to-peer connection lifecycle.
 * Provides event-based API for UI layer, wraps complexity of signaling and P2P management.
 * 
 * Event-based architecture:
 * - Emit events for state changes
 * - UI subscribes to events
 * - No tight coupling between connection logic and UI
 * 
 * @example
 * const connectionService = new ConnectionService();
 * 
 * connectionService.on('connected', (peerId) => {
 *   console.log('Connected to peer:', peerId);
 * });
 * 
 * connectionService.on('dataChannelReady', (channel) => {
 *   console.log('Data channel ready for transfers');
 * });
 * 
 * await connectionService.createRoom();
 * await connectionService.joinRoom(roomId, secret);
 */

import { 
  initSocket, 
  createRoom, 
  joinRoom, 
  leaveRoom,
  onReconnect,
  offReconnect,
  setupSignalingListeners
} from '../../utils/signaling.js';
import { 
  initializePeerConnection,
  createOffer,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  closePeerConnection,
  getConnectionState,
  getDataChannel,
  getPeerConnection,
  setPolite
} from '../../utils/p2pManager.js';
import { 
  startHealthMonitoring, 
  stopHealthMonitoring, 
  getConnectionHealth 
} from '../../utils/connectionMonitor.js';
import logger from '../../utils/logger.js';
import { ConnectionError } from '../../lib/errors.js';
import { 
  CONNECTION_TIMEOUT, 
  RECONNECT_MAX_ATTEMPTS 
} from '../../constants/network.constants.js';

/**
 * Connection states
 */
export const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
  CLOSED: 'closed'
};

/**
 * Connection Service
 * Orchestrates signaling and peer connection management
 */
export class ConnectionService {
  constructor() {
    this.socket = null;
    this.roomId = null;
    this.peerId = null;
    this.dataChannel = null;
    this.state = ConnectionState.DISCONNECTED;
    this.role = null; // 'host' or 'guest'
    
    // Event listeners
    this.eventListeners = new Map();
    
    // Reconnection tracking
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    
    // Bound handlers for cleanup
    this.boundReconnectHandler = this._handleReconnect.bind(this);
  }

  /**
   * Subscribe to connection events
   * 
   * Events:
   * - 'stateChange': (state) => {}
   * - 'connected': (peerId) => {}
   * - 'disconnected': (reason) => {}
   * - 'dataChannelReady': (channel) => {}
   * - 'dataChannelMessage': (data) => {}
   * - 'healthUpdate': (stats) => {}
   * - 'error': (error) => {}
   * - 'reconnecting': (attempt) => {}
   * - 'reconnected': () => {}
   * 
   * @param {string} event - Event name
   * @param {Function} callback - Event handler
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    
    this.eventListeners.get(event).add(callback);
    
    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(callback);
      }
    };
  }

  /**
   * Emit event to all subscribers
   * @private
   */
  _emit(event, ...args) {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    
    listeners.forEach(callback => {
      try {
        callback(...args);
      } catch (err) {
        logger.error(`[ConnectionService] Event handler error (${event}):`, err);
      }
    });
  }

  /**
   * Initialize socket connection
   */
  async initialize() {
    try {
      this.socket = initSocket();
      
      // Register reconnect handler
      onReconnect(this.boundReconnectHandler);
      
      logger.log('[ConnectionService] Initialized');
    } catch (err) {
      logger.error('[ConnectionService] Initialization error:', err);
      throw new ConnectionError('Failed to initialize connection', { cause: err });
    }
  }

  /**
   * Create a new room (host role)
   * 
   * @returns {Promise<Object>} Room information { roomId, peerId }
   */
  async createRoom() {
    if (!this.socket) {
      await this.initialize();
    }
    
    try {
      this._setState(ConnectionState.CONNECTING);
      
      const result = await createRoom(this.socket);
      
      this.roomId = result.roomId;
      this.peerId = result.peerId;
      this.role = 'host';
      
      // Setup peer connection
      await this._setupPeerConnection();
      
      // Setup signaling listeners (offer/answer/ICE exchange)
      this._setupSignalingListeners();
      
      // Host is impolite in perfect negotiation
      setPolite(false);
      
      logger.log('[ConnectionService] Room created:', this.roomId);
      
      return {
        roomId: this.roomId,
        peerId: this.peerId
      };
      
    } catch (err) {
      this._setState(ConnectionState.FAILED);
      logger.error('[ConnectionService] Failed to create room:', err);
      throw new ConnectionError('Failed to create room', { cause: err });
    }
  }

  /**
   * Join an existing room (guest role)
   * 
   * @param {string} roomId - Room ID to join
   * @returns {Promise<Object>} Connection information { roomId, peerId }
   */
  async joinRoom(roomId) {
    if (!this.socket) {
      await this.initialize();
    }
    
    try {
      this._setState(ConnectionState.CONNECTING);
      
      const result = await joinRoom(this.socket, roomId);
      
      this.roomId = roomId;
      this.peerId = result.peerId;
      this.role = 'guest';
      
      // Setup peer connection
      await this._setupPeerConnection();
      
      // Setup signaling listeners (offer/answer/ICE exchange)
      this._setupSignalingListeners();
      
      // Guest is polite in perfect negotiation
      setPolite(true);
      
      logger.log('[ConnectionService] Joined room:', this.roomId);
      
      return {
        roomId: this.roomId,
        peerId: this.peerId
      };
      
    } catch (err) {
      this._setState(ConnectionState.FAILED);
      logger.error('[ConnectionService] Failed to join room:', err);
      throw new ConnectionError('Failed to join room', { cause: err, roomId });
    }
  }

  /**
   * Leave the current room
   */
  async leave() {
    try {
      if (this.socket && this.roomId) {
        await leaveRoom(this.socket, this.roomId);
      }
      
      this._cleanup();
      this._setState(ConnectionState.DISCONNECTED);
      
      logger.log('[ConnectionService] Left room');
      
    } catch (err) {
      logger.error('[ConnectionService] Error leaving room:', err);
      throw new ConnectionError('Failed to leave room', { cause: err });
    }
  }

  /**
   * Send data through the data channel
   * 
   * @param {any} data - Data to send (will be JSON stringified if object)
   * @returns {Promise<boolean>} Success status
   */
  async send(data) {
    const channel = this.dataChannel || getDataChannel();
    if (!channel || channel.readyState !== 'open') {
      throw new ConnectionError('Data channel not ready', { 
        state: channel?.readyState 
      });
    }
    
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      channel.send(payload);
      return true;
    } catch (err) {
      logger.error('[ConnectionService] Failed to send data:', err);
      throw new ConnectionError('Failed to send data', { cause: err });
    }
  }

  /**
   * Send binary data through the data channel
   * 
   * @param {ArrayBuffer|Uint8Array} data - Binary data to send
   * @returns {Promise<boolean>} Success status
   */
  async sendBinary(data) {
    const channel = this.dataChannel || getDataChannel();
    if (!channel || channel.readyState !== 'open') {
      throw new ConnectionError('Data channel not ready', {
        state: channel?.readyState
      });
    }

    try {
      channel.send(data);
      return true;
    } catch (err) {
      logger.error('[ConnectionService] Failed to send binary data:', err);
      throw new ConnectionError('Failed to send binary data', { cause: err });
    }
  }

  /**
   * Get current connection state
   * 
   * @returns {Object} Connection state information
   */
  getState() {
    return {
      state: this.state,
      roomId: this.roomId,
      peerId: this.peerId,
      role: this.role,
      isConnected: this.state === ConnectionState.CONNECTED,
      dataChannelReady: this.dataChannel?.readyState === 'open',
      p2pState: getConnectionState()
    };
  }

  /**
   * Get connection health statistics
   * 
   * @returns {Promise<Object|null>} Health stats or null if not available
   */
  async getHealth() {
    try {
      return await getConnectionHealth();
    } catch (err) {
      logger.warn('[ConnectionService] Failed to get health stats:', err);
      return null;
    }
  }

  /**
   * Wait for data channel buffer to drain below threshold (backpressure).
   * @param {number} [threshold=65536] - Buffer threshold in bytes
   * @returns {Promise<void>}
   */
  async waitForDrain(threshold = 65536) {
    const channel = this.dataChannel || getDataChannel();
    if (!channel) return;
    if (channel.bufferedAmount <= threshold) return;

    return new Promise((resolve) => {
      const check = () => {
        if (!channel || channel.readyState !== 'open') {
          resolve();
          return;
        }
        if (channel.bufferedAmount <= threshold) {
          resolve();
        } else {
          setTimeout(check, 16);
        }
      };
      check();
    });
  }

  /**
   * Setup peer connection with event handlers
   * @private
   */
  async _setupPeerConnection() {
    const onChannelReady = (channel) => {
      this.dataChannel = channel;
      this._setState(ConnectionState.CONNECTED);
      this._emit('dataChannelReady', channel);
      
      // Setup message handler — supports both JSON strings and binary ArrayBuffers
      channel.onmessage = (event) => {
        const data = event.data;

        // Binary data (ArrayBuffer / Blob) — forward directly
        if (data instanceof ArrayBuffer) {
          this._emit('dataChannelMessage', data);
          return;
        }

        // String data — parse as JSON
        if (typeof data === 'string') {
          try {
            this._emit('dataChannelMessage', JSON.parse(data));
          } catch (err) {
            logger.error('[ConnectionService] Failed to parse message:', err);
          }
          return;
        }

        // Blob (unlikely with binaryType='arraybuffer', but handle gracefully)
        if (data instanceof Blob) {
          data.arrayBuffer().then(buf => {
            this._emit('dataChannelMessage', buf);
          });
          return;
        }

        logger.warn('[ConnectionService] Unknown message type:', typeof data);
      };
    };
    
    const onStateChange = (state) => {
      logger.log('[ConnectionService] P2P state change:', state);
      
      if (state === 'connected') {
        this._setState(ConnectionState.CONNECTED);
        this._emit('connected', this.peerId);
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
      } else if (state === 'disconnected') {
        this._setState(ConnectionState.DISCONNECTED);
        this._emit('disconnected', 'peer disconnected');
        this._handleDisconnection();
      } else if (state === 'failed') {
        this._setState(ConnectionState.FAILED);
        this._emit('disconnected', 'connection failed');
        this._handleDisconnection();
      }
    };
    
    const onStats = (stats) => {
      this._emit('healthUpdate', stats);
    };
    
    initializePeerConnection(
      this.socket,
      this.roomId,
      onChannelReady,
      onStateChange,
      onStats
    );
  }

  /**
   * Setup signaling listeners for WebRTC offer/answer/ICE exchange
   * @private
   */
  _setupSignalingListeners() {
    setupSignalingListeners({
      onUserJoined: (data) => {
        const userId = typeof data === 'object' ? data.userId : data;
        logger.log('[ConnectionService] User joined:', userId);
        this._emit('peerJoined', userId);
        // Host creates offer when guest joins
        if (this.role === 'host') {
          createOffer(this.socket, this.roomId, (channel) => {
            this.dataChannel = channel;
            this._emit('dataChannelReady', channel);
          });
        }
      },
      onUserLeft: (data) => {
        const userId = data?.userId;
        logger.log('[ConnectionService] User left:', userId);
        this._emit('peerLeft', userId);
      },
      onOffer: (offer) => {
        handleOffer(offer, this.socket, this.roomId);
      },
      onAnswer: (answer) => {
        handleAnswer(answer);
      },
      onIceCandidate: (candidate) => {
        handleIceCandidate(candidate);
      }
    });
  }

  /**
   * Handle disconnection and potential reconnection
   * @private
   */
  _handleDisconnection() {
    if (this.isReconnecting) return;
    
    if (this.reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
      this.isReconnecting = true;
      this.reconnectAttempts++;
      this._setState(ConnectionState.RECONNECTING);
      this._emit('reconnecting', this.reconnectAttempts);
      
      logger.log(`[ConnectionService] Attempting reconnect ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`);
    } else {
      logger.error('[ConnectionService] Max reconnection attempts reached');
      this._emit('error', new ConnectionError('Maximum reconnection attempts reached'));
    }
  }

  /**
   * Handle successful reconnection
   * @private
   */
  _handleReconnect(roomId) {
    logger.log('[ConnectionService] Reconnected to room:', roomId);
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this._emit('reconnected');
  }

  /**
   * Update connection state
   * @private
   */
  _setState(newState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      logger.log(`[ConnectionService] State: ${oldState} → ${newState}`);
      this._emit('stateChange', newState, oldState);
    }
  }

  /**
   * Cleanup resources
   * @private
   */
  _cleanup() {
    stopHealthMonitoring();
    closePeerConnection();
    offReconnect(this.boundReconnectHandler);
    
    this.dataChannel = null;
    this.roomId = null;
    this.peerId = null;
    this.role = null;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }

  /**
   * Destroy service and cleanup all resources
   */
  destroy() {
    this._cleanup();
    this.eventListeners.clear();
    this.socket = null;
    logger.log('[ConnectionService] Destroyed');
  }
}
