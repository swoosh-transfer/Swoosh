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
  offReconnect
} from '../../utils/signaling.js';
import { 
  initializePeerConnection,
  createOffer,
  createAnswer,
  addAnswer,
  addIceCandidate,
  sendData,
  closePeerConnection,
  getConnectionState,
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
   * @param {any} data - Data to send (will be JSON stringified)
   * @returns {Promise<boolean>} Success status
   */
  async send(data) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new ConnectionError('Data channel not ready', { 
        state: this.dataChannel?.readyState 
      });
    }
    
    try {
      sendData(this.dataChannel, data);
      return true;
    } catch (err) {
      logger.error('[ConnectionService] Failed to send data:', err);
      throw new ConnectionError('Failed to send data', { cause: err });
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
   * Setup peer connection with event handlers
   * @private
   */
  async _setupPeerConnection() {
    const onChannelReady = (channel) => {
      this.dataChannel = channel;
      this._setState(ConnectionState.CONNECTED);
      this._emit('dataChannelReady', channel);
      
      // Setup message handler
      channel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this._emit('dataChannelMessage', data);
        } catch (err) {
          logger.error('[ConnectionService] Failed to parse message:', err);
        }
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
