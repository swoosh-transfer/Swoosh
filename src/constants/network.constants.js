/**
 * Network and Connection Constants
 * 
 * Timeout and retry configurations for WebRTC and signaling connections.
 */

/**
 * CONNECTION_TIMEOUT: 30 seconds
 * 
 * Maximum time to wait for WebRTC peer connection establishment.
 * Includes ICE candidate gathering and connection negotiation.
 */
export const CONNECTION_TIMEOUT = 30 * 1000;

/**
 * DATA_CHANNEL_TIMEOUT: 10 seconds
 * 
 * Maximum time to wait for DataChannel to open after peer connection.
 */
export const DATA_CHANNEL_TIMEOUT = 10 * 1000;

/**
 * SIGNALING_RECONNECT_DELAY: 2 seconds
 * 
 * Delay before attempting to reconnect to signaling server after disconnect.
 */
export const SIGNALING_RECONNECT_DELAY = 2 * 1000;

/**
 * MAX_RETRY_ATTEMPTS: 3
 * 
 * Maximum number of retry attempts for failed operations (chunk retransmission, etc.)
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * RECONNECT_MAX_ATTEMPTS: 5
 * 
 * Maximum number of reconnection attempts for P2P connection failures.
 */
export const RECONNECT_MAX_ATTEMPTS = 5;

/**
 * ICE Servers Configuration
 * 
 * STUN/TURN servers for NAT traversal and connection establishment.
 */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * WebRTC Configuration
 */
export const RTC_CONFIGURATION = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 10,
};
