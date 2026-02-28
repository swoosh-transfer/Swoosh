import { startHealthMonitoring, stopHealthMonitoring } from './connectionMonitor';
import { sendOffer, sendAnswer, sendIceCandidate } from './signaling.js';
import logger from './logger.js';

let peerConnection = null;
let dataChannel = null;
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
  return {
    peerConnection: peerConnection?.connectionState,
    signaling: peerConnection?.signalingState,
    ice: peerConnection?.iceConnectionState,
    dataChannel: dataChannel?.readyState,
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
  if (peerConnection) {
    stopHealthMonitoring();
    peerConnection.close();
  }
  
  remoteDescriptionSet = false;
  iceCandidateQueue = [];
  isNegotiating = false;
  makingOffer = false;

  peerConnection = new RTCPeerConnection(rtcConfig);

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
  peerConnection.ondatachannel = (event) => {
    setupDataChannel(event.channel, onChannelReady);
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
    
    // Create reliable and ordered data channel for file transfer
    if (!dataChannel || dataChannel.readyState === 'closed') {
      dataChannel = peerConnection.createDataChannel("file-transfer", { 
        reliable: true, 
        ordered: true 
      });
      setupDataChannel(dataChannel, onChannelReady);
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

// Configures DataChannel listeners
function setupDataChannel(channel, onReady) {
  dataChannel = channel;
  channel.onopen = () => {
    if (onReady) onReady(channel);
  };
}

// Attempts ICE restart if the connection fails
async function handleAutoReconnection(socket, roomId) {
  if (!peerConnection) return;

  // Only the initiator (who created the channel) should restart to avoid conflicts
  if (dataChannel && dataChannel.id !== null) {
     try {
       const offer = await peerConnection.createOffer({ iceRestart: true });
       await peerConnection.setLocalDescription(offer);
       await sendOffer(offer, roomId);
     } catch (err) {
       logger.error("Reconnection failed:", err);
     }
  }
}