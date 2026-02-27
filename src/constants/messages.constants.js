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
  
  // TOFU Security
  TOFU_CHALLENGE: 'tofu-challenge',
  TOFU_RESPONSE: 'tofu-response',
  TOFU_VERIFIED: 'tofu-verified',
  
  // File Transfer Setup
  FILE_METADATA: 'file-metadata',
  CHUNK_METADATA: 'chunk-metadata',
  RECEIVER_READY: 'receiver-ready',
  
  // Transfer Control
  TRANSFER_COMPLETE: 'transfer-complete',
  TRANSFER_PAUSED: 'transfer-paused',
  TRANSFER_RESUMED: 'transfer-resumed',
  TRANSFER_CANCELLED: 'transfer-cancelled',
  
  // Chunk Management
  REQUEST_CHUNKS: 'request-chunks',
  MISSING_CHUNKS: 'missing-chunks',
};

/**
 * Signaling Event Types
 */
export const SIGNALING_EVENT = {
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  ERROR: 'error',
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
 * TOFU Verification Status
 */
export const TOFU_STATUS = {
  PENDING: 'pending',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  FAILED: 'failed',
  TRUSTED: 'trusted',
  NEW_KEY: 'new_key',
};
