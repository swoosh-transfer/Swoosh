/**
 * Message Service
 * 
 * Handles P2P protocol messages - parsing, validation, and routing.
 * Decouples message handling from UI layer.
 * 
 * Message Types:
 * - handshake: Initial peer greeting
 * - file-metadata: File transfer metadata
 * - chunk-metadata: Chunk metadata
 * - chunk-data: Chunk binary data
 * - receiver-ready: Receiver ready confirmation
 * - transfer-complete: Transfer completion notification
 * - request-chunks: Request missing chunks
 * - transfer-paused: Transfer paused notification
 * - transfer-resumed: Transfer resumed notification
 * - transfer-cancelled: Transfer cancelled notification
 * 
 * @example
 * const messageService = new MessageService(connectionService, transferOrchestrator, securityService);
 * 
 * messageService.on('handshakeReceived', (data) => {
 *   console.log('Peer connected:', data.peerId);
 * });
 * 
 * messageService.on('fileOffered', (fileMetadata) => {
 *   // Prompt user to accept file
 * });
 */

import logger from '../../utils/logger.js';
import { ValidationError } from '../../lib/errors.js';
import { MESSAGE_TYPES } from '../../constants/messages.constants.js';

/**
 * Message Service
 * Protocol message handling and routing
 */
export class MessageService {
  constructor(connectionService, transferOrchestrator, securityService) {
    this.connectionService = connectionService;
    this.transferOrchestrator = transferOrchestrator;
    this.securityService = securityService;
    
    // Event listeners
    this.eventListeners = new Map();
    
    // Message handlers
    this.messageHandlers = new Map();
    this._registerHandlers();
    
    // Buffer for pairing chunk-metadata with subsequent binary data
    this._pendingChunkMetadata = null;
    
    // Listen to connection data channel messages
    this.unsubscribeConnection = this.connectionService.on('dataChannelMessage', 
      this._handleMessage.bind(this)
    );
  }

  /**
   * Subscribe to message events
   * 
   * Events:
   * - 'handshakeReceived': (data) => {}
   * - 'fileOffered': (fileMetadata) => {}
   * - 'chunkReceived': (chunkInfo) => {}
   * - 'transferComplete': (transferId) => {}
   * - 'transferPaused': (transferId) => {}
   * - 'transferResumed': (transferId) => {}
   * - 'transferCancelled': (transferId) => {}
   * - 'chunkRequestReceived': (chunkIndices) => {}
   * - 'messageError': (error) => {}
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
        logger.error(`[MessageService] Event handler error (${event}):`, err);
      }
    });
  }

  /**
   * Send a message to peer
   * 
   * @param {string} type - Message type
   * @param {Object} data - Message data
   * @returns {Promise<void>}
   */
  async send(type, data = {}) {
    try {
      const message = {
        type,
        timestamp: Date.now(),
        ...data
      };
      
      await this.connectionService.send(message);
      logger.log(`[MessageService] Sent ${type} message`);
      
    } catch (err) {
      logger.error(`[MessageService] Failed to send ${type} message:`, err);
      throw err;
    }
  }

  /**
   * Send handshake message
   * 
   * @param {string} peerId - Our peer ID
   * @param {Object} metadata - Additional metadata
   */
  async sendHandshake(peerId, metadata = {}) {
    await this.send(MESSAGE_TYPES.HANDSHAKE, {
      peerId,
      ...metadata
    });
  }

  /**
   * Send file metadata (offer file)
   * 
   * @param {string} transferId - Transfer ID
   * @param {Object} fileMetadata - File metadata
   */
  async sendFileMetadata(transferId, fileMetadata) {
    await this.send(MESSAGE_TYPES.FILE_METADATA, {
      transferId,
      fileMetadata
    });
  }

  /**
   * Send receiver ready confirmation
   * 
   * @param {string} transferId - Transfer ID
   */
  async sendReceiverReady(transferId) {
    await this.send(MESSAGE_TYPES.RECEIVER_READY, {
      transferId,
      ready: true
    });
  }

