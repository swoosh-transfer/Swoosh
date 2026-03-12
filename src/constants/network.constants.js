/**
 * Network and Connection Constants
 * 
 * Timeout and retry configurations for WebRTC and signaling connections.
 */

/**
 * CONNECTION_TIMEOUT: 60 seconds
 * 
 * Maximum time to wait for WebRTC peer connection establishment.
 * Includes ICE candidate gathering and connection negotiation.
 * Increased for cellular networks where ICE gathering can take 15-20s.
 */
export const CONNECTION_TIMEOUT = 60 * 1000;

/**
 * DATA_CHANNEL_TIMEOUT: 30 seconds
 * 
 * Maximum time to wait for DataChannel to open after peer connection.
 * Increased for high-RTT networks (100ms+ RTT on cellular).
 */
export const DATA_CHANNEL_TIMEOUT = 30 * 1000;

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
 * RECONNECT_MAX_ATTEMPTS: 10
 * 
 * Maximum number of reconnection attempts for P2P connection failures.
 * Increased for unreliable networks where multiple retries are common.
 */
export const RECONNECT_MAX_ATTEMPTS = 10;

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
