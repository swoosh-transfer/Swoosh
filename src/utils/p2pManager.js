import { startHealthMonitoring, stopHealthMonitoring } from './connectionMonitor';

let peerConnection = null;
let dataChannel = null;
let remoteDescriptionSet = false;
let iceCandidateQueue = [];

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 10
};

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

  peerConnection = new RTCPeerConnection(rtcConfig);

  // Send local ICE candidates to the remote peer via signaling
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { candidate: event.candidate, roomId });
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

  try {
    // Create reliable and ordered data channel for file transfer
    dataChannel = peerConnection.createDataChannel("file-transfer", { 
      reliable: true, 
      ordered: true 
    });
    setupDataChannel(dataChannel, onChannelReady);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('offer', { offer, roomId });
  } catch (err) {
    console.error("Error creating offer:", err);
  }
}

/**
 * Handles an incoming Offer (Callee role).
 * Sets remote description and sends an Answer.
 */
export async function handleOffer(offer, socket, roomId) {
  if (!peerConnection) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    remoteDescriptionSet = true;
    processIceQueue(); // Flush buffered candidates

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', { answer, roomId });
  } catch (err) {
    console.error("Error handling offer:", err);
  }
}

/**
 * Finalizes the connection logic by accepting the remote Answer.
 */
export async function handleAnswer(answer) {
  if (!peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    remoteDescriptionSet = true;
    processIceQueue();
  } catch (err) {
    console.error("Error handling answer:", err);
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
      console.error("Error adding ICE candidate:", e);
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
    peerConnection.addIceCandidate(candidate).catch(e => console.error("Queue ICE error:", e));
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
       socket.emit('offer', { offer, roomId });
     } catch (err) {
       console.error("Reconnection failed:", err);
     }
  }
}