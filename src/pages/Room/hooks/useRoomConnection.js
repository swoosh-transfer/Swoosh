/**
 * useRoomConnection Hook
 * Manages WebRTC peer connection and socket lifecycle
 * - Socket initialization and state tracking
 * - WebRTC peer connection setup
 * - Data channel management
 * - Connection state monitoring
 * - Reconnection handling
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import {
  initSocket,
  getSocket,
  joinRoom,
  setupSignalingListeners,
  waitForConnection,
  onReconnect,
  offReconnect
} from '../../../utils/signaling.js';
import {
  initializePeerConnection,
  createOffer,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  setPolite,
} from '../../../utils/p2pManager.js';
import { useRoomStore } from '../../../stores/roomStore.js';

/**
 * @typedef {Object} ConnectionInfo
 * @property {boolean} socketConnected - Socket connection status
 * @property {string} socketId - Socket ID
 * @property {string} iceState - ICE connection state
 * @property {string} signalingState - Signaling state
 * @property {string} rtcState - RTC connection state
 * @property {string} dataChannelState - Data channel state
 * @property {number} rtt - Round trip time
 * @property {number} packetLoss - Packet loss percentage
 */

/**
 * Hook for managing WebRTC connection
 * @param {string} roomId - Room identifier
 * @param {boolean} isHost - Whether user is the host
 * @param {Function} onDataChannelReady - Callback when data channel is ready
 * @param {Function} addLog - Logging function
 * @returns {Object} Connection state and methods
 */
