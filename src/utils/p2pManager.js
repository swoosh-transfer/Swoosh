import { startHealthMonitoring, stopHealthMonitoring } from './connectionMonitor';
import { sendOffer, sendAnswer, sendIceCandidate, getSocket } from './signaling.js';
import { ChannelPool } from '../transfer/multichannel/ChannelPool.js';
import { RTC_CONFIGURATION } from '../constants/network.constants.js';
import logger from './logger.js';

let peerConnection = null;
/** @type {ChannelPool|null} */
let channelPool = null;
let remoteDescriptionSet = false;
let iceCandidateQueue = [];
let isNegotiating = false; // Track if we're in the middle of negotiation
let isPolite = false; // For perfect negotiation pattern
let makingOffer = false; // Track if we're creating an offer
let recoveryOfferTimer = null;
let recoveryOfferAttempts = 0;
let disconnectedTimer = null;
/** Cached socket and roomId for deferred recovery (e.g., requestIceRestart) */
let _cachedSocket = null;
let _cachedRoomId = null;
const MAX_RECOVERY_OFFER_ATTEMPTS = 10;
/** Grace period before treating 'disconnected' as a real failure (seconds) */
const DISCONNECTED_GRACE_MS = 5000;

/**
 * Set whether this peer is polite (for perfect negotiation)
 * The joiner/receiver should be polite, host/sender should be impolite
 */
export function setPolite(polite) {
  isPolite = polite;
  logger.log('[P2P] Set polite mode:', polite);
}

/**
 * Check if peer connection is in a valid state for negotiation
 */
export function canNegotiate() {
  if (!peerConnection) return false;
  const state = peerConnection.signalingState;
  return state === 'stable' || state === 'have-local-offer' || state === 'have-remote-offer';
}

/**
 * Get current connection state
 */
export function getConnectionState() {
  const ch0 = channelPool?.getControlChannel();
  return {
    peerConnection: peerConnection?.connectionState,
    signaling: peerConnection?.signalingState,
    ice: peerConnection?.iceConnectionState,
    dataChannel: ch0?.readyState,
    channelCount: channelPool?.openCount ?? 0,
    isNegotiating,
    remoteDescriptionSet
  };
}

/**
 * Initializes the RTCPeerConnection and sets up event listeners.
 * @param {Object} socket - The socket.io client instance.
 * @param {string} roomId - The unique room identifier.
 * @param {Function} onChannelReady - Callback when DataChannel is open.
 * @param {Function} onStateChange - Callback for connection state updates.
 * @param {Function} onStats - Callback for connection health statistics.
 */
export function initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats) {
  // Cleanup existing connection to prevent memory leaks
  if (channelPool) {
    channelPool.destroy();
    channelPool = null;
  }
  if (peerConnection) {
    stopHealthMonitoring();
    peerConnection.close();
  }
  
  remoteDescriptionSet = false;
  iceCandidateQueue = [];
  isNegotiating = false;
  makingOffer = false;
  recoveryOfferAttempts = 0;
  if (recoveryOfferTimer) {
    clearTimeout(recoveryOfferTimer);
    recoveryOfferTimer = null;
  }
  if (disconnectedTimer) {
    clearTimeout(disconnectedTimer);
    disconnectedTimer = null;
  }

  peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
  channelPool = new ChannelPool(peerConnection);
  _cachedSocket = socket;
  _cachedRoomId = roomId;

  // Send local ICE candidates to the remote peer via signaling (encrypted)
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendIceCandidate(event.candidate, roomId);
    }
  };

  // Monitor connection state for UI updates and auto-reconnection
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    
    if (onStateChange) onStateChange(state);

    if (state === 'connected') {
      recoveryOfferAttempts = 0;
      if (recoveryOfferTimer) {
        clearTimeout(recoveryOfferTimer);
        recoveryOfferTimer = null;
      }
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      startHealthMonitoring(peerConnection, onStats);
      
      // After ICE restart, recreate any closed data channels
      if (channelPool) {
        const recreated = channelPool.recreateChannels();
        if (recreated > 0) {
          logger.log(`[P2P] Recreated ${recreated} data channel(s) after reconnection`);
        }
      }
    } 
    else if (state === 'disconnected') {
      // Browser ICE agent often self-recovers from 'disconnected' within a few seconds.
      // Only trigger ICE restart if it doesn't recover after a grace period.
      if (!disconnectedTimer) {
        disconnectedTimer = setTimeout(() => {
          disconnectedTimer = null;
          if (peerConnection && peerConnection.connectionState === 'disconnected') {
            logger.warn('[P2P] Connection still disconnected after grace period, attempting ICE restart');
            handleAutoReconnection(socket, roomId);
          }
        }, DISCONNECTED_GRACE_MS);
      }
    }
    else if (state === 'failed') {
      stopHealthMonitoring();
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      handleAutoReconnection(socket, roomId);
    }
    else if (state === 'closed') {
      stopHealthMonitoring();
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
    }
  };

  // Monitor ICE connection state — fires sooner than connectionState
  // and catches 'failed' state on some browsers that don't update connectionState
  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection.iceConnectionState;
    logger.log(`[P2P] ICE connection state: ${iceState}`);
    
    if (iceState === 'failed') {
      // ICE failed — attempt restart immediately (connectionState may lag behind)
      logger.warn('[P2P] ICE connection failed, attempting restart');
      handleAutoReconnection(socket, roomId);
    }
  };

  // Handle incoming DataChannel from the remote peer
  // Route to ChannelPool; fire onChannelReady when channel-0 opens
  peerConnection.ondatachannel = (event) => {
    const idx = channelPool.acceptChannel(event.channel);
    if (idx === 0) {
      // Channel-0 is the control channel — notify legacy callback
      const ch = channelPool.getControlChannel();
      if (ch.readyState === 'open') {
        if (onChannelReady) onChannelReady(ch);
      } else {
        ch.addEventListener('open', () => {
          if (onChannelReady) onChannelReady(ch);
        }, { once: true });
      }
    }
  };

  return peerConnection;
}