  /**
   * Send transfer complete notification
   * 
   * @param {string} transferId - Transfer ID
   */
  async sendTransferComplete(transferId) {
    await this.send(MESSAGE_TYPES.TRANSFER_COMPLETE, {
      transferId
    });
  }

  /**
   * Send transfer paused notification
   * 
   * @param {string} transferId - Transfer ID
   */
  async sendTransferPaused(transferId) {
    await this.send(MESSAGE_TYPES.TRANSFER_PAUSED, {
      transferId
    });
  }

  /**
   * Send transfer resumed notification
   * 
   * @param {string} transferId - Transfer ID
   */
  async sendTransferResumed(transferId) {
    await this.send(MESSAGE_TYPES.TRANSFER_RESUMED, {
      transferId
    });
  }

  /**
   * Send transfer cancelled notification
   * 
   * @param {string} transferId - Transfer ID
   */
  async sendTransferCancelled(transferId) {
    await this.send(MESSAGE_TYPES.TRANSFER_CANCELLED, {
      transferId
    });
  }

  /**
   * Request missing chunks for retransmission
   * 
   * @param {string} transferId - Transfer ID
   * @param {number[]} chunkIndices - Missing chunk indices
   */
  async requestChunks(transferId, chunkIndices) {
    await this.send(MESSAGE_TYPES.REQUEST_CHUNKS, {
      transferId,
      chunkIndices
    });
  }

