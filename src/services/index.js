/**
 * Services Module - Public API
 * 
 * Main entry point for all application services.
 * Provides composed AppService for easy integration with UI layer.
 * 
 * Service Architecture:
 * - ConnectionService: Manages WebRTC P2P connection
 * - SecurityService: Handles TOFU peer verification
 * - TransferOrchestrator: Coordinates file transfers
 * - MessageService: Protocol message handling and routing
 * 
 * @example
 * import { AppService } from './services';
 * 
 * const appService = new AppService();
 * await appService.initialize();
 * 
 * // Or use individual services
 * import { ConnectionService, TransferOrchestrator } from './services';
 */

import { ConnectionService } from './connection/ConnectionService.js';
import { SecurityService } from './security/SecurityService.js';
import { TransferOrchestrator } from './transfer/TransferOrchestrator.js';
import { MessageService } from './messaging/MessageService.js';
import { setEncryptionKey } from '../utils/signaling.js';
import logger from '../utils/logger.js';

/**
 * Application Service
 * 
 * Composes all services and provides unified API for UI layer.
 * Handles service lifecycle and inter-service communication.
 */
export class AppService {
  constructor() {
    // Initialize individual services
    this.connection = new ConnectionService();
    this.security = new SecurityService();
    this.transfer = new TransferOrchestrator(this.connection);
    this.messaging = new MessageService(this.connection, this.transfer, this.security);
    
    // Track initialization state
    this.initialized = false;
  }

  /**
   * Initialize all services
   * 
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      logger.warn('[AppService] Already initialized');
      return;
    }
    
    try {
      // Initialize connection service
      await this.connection.initialize();
      
      this.initialized = true;
      logger.log('[AppService] Initialized successfully');
      
    } catch (err) {
      logger.error('[AppService] Initialization failed:', err);
      throw err;
    }
  }

  /**
   * Create a new room (host)
   * 
   * @returns {Promise<Object>} Room information { roomId, peerId, secureUrl }
   */
  async createRoom() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Create security credentials
    const credentials = await this.security.createCredentials();
    
    // Bridge encryption key to signaling layer
    if (this.security.encryptionKey) {
      setEncryptionKey(this.security.encryptionKey);
    }
    
    // Create connection room
    const { roomId, peerId } = await this.connection.createRoom();
    
    // Generate secure URL with embedded credentials
    const baseUrl = window.location.origin + window.location.pathname;
    const secureUrl = this.security.createSecureURL(baseUrl, roomId);
    
    logger.log(`[AppService] Room created: ${roomId}`);
    
    return {
      roomId,
      peerId,
      secureUrl,
      credentials
    };
  }

  /**
   * Join an existing room (guest)
   * 
   * @param {string} url - Secure URL with embedded credentials
   * @returns {Promise<Object>} Connection information { roomId, peerId }
   */
  async joinRoom(url) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Extract security credentials from URL
    const extracted = this.security.extractFromURL(url);
    
    if (!extracted || !extracted.roomId) {
      throw new Error('Invalid room URL');
    }
    
    // Derive encryption key from extracted secret and bridge to signaling
    if (extracted.secret) {
      const { deriveEncryptionKey } = await import('../utils/tofuSecurity.js');
      this.security.encryptionKey = await deriveEncryptionKey(extracted.secret);
      setEncryptionKey(this.security.encryptionKey);
    }
    
    // Join connection room
    const { roomId, peerId } = await this.connection.joinRoom(extracted.roomId);
    
    logger.log(`[AppService] Joined room: ${roomId}`);
    
    return {
      roomId,
      peerId
    };
  }

  /**
   * Leave the current room
   * 
   * @returns {Promise<void>}
   */
  async leaveRoom() {
    await this.connection.leave();
    logger.log('[AppService] Left room');
  }

  /**
   * Get current application state
   * 
   * @returns {Object} Application state
   */
  getState() {
    return {
      initialized: this.initialized,
      connection: this.connection.getState(),
      security: this.security.getPeerStatus(),
      transfer: this.transfer.getTransferState()
    };
  }

  /**
   * Destroy all services and cleanup resources
   */
  destroy() {
    this.messaging.destroy();
    this.transfer.destroy();
    this.security.destroy();
    this.connection.destroy();
    
    this.initialized = false;
    logger.log('[AppService] Destroyed');
  }
}

// Export individual services for advanced usage
export { ConnectionService } from './connection/ConnectionService.js';
export { SecurityService } from './security/SecurityService.js';
export { TransferOrchestrator } from './transfer/TransferOrchestrator.js';
export { MessageService } from './messaging/MessageService.js';

// Export service-related enums and constants
export { ConnectionState } from './connection/ConnectionService.js';
export { VerificationState, TrustLevel } from './security/SecurityService.js';
export { TransferDirection, TransferStatus } from './transfer/TransferOrchestrator.js';