function scheduleNegotiationRecovery(socket, roomId) {
  if (!peerConnection) return;
  if (peerConnection.connectionState === 'connected') return;
  if (recoveryOfferAttempts >= MAX_RECOVERY_OFFER_ATTEMPTS) return;

  if (recoveryOfferTimer) {
    clearTimeout(recoveryOfferTimer);
  }

  // Exponential backoff with random jitter to prevent thundering herd
  const baseDelay = 500 * Math.pow(2, Math.min(recoveryOfferAttempts, 5));
  const jitter = Math.floor(Math.random() * 500);
  const delayMs = baseDelay + jitter;
  recoveryOfferTimer = setTimeout(async () => {
    recoveryOfferTimer = null;

    if (!peerConnection || peerConnection.connectionState === 'connected') {
      return;
    }

    recoveryOfferAttempts += 1;
    logger.warn(`[P2P] Negotiation recovery attempt ${recoveryOfferAttempts}/${MAX_RECOVERY_OFFER_ATTEMPTS}`);

    try {
      await createOffer(socket, roomId);
    } catch (error) {
      logger.warn('[P2P] Negotiation recovery attempt failed:', error);
    }

    if (peerConnection && peerConnection.connectionState !== 'connected') {
      scheduleNegotiationRecovery(socket, roomId);
    }
  }, delayMs);
}

/**
 * Initiates the P2P connection (Caller role).
 * Creates the DataChannel and sends the Offer.
 */
export async function createOffer(socket, roomId, onChannelReady) {
  if (!peerConnection) return;

  // Check if we're already negotiating
  if (makingOffer || peerConnection.signalingState !== 'stable') {
    logger.log('[P2P] Skipping offer creation - already negotiating or not stable');
    return;
  }

  try {
    makingOffer = true;
    isNegotiating = true;
    
    // Create channel-0 (control channel) via ChannelPool
    if (!channelPool.getControlChannel() ||
        channelPool.getControlChannel().readyState === 'closed') {
      const ch = channelPool.addChannel(0);
      ch.addEventListener('open', () => {
        if (onChannelReady) onChannelReady(ch);
      }, { once: true });
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    await sendOffer(offer, roomId);
    logger.log('[P2P] Offer sent');
  } catch (err) {
    logger.error("Error creating offer:", err);
  } finally {
    makingOffer = false;
  }
}

/**
 * Handles an incoming Offer (Callee role).
 * Implements perfect negotiation pattern to handle glare.
 */
export async function handleOffer(offer, socket, roomId) {
  if (!peerConnection) return;

  try {
    // Perfect negotiation: Handle offer collision (glare)
    const offerCollision = makingOffer || peerConnection.signalingState !== 'stable';
    
    if (offerCollision) {
      // If we're impolite, ignore the incoming offer
      if (!isPolite) {
        logger.log('[P2P] Ignoring offer collision (impolite peer)');
        scheduleNegotiationRecovery(socket, roomId);
        return;
      }
      // If we're polite, rollback our offer and accept theirs
      logger.log('[P2P] Rolling back local offer (polite peer)');
      await peerConnection.setLocalDescription({ type: 'rollback' });
    }
    
    isNegotiating = true;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    remoteDescriptionSet = true;
    processIceQueue(); // Flush buffered candidates

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await sendAnswer(answer, roomId);
    logger.log('[P2P] Answer sent');
    isNegotiating = false;
  } catch (err) {
    logger.error("Error handling offer:", err);
    isNegotiating = false;
    scheduleNegotiationRecovery(socket, roomId);
  }
}

/**
 * Finalizes the connection logic by accepting the remote Answer.
 */
export async function handleAnswer(answer) {
  if (!peerConnection) return;
  
  // Ignore answer if we're not expecting one
  if (peerConnection.signalingState !== 'have-local-offer') {
    logger.log('[P2P] Ignoring unexpected answer, state:', peerConnection.signalingState);
    return;
  }
  
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    remoteDescriptionSet = true;
    isNegotiating = false;
    processIceQueue();
    logger.log('[P2P] Answer processed successfully');
  } catch (err) {
    logger.error("Error handling answer:", err);
    isNegotiating = false;
  }
}