  /**
   * Handle incoming message (JSON or binary)
   * @private
   */
  async _handleMessage(message) {
    try {
      // Handle binary data (ArrayBuffer) — pair with pending chunk metadata
      if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
        return await this._handleBinaryChunk(message);
      }

      // Parse string messages as JSON
      if (typeof message === 'string') {
        try {
          message = JSON.parse(message);
        } catch {
          throw new ValidationError('Invalid JSON message');
        }
      }

      // Validate message structure
      if (!message || typeof message !== 'object') {
        throw new ValidationError('Invalid message format');
      }
      
      if (!message.type) {
        throw new ValidationError('Message missing type field');
      }
      
      // Get handler for message type
      const handler = this.messageHandlers.get(message.type);
      
      if (!handler) {
        logger.warn(`[MessageService] No handler for message type: ${message.type}`);
        return;
      }
      
      // Execute handler
      await handler.call(this, message);
      
    } catch (err) {
      logger.error('[MessageService] Message handling error:', err);
      this._emit('messageError', err);
    }
  }

  /**
   * Handle incoming binary chunk data, paired with buffered metadata
   * @private
   */
  async _handleBinaryChunk(binaryData) {
    const metadata = this._pendingChunkMetadata;
    this._pendingChunkMetadata = null;

    if (!metadata) {
      logger.warn('[MessageService] Received binary data without preceding chunk-metadata');
      return;
    }

    const chunkData = binaryData instanceof ArrayBuffer ? binaryData : binaryData.buffer;

    // Route to transfer orchestrator with real binary data
    await this.transferOrchestrator.handleReceivedChunk(
      metadata.transferId,
      metadata.metadata,
      chunkData
    );

    this._emit('chunkReceived', {
      transferId: metadata.transferId,
      chunkIndex: metadata.metadata.chunkIndex
    });
  }

  /**
   * Register message handlers
   * @private
   */
  _registerHandlers() {
    this.messageHandlers.set(MESSAGE_TYPES.HANDSHAKE, this._handleHandshake);
    this.messageHandlers.set(MESSAGE_TYPES.FILE_METADATA, this._handleFileMetadata);
    this.messageHandlers.set(MESSAGE_TYPES.CHUNK_METADATA, this._handleChunkMetadata);
    this.messageHandlers.set(MESSAGE_TYPES.CHUNK_DATA, this._handleChunkData);
    this.messageHandlers.set(MESSAGE_TYPES.RECEIVER_READY, this._handleReceiverReady);
    this.messageHandlers.set(MESSAGE_TYPES.TRANSFER_COMPLETE, this._handleTransferComplete);
    this.messageHandlers.set(MESSAGE_TYPES.REQUEST_CHUNKS, this._handleRequestChunks);
    this.messageHandlers.set(MESSAGE_TYPES.TRANSFER_PAUSED, this._handleTransferPaused);
    this.messageHandlers.set(MESSAGE_TYPES.TRANSFER_RESUMED, this._handleTransferResumed);
    this.messageHandlers.set(MESSAGE_TYPES.TRANSFER_CANCELLED, this._handleTransferCancelled);
  }

  /**
   * Handle handshake message
   * @private
   */
  async _handleHandshake(message) {
    logger.log('[MessageService] Received handshake:', message.peerId);
    this._emit('handshakeReceived', {
      peerId: message.peerId,
      timestamp: message.timestamp
    });
  }

  /**
   * Handle file metadata (file offer)
   * @private
   */
  async _handleFileMetadata(message) {
    logger.log('[MessageService] Received file offer:', message.fileMetadata.name);
    this._emit('fileOffered', {
      transferId: message.transferId,
      fileMetadata: message.fileMetadata
    });
  }

  /**
   * Handle chunk metadata — buffer for pairing with subsequent binary data
   * @private
   */
  async _handleChunkMetadata(message) {
    // Buffer this metadata; the next binary message will be paired with it
    this._pendingChunkMetadata = {
      transferId: message.transferId,
      metadata: message.metadata
    };
    logger.log(`[MessageService] Buffered chunk metadata: ${message.metadata.chunkIndex}`);
  }

  /**
   * Handle chunk data (legacy JSON-based fallback)
   * @private
   * @deprecated Binary data now arrives via _handleBinaryChunk
   */
  async _handleChunkData(message) {
    logger.warn(`[MessageService] Received legacy JSON chunk data: ${message.chunkIndex}`);
    
    // Fallback: if chunk data somehow arrives as JSON, handle it
    await this.transferOrchestrator.handleReceivedChunk(
      message.transferId,
      { chunkIndex: message.chunkIndex, size: message.data?.length || 0 },
      message.data
    );
    
    this._emit('chunkReceived', {
      transferId: message.transferId,
      chunkIndex: message.chunkIndex
    });
  }

  /**
   * Handle receiver ready
   * @private
   */
  async _handleReceiverReady(message) {
    logger.log('[MessageService] Receiver ready for transfer:', message.transferId);
    this._emit('receiverReady', {
      transferId: message.transferId
    });
  }

  /**
   * Handle transfer complete
   * @private
   */
  async _handleTransferComplete(message) {
    logger.log('[MessageService] Transfer complete:', message.transferId);
    this._emit('transferComplete', {
      transferId: message.transferId
    });
  }

  /**
   * Handle chunk request (retransmission)
   * @private
   */
  async _handleRequestChunks(message) {
    logger.log('[MessageService] Chunk retransmission requested:', message.chunkIndices.length);
    this._emit('chunkRequestReceived', {
      transferId: message.transferId,
      chunkIndices: message.chunkIndices
    });
  }

  /**
   * Handle transfer paused
   * @private
   */
  async _handleTransferPaused(message) {
    logger.log('[MessageService] Transfer paused:', message.transferId);
    await this.transferOrchestrator.pause(message.transferId);
    this._emit('transferPaused', {
      transferId: message.transferId
    });
  }

  /**
   * Handle transfer resumed
   * @private
   */
  async _handleTransferResumed(message) {
    logger.log('[MessageService] Transfer resumed:', message.transferId);
    await this.transferOrchestrator.resume(message.transferId);
    this._emit('transferResumed', {
      transferId: message.transferId
    });
  }

  /**
   * Handle transfer cancelled
   * @private
   */
  async _handleTransferCancelled(message) {
    logger.log('[MessageService] Transfer cancelled:', message.transferId);
    await this.transferOrchestrator.cancel(message.transferId);
    this._emit('transferCancelled', {
      transferId: message.transferId
    });
  }

  /**
   * Destroy service and cleanup
   */
  destroy() {
    if (this.unsubscribeConnection) {
      this.unsubscribeConnection();
    }
    
    this.messageHandlers.clear();
    this.eventListeners.clear();
    
    logger.log('[MessageService] Destroyed');
  }
}
