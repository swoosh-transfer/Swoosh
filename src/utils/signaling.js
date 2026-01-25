import { io } from 'socket.io-client';
import logger from './logger.js';

const SIGNALING_SERVER = import.meta.env.VITE_SIGNALING_SERVER || 'http://localhost:5000';

let socket = null;
let roomErrorHandler = null;
let isJoining = false; // Track if currently joining to prevent duplicates
let currentRoom = null; // Track current room
let reconnectCallbacks = []; // Callbacks to call on reconnection

/**
 * Register a callback to be called when socket reconnects
 * @param {Function} callback - Function to call on reconnect
 */
export function onReconnect(callback) {
  if (typeof callback === 'function') {
    reconnectCallbacks.push(callback);
  }
}

/**
 * Remove a reconnect callback
 * @param {Function} callback - Function to remove
 */
export function offReconnect(callback) {
  reconnectCallbacks = reconnectCallbacks.filter(cb => cb !== callback);
}

/**
 * Initialize socket connection to signaling server
 * @returns {Object} Socket instance
 */
export function initSocket() {
  if (socket && socket.connected) {
    return socket;
  }

  // If socket exists but not connected, don't create a new one
  if (socket) {
    return socket;
  }

  socket = io(SIGNALING_SERVER, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });

  socket.on('connect', () => {
    logger.log('[Socket] Connected:', socket.id);
    
    // Auto-rejoin room if we were in one
    if (currentRoom) {
      logger.log('[Socket] Reconnected, rejoining room:', currentRoom);
      const roomToRejoin = currentRoom;
      currentRoom = null; // Reset so joinRoom doesn't short-circuit
      isJoining = false;
      
      // Rejoin the room
      joinRoom(roomToRejoin).then(() => {
        logger.log('[Socket] Successfully rejoined room after reconnect');
        // Notify all callbacks
        reconnectCallbacks.forEach(cb => {
          try {
            cb(roomToRejoin);
          } catch (e) {
            logger.error('[Socket] Reconnect callback error:', e);
          }
        });
      }).catch(err => {
        logger.error('[Socket] Failed to rejoin room:', err);
      });
    }
  });

  socket.on('disconnect', (reason) => {
    logger.log('[Socket] Disconnected:', reason);
    // Don't reset currentRoom here - we need it for auto-rejoin
    isJoining = false;
  });

  socket.on('connect_error', (error) => {
    logger.error('[Socket] Connection error:', error);
  });

  // Handle visibility change for mobile browsers
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return socket;
}

/**
 * Handle page visibility changes (mobile tab switching)
 */
function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && socket) {
    logger.log('[Socket] Page became visible, checking connection...');
    
    if (!socket.connected) {
      logger.log('[Socket] Socket disconnected, attempting reconnect...');
      socket.connect();
    } else if (currentRoom) {
      // Verify we're still in the room by re-emitting join
      logger.log('[Socket] Verifying room membership...');
      socket.emit('verify-room', currentRoom);
    }
  }
}

/**
 * Wait for socket to be connected
 * @returns {Promise<Object>} Connected socket
 */
export function waitForConnection() {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket not initialized'));
      return;
    }

    if (socket.connected) {
      resolve(socket);
      return;
    }

    const onConnect = () => {
      cleanup();
      resolve(socket);
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      clearTimeout(timeoutId);
    };

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Connection timeout'));
    }, 10000);
  });
}

/**
 * Get current socket instance
 * @returns {Object|null} Socket instance or null
 */
export function getSocket() {
  return socket;
}

/**
 * Create a new room
 * @returns {Promise<string>} Room ID
 */
export function createRoom() {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket not initialized'));
      return;
    }

    const onRoomCreated = (roomId) => {
      cleanup();
      logger.log('[Socket] Room created:', roomId);
      resolve(roomId);
    };

    const onError = (error) => {
      cleanup();
      reject(new Error(error));
    };

    const cleanup = () => {
      socket.off('room-created', onRoomCreated);
      socket.off('error', onError);
      clearTimeout(timeoutId);
    };

    socket.once('room-created', onRoomCreated);
    socket.once('error', onError);

    // Timeout after 10 seconds
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Room creation timeout'));
    }, 10000);

    socket.emit('create-room');
  });
}

