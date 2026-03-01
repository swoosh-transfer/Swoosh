/**
 * Message Type Constants
 * 
 * Protocol message types used for peer-to-peer communication.
 * These messages are sent over the WebRTC DataChannel or signaling server.
 */

/**
 * Message Types Enum
 */
export const MESSAGE_TYPE = {
  // Connection & Handshake
  HANDSHAKE: 'handshake',
  
  // File Transfer Setup
  FILE_METADATA: 'file-metadata',
  CHUNK_METADATA: 'chunk-metadata',
  CHUNK_DATA: 'chunk-data',
  RECEIVER_READY: 'receiver-ready',
  
  // Transfer Control
  TRANSFER_COMPLETE: 'transfer-complete',
  TRANSFER_PAUSED: 'transfer-paused',
  TRANSFER_RESUMED: 'transfer-resumed',
  TRANSFER_CANCELLED: 'transfer-cancelled',
  
  // Chunk Management
  REQUEST_CHUNKS: 'request-chunks',
  MISSING_CHUNKS: 'missing-chunks',
  
  // Error Handling
  TRANSFER_ERROR: 'transfer-error',
  
  // Multi-File Transfer
  MULTI_FILE_MANIFEST: 'multi-file-manifest',
  FILE_START: 'file-start',
  FILE_COMPLETE: 'file-complete',
  TRANSFER_MODE: 'transfer-mode',

  // Multi-Channel
  CHANNEL_READY: 'channel-ready',

  // Keep-alive
  PING: 'ping',
  PONG: 'pong'
};

// Alias for backward compatibility
export const MESSAGE_TYPES = MESSAGE_TYPE;

/**
 * Signaling Event Types
 * Events exchanged between client and signaling server via Socket.IO.
 */
export const SIGNALING_EVENT = {
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  USER_JOINED: 'user-joined',
  USER_LEFT: 'user-left',
  ROOM_FULL: 'room-full',
  ROOM_DISMISSED: 'room-dismissed',
  LEAVE_ROOM: 'leave-room',
  ROOM_LEFT: 'room-left',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  ERROR: 'error',
};

/**
 * Signaling Error Codes
 */
export const ERROR_CODE = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
};

/**
 * Connection State Types
 */
export const CONNECTION_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
};

/**
 * Security Verification Status
 * With encrypted signaling, verification is implicit:
 * 'pending' → 'verified' once the data channel opens.
 */
export const SECURITY_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
};

// Backward-compatible alias
export const TOFU_STATUS = SECURITY_STATUS;