/**
 * Adds incoming ICE candidates to the connection.
 * Buffers candidates if the remote description is not yet set.
 */
export async function handleIceCandidate(candidate) {
  if (!peerConnection) return;

  const ice = new RTCIceCandidate(candidate);

  if (remoteDescriptionSet && peerConnection.remoteDescription) {
    try {
      await peerConnection.addIceCandidate(ice);
    } catch (e) {
      logger.error("Error adding ICE candidate:", e);
    }
  } else {
    // Buffer candidate until remote description is available
    iceCandidateQueue.push(ice);
  }
}

// Process buffered ICE candidates once the connection is ready
function processIceQueue() {
  if (!peerConnection) return;
  while (iceCandidateQueue.length > 0) {
    const candidate = iceCandidateQueue.shift();
    peerConnection.addIceCandidate(candidate).catch(e => logger.error("Queue ICE error:", e));
  }
}

// Attempts ICE restart if the connection fails
async function handleAutoReconnection(socket, roomId) {
  if (!peerConnection) return;
  if (peerConnection.signalingState === 'closed' || peerConnection.connectionState === 'closed') return;

  // Verify socket is connected before attempting signaling
  const activeSocket = getSocket();
  if (!activeSocket || !activeSocket.connected) {
    logger.warn('[P2P] ICE restart deferred — socket not connected');
    // Socket will trigger reconnection flow when it reconnects
    return;
  }

  // Verify the control channel exists (readyState check, not just id)
  const ch0 = channelPool?.getControlChannel();
  const hasChannel = ch0 && (ch0.readyState === 'open' || ch0.readyState === 'connecting');

  if (hasChannel || channelPool) {
    try {
      if (peerConnection.signalingState !== 'stable') {
        logger.warn(`[P2P] ICE restart deferred, signalingState=${peerConnection.signalingState}`);
        // Schedule a retry with backoff
        scheduleNegotiationRecovery(socket, roomId);
        return;
      }
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
      await sendOffer(offer, roomId);
      logger.log('[P2P] ICE restart offer sent');
    } catch (err) {
      logger.error('[P2P] ICE restart failed:', err);
      scheduleNegotiationRecovery(socket, roomId);
    }
  }
}

// ─── Public accessors ──────────────────────────────────────────────

/**
 * Get the ChannelPool instance (for multi-channel transfers).
 * @returns {ChannelPool|null}
 */
export function getChannelPool() {
  return channelPool;
}

/**
 * Backward-compatible: get channel-0 (the single legacy data channel).
 * @returns {RTCDataChannel|undefined}
 */
export function getDataChannel() {
  return channelPool?.getControlChannel();
}

/**
 * Get the current RTCPeerConnection.
 * @returns {RTCPeerConnection|null}
 */
export function getPeerConnection() {
  return peerConnection;
}

/**
 * Close the peer connection and clean up all resources.
 */
export function closePeerConnection() {
  stopHealthMonitoring();
  if (channelPool) {
    channelPool.destroy();
    channelPool = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteDescriptionSet = false;
  iceCandidateQueue = [];
  isNegotiating = false;
  makingOffer = false;
  recoveryOfferAttempts = 0;
  if (recoveryOfferTimer) {
    clearTimeout(recoveryOfferTimer);
    recoveryOfferTimer = null;
  }
  if (disconnectedTimer) {
    clearTimeout(disconnectedTimer);
    disconnectedTimer = null;
  }
  logger.log('[P2P] Peer connection closed and cleaned up');
}

/**
 * Explicitly request ICE restart negotiation for connection recovery.
 * Used by heartbeat/lifecycle handlers after mobile background transitions.
 *
 * @param {string} roomId - Active room ID
 * @returns {Promise<boolean>} True if restart offer was sent
 */
export async function requestIceRestart(roomId) {
  if (!peerConnection || !roomId) {
    return false;
  }

  if (peerConnection.signalingState === 'closed' || peerConnection.connectionState === 'closed') {
    return false;
  }

  if (peerConnection.signalingState !== 'stable') {
    logger.warn(`[P2P] Deferring manual ICE restart, signalingState=${peerConnection.signalingState}`);
    // Schedule retry instead of silently failing
    if (_cachedSocket) {
      scheduleNegotiationRecovery(_cachedSocket, roomId);
    }
    return false;
  }

  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);
    await sendOffer(offer, roomId);
    logger.warn('[P2P] Manual ICE restart offer sent');
    return true;
  } catch (error) {
    logger.error('[P2P] Manual ICE restart failed:', error);
    return false;
  }
}