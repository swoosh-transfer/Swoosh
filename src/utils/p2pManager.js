import { startHealthMonitoring, stopHealthMonitoring } from './connectionMonitor';
import { sendOffer, sendAnswer, sendIceCandidate } from './signaling.js';
import { ChannelPool } from '../transfer/multichannel/ChannelPool.js';
import logger from './logger.js';

let peerConnection = null;
/** @type {ChannelPool|null} */
let channelPool = null;
let remoteDescriptionSet = false;
let iceCandidateQueue = [];
let isNegotiating = false; // Track if we're in the middle of negotiation
let isPolite = false; // For perfect negotiation pattern
let makingOffer = false; // Track if we're creating an offer

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10
};

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

  peerConnection = new RTCPeerConnection(rtcConfig);
  channelPool = new ChannelPool(peerConnection);

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
      startHealthMonitoring(peerConnection, onStats);
    } 
    else if (state === 'disconnected' || state === 'failed') {
      stopHealthMonitoring();
      handleAutoReconnection(socket, roomId);
    }
    else if (state === 'closed') {
      stopHealthMonitoring();
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

  const ch0 = channelPool?.getControlChannel();
  if (ch0 && ch0.id !== null) {
     try {
       const offer = await peerConnection.createOffer({ iceRestart: true });
       await peerConnection.setLocalDescription(offer);
       await sendOffer(offer, roomId);
     } catch (err) {
       logger.error("Reconnection failed:", err);
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
  logger.log('[P2P] Peer connection closed and cleaned up');
}