/**
 * Join an existing room
 * @param {string} roomId - Room ID to join
 * @returns {Promise<string>} Room ID
 */
export function joinRoom(roomId) {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket not initialized'));
      return;
    }

    // Prevent duplicate join attempts
    if (isJoining) {
      logger.log('[Socket] Already joining, ignoring duplicate request');
      reject(new Error('Already joining room'));
      return;
    }

    // Already in this room
    if (currentRoom === roomId) {
      logger.log('[Socket] Already in room:', roomId);
      resolve(roomId);
      return;
    }

    isJoining = true;

    // Create one-time handlers that clean up after themselves
    const onRoomJoined = (joinedRoomId) => {
      cleanup();
      isJoining = false;
      currentRoom = joinedRoomId;
      logger.log('[Socket] Joined room:', joinedRoomId);
      resolve(joinedRoomId);
    };

    const onError = (error) => {
      cleanup();
      isJoining = false;
      reject(new Error(error));
    };

    const cleanup = () => {
      socket.off('room-joined', onRoomJoined);
      socket.off('error', onError);
      clearTimeout(timeoutId);
    };

    socket.once('room-joined', onRoomJoined);
    socket.once('error', onError);

    // Timeout after 10 seconds
    const timeoutId = setTimeout(() => {
      cleanup();
      isJoining = false;
      reject(new Error('Join room timeout'));
    }, 10000);

    socket.emit('join-room', roomId);
  });
}

/**
 * Set up signaling event listeners for WebRTC
 * @param {Object} handlers - Event handlers object
 * @param {Function} handlers.onUserJoined - Called when a user joins the room
 * @param {Function} handlers.onOffer - Called when receiving an offer
 * @param {Function} handlers.onAnswer - Called when receiving an answer
 * @param {Function} handlers.onIceCandidate - Called when receiving an ICE candidate
 */
export function setupSignalingListeners(handlers) {
  if (!socket) {
    logger.error('Socket not initialized');
    return;
  }

  // Clear previous listeners to avoid duplicates
  socket.off('user-joined');
  socket.off('offer');
  socket.off('answer');
  socket.off('ice-candidate');

  if (handlers.onUserJoined) {
    socket.on('user-joined', (peerId) => {
      logger.log('[Socket] User joined:', peerId);
      handlers.onUserJoined(peerId);
    });
  }

  if (handlers.onOffer) {
    socket.on('offer', ({ offer }) => {
      logger.log('[Socket] Received offer');
      handlers.onOffer(offer);
    });
  }

  if (handlers.onAnswer) {
    socket.on('answer', ({ answer }) => {
      logger.log('[Socket] Received answer');
      handlers.onAnswer(answer);
    });
  }

  if (handlers.onIceCandidate) {
    socket.on('ice-candidate', ({ candidate }) => {
      logger.log('[Socket] Received ICE candidate');
      handlers.onIceCandidate(candidate);
    });
  }
}

/**
 * Send WebRTC offer through signaling server
 * @param {Object} offer - WebRTC offer
 * @param {string} roomId - Room ID
 */
export function sendOffer(offer, roomId) {
  if (socket) {
    socket.emit('offer', { offer, roomId });
  }
}

/**
 * Send WebRTC answer through signaling server
 * @param {Object} answer - WebRTC answer
 * @param {string} roomId - Room ID
 */
export function sendAnswer(answer, roomId) {
  if (socket) {
    socket.emit('answer', { answer, roomId });
  }
}

/**
 * Send ICE candidate through signaling server
 * @param {Object} candidate - ICE candidate
 * @param {string} roomId - Room ID
 */
export function sendIceCandidate(candidate, roomId) {
  if (socket) {
    socket.emit('ice-candidate', { candidate, roomId });
  }
}

/**
 * Disconnect socket connection
 */
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export default {
  initSocket,
  getSocket,
  createRoom,
  joinRoom,
  setupSignalingListeners,
  sendOffer,
  sendAnswer,
  sendIceCandidate,
  disconnectSocket,
};