export function useRoomConnection(roomId, isHost, onDataChannelReady, addLog) {
  const { securityPayload, setSecurityPayload, setRoomId, setConnectionState } = useRoomStore();
  
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [dataChannelReady, setDataChannelReady] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  
  /** @type {React.MutableRefObject<ConnectionInfo>} */
  const [connInfo, setConnInfo] = useState({
    socketConnected: false,
    socketId: null,
    iceState: 'new',
    signalingState: 'stable',
    rtcState: 'new',
    dataChannelState: 'closed',
    rtt: 0,
    packetLoss: 0,
  });

  const dataChannelRef = useRef(null);
  const handshakeSentRef = useRef(false); // Prevent double handshake

  /**
   * Send JSON message through data channel
   * @param {Object} obj - Object to send
   */
  const sendJSON = useCallback((obj) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify(obj));
    }
  }, []);

  /**
   * Send binary data through data channel
   * @param {ArrayBuffer} buffer - Binary data to send
   */
  const sendBinary = useCallback((buffer) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === 'open') {
      channel.send(buffer);
    }
  }, []);

  /**
   * Wait for data channel buffer to drain (backpressure handling)
   * @returns {Promise<void>}
   */
  const waitForDrain = useCallback(() => {
    return new Promise(resolve => {
      const channel = dataChannelRef.current;
      if (!channel || channel.bufferedAmount <= 65536) {
        resolve();
        return;
      }

      const check = () => {
        if (channel.bufferedAmount <= 65536) {
          channel.removeEventListener('bufferedamountlow', check);
          clearInterval(poll);
          resolve();
        }
      };

      channel.bufferedAmountLowThreshold = 65536;
      channel.addEventListener('bufferedamountlow', check);
      const poll = setInterval(check, 10);
    });
  }, []);

  // Track socket state for host (socket already connected from Home.jsx)
  useEffect(() => {
    if (!isHost) return;
    
    const socket = getSocket();
    if (!socket) return;

    // Check current state immediately
    if (socket.connected) {
      setSocketConnected(true);
      setSocketId(socket.id);
      setConnInfo(prev => ({ ...prev, socketConnected: true, socketId: socket.id }));
    }

    const onConnect = () => {
      setSocketConnected(true);
      setSocketId(socket.id);
      setConnInfo(prev => ({ ...prev, socketConnected: true, socketId: socket.id }));
      addLog(`Socket connected: ${socket.id}`, 'success');
    };

    const onDisconnect = () => {
      setSocketConnected(false);
      setConnInfo(prev => ({ ...prev, socketConnected: false }));
      addLog('Socket disconnected', 'warning');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [isHost, addLog]);

  // Initialize receiver (joining via shared link)
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash || isHost) {
      if (isHost) {
        const url = `${window.location.origin}/${roomId}${window.location.hash}`;
        setShareUrl(url);
        addLog('Room created, waiting for peer...', 'info');
      }
      return;
    }

    let cancelled = false;

    const init = async () => {
      try {
        // Parse security payload from URL
        const decoded = JSON.parse(atob(hash));
        setSecurityPayload(decoded);
        setRoomId(roomId);
        addLog('Parsed security payload', 'success');

        // Initialize socket
        const socket = initSocket();

        socket.on('connect', () => {
          setSocketConnected(true);
          setSocketId(socket.id);
          setConnInfo(prev => ({ ...prev, socketConnected: true, socketId: socket.id }));
          addLog(`Socket connected: ${socket.id}`, 'success');
        });

        socket.on('disconnect', () => {
          setSocketConnected(false);
          setConnInfo(prev => ({ ...prev, socketConnected: false }));
          addLog('Socket disconnected', 'warning');
        });

        // Wait for connection before joining
        await waitForConnection();
        if (cancelled) return;

        await joinRoom(roomId);
        setConnectionState('connecting');
        addLog(`Joined room: ${roomId}`, 'success');

      } catch (err) {
        if (cancelled) return;
        if (err.message === 'Already joining room') return;
        addLog(`Failed: ${err.message}`, 'error');
      }
    };

    init();
    return () => { cancelled = true; };
  }, [roomId, isHost, setSecurityPayload, setRoomId, setConnectionState, addLog]);

  // WebRTC setup
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !roomId) return;

    // Callback when data channel opens
    const onChannelReady = (channel) => {
      addLog('Data channel ready', 'success');
      dataChannelRef.current = channel;
      setDataChannelReady(true);
      channel.binaryType = 'arraybuffer';
      setConnInfo(prev => ({ ...prev, dataChannelState: 'open' }));

      // Set up message handler (will be provided by parent)
      onDataChannelReady(channel);
      
      channel.onclose = () => {
        setDataChannelReady(false);
        setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
        addLog('Data channel closed', 'warning');
        handshakeSentRef.current = false;
      };
    };

    // Connection state callback
    const onStateChange = (state) => {
      setConnectionState(state);
      setConnInfo(prev => ({ ...prev, rtcState: state }));
      addLog(`Connection: ${state}`, state === 'connected' ? 'success' : 'info');
    };

    // Stats callback
    const onStats = (stats) => {
      setConnInfo(prev => ({ ...prev, rtt: stats.rtt, packetLoss: stats.packetLoss }));
    };

    // Initialize peer connection
    const pc = initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats);
    
    // Set polite mode: joiner (receiver) is polite, host (sender) is impolite
    setPolite(!isHost);

    if (pc) {
      pc.oniceconnectionstatechange = () => {
        setConnInfo(prev => ({ ...prev, iceState: pc.iceConnectionState }));
        
        if (pc.iceConnectionState === 'failed') {
          addLog('ICE connection failed, attempting restart...', 'warning');
        }
      };
      pc.onsignalingstatechange = () => {
        setConnInfo(prev => ({ ...prev, signalingState: pc.signalingState }));
      };
    }

    // Handle socket reconnection
    const handleReconnection = async (rejoinedRoomId) => {
      addLog('Socket reconnected, re-establishing connection...', 'info');
      handshakeSentRef.current = false;
      
      // If we're the host, create a new offer
      if (isHost) {
        addLog('Re-creating offer after reconnect...', 'info');
        setTimeout(async () => {
          await createOffer(socket, roomId, onChannelReady);
        }, 500);
      }
    };
    
    onReconnect(handleReconnection);

    // Setup signaling listeners
    setupSignalingListeners({
      onUserJoined: async (peerId) => {
        addLog(`Peer joined: ${peerId}`, 'success');
        if (isHost) {
          addLog('Creating offer...', 'info');
          await createOffer(socket, roomId, onChannelReady);
        }
      },
      onOffer: async (offer) => {
        addLog('Received offer', 'info');
        await handleOffer(offer, socket, roomId);
      },
      onAnswer: async (answer) => {
        addLog('Received answer', 'info');
        await handleAnswer(answer);
      },
      onIceCandidate: async (candidate) => {
        await handleIceCandidate(candidate);
      },
    });
    
    return () => {
      offReconnect(handleReconnection);
    };
  }, [roomId, isHost, onDataChannelReady, setConnectionState, addLog]);

  return {
    // State
    socketConnected,
    socketId,
    dataChannelReady,
    shareUrl,
    connInfo,
    
    // Data channel
    dataChannelRef,
    sendJSON,
    sendBinary,
    waitForDrain,
    
    // Handshake tracking
    handshakeSentRef,
  };
}
