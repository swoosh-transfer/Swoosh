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
  leaveRoom,
  setupSignalingListeners,
  waitForConnection,
  setEncryptionKey,
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
import { deriveEncryptionKey } from '../../../utils/tofuSecurity.js';
import { useRoomStore } from '../../../stores/roomStore.js';
import logger from '../../../utils/logger.js';

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
  const [roomJoined, setRoomJoined] = useState(isHost); // Host doesn't need to join, guest does
  
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

  // Peer disconnection state for UI notification
  const [peerDisconnected, setPeerDisconnected] = useState(false);

  const dataChannelRef = useRef(null);
  const handshakeSentRef = useRef(false); // Prevent double handshake
  const webrtcSetupRef = useRef(false); // Track if guest set up WebRTC early (before join)

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
    
    const socket = getSocket() ?? initSocket();
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

        // Derive encryption key from shared secret BEFORE joining room
        if (decoded.secret) {
          const aesKey = await deriveEncryptionKey(decoded.secret);
          setEncryptionKey(aesKey);
          addLog('Signaling encryption key derived', 'success');
        }

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

        // --- Guest: set up WebRTC BEFORE joining to prevent offer race ---
        // When the guest joins, the host immediately creates and sends an offer.
        // If we rely on a React effect to set up signaling listeners, the offer
        // may arrive before the effect runs (React state updates are deferred).
        setPolite(true); // Guest is polite
        logger.log('[Room] Set polite mode: true');

        initializePeerConnection(socket, roomId, (channel) => {
          logger.log('[Room] Data channel ready');
          dataChannelRef.current = channel;
          setDataChannelReady(true);
          channel.binaryType = 'arraybuffer';
          setConnInfo(prev => ({ ...prev, dataChannelState: 'open' }));
          onDataChannelReady(channel);
          channel.onclose = () => {
            setDataChannelReady(false);
            setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
            logger.log('[Room] Data channel closed');
            handshakeSentRef.current = false;
          };
        }, (state) => {
          setConnectionState(state);
          setConnInfo(prev => ({ ...prev, rtcState: state }));
          logger.log(`[Room] Connection: ${state}`);
        }, (stats) => {
          setConnInfo(prev => ({ ...prev, rtt: stats.rtt, packetLoss: stats.packetLoss }));
        });

        setupSignalingListeners({
          onUserJoined: async (data) => {
            const userId = typeof data === 'object' ? data.userId : data;
            logger.log(`[Room] Peer joined: ${userId}`);
          },
          onUserLeft: (data) => {
            logger.log(`[Room] Peer left: ${data?.userId}`);
            addLog('Peer disconnected', 'warning');
            setDataChannelReady(false);
            setPeerDisconnected(true);
            setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
            handshakeSentRef.current = false;
          },
          onRoomFull: (data) => {
            logger.log(`[Room] Room full: ${data?.message}`);
            addLog('Room is full', 'warning');
          },
          onRoomDismissed: (data) => {
            logger.log(`[Room] Room dismissed: ${data?.reason}`);
            addLog(`Room closed: ${data?.reason || 'host left'}`, 'warning');
            setPeerDisconnected(true);
          },
          onOffer: async (offer) => {
            logger.log('[Room] Received offer');
            await handleOffer(offer, socket, roomId);
          },
          onAnswer: async (answer) => {
            logger.log('[Room] Received answer');
            await handleAnswer(answer);
          },
          onIceCandidate: async (candidate) => {
            await handleIceCandidate(candidate);
          },
        });

        webrtcSetupRef.current = true;
        addLog('WebRTC ready, joining room...', 'info');
        // --- end early setup ---

        await joinRoom(roomId);
        setConnectionState('connecting');
        setRoomJoined(true);
        addLog(`Joined room: ${roomId}`, 'success');

      } catch (err) {
        if (cancelled) return;
        if (err.message === 'Already joining room') return;
        const code = err.code || '';
        addLog(`Failed: ${code ? `[${code}] ` : ''}${err.message}`, 'error');
      }
    };

    init();
    return () => { cancelled = true; };
  }, [roomId, isHost, setSecurityPayload, setRoomId, setConnectionState, addLog]);

  // WebRTC setup - wait until room is joined
  useEffect(() => {
    const socket = getSocket() ?? initSocket();
    if (!socket || !roomId || !roomJoined || !socket.connected) {
      return; // Wait until socket is connected and room is joined before setting up WebRTC
    }

    // Guest already set up WebRTC in init effect (before join, to prevent offer race)
    if (webrtcSetupRef.current) {
      return;
    }

    // Set polite mode FIRST, before any negotiation can happen
    // Host (sender) is impolite, Guest (receiver) is polite
    setPolite(!isHost);
    logger.log(`[Room] Set polite mode: ${!isHost}`);

    // Derive encryption key for host (guest already derived in init effect)
    let keyReady = false;
    const setupEncryption = async () => {
      const payload = useRoomStore.getState().securityPayload;
      if (payload?.secret) {
        try {
          const aesKey = await deriveEncryptionKey(payload.secret);
          setEncryptionKey(aesKey);
          logger.log('[Room] Host: signaling encryption key derived');
          keyReady = true;
        } catch (err) {
          logger.error('[Room] Failed to derive encryption key:', err);
        }
      }
    };

    // For host, derive key before setting up listeners
    if (isHost) {
      setupEncryption();
    }

    // Callback when data channel opens
    const onChannelReady = (channel) => {
      logger.log('[Room] Data channel ready');
      dataChannelRef.current = channel;
      setDataChannelReady(true);
      channel.binaryType = 'arraybuffer';
      setConnInfo(prev => ({ ...prev, dataChannelState: 'open' }));

      // Set up message handler (will be provided by parent)
      onDataChannelReady(channel);
      
      channel.onclose = () => {
        setDataChannelReady(false);
        setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
        logger.log('[Room] Data channel closed');
        handshakeSentRef.current = false;
      };
    };

    // Connection state callback
    const onStateChange = (state) => {
      setConnectionState(state);
      setConnInfo(prev => ({ ...prev, rtcState: state }));
      logger.log(`[Room] Connection: ${state}`);
    };

    // Stats callback
    const onStats = (stats) => {
      setConnInfo(prev => ({ ...prev, rtt: stats.rtt, packetLoss: stats.packetLoss }));
    };

    // Initialize peer connection
    const pc = initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats);

    if (pc) {
      pc.oniceconnectionstatechange = () => {
        setConnInfo(prev => ({ ...prev, iceState: pc.iceConnectionState }));
        
        // When ICE connects, gather candidate pair details for Connection Details
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          pc.getStats().then(stats => {
            stats.forEach(report => {
              if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                const localCandidate = stats.get(report.localCandidateId);
                const remoteCandidate = stats.get(report.remoteCandidateId);
                setConnInfo(prev => ({
                  ...prev,
                  candidateType: localCandidate?.candidateType || null,
                  remoteCandidateType: remoteCandidate?.candidateType || null,
                  protocol: localCandidate?.protocol || null,
                  networkType: localCandidate?.networkType || null,
                  availableOutgoingBitrate: report.availableOutgoingBitrate || null,
                }));
              }
            });
          }).catch(() => { /* stats unavailable */ });
        }
        
        if (pc.iceConnectionState === 'failed') {
          logger.log('[Room] ICE connection failed, attempting restart...');
        }
      };
      pc.onsignalingstatechange = () => {
        setConnInfo(prev => ({ ...prev, signalingState: pc.signalingState }));
      };
    }

    // Handle socket reconnection
    const handleReconnection = async (rejoinedRoomId) => {
      logger.log('[Room] Socket reconnected, re-establishing connection...');
      handshakeSentRef.current = false;
      
      // If we're the host, create a new offer
      if (isHost) {
        logger.log('[Room] Re-creating offer after reconnect...');
        setTimeout(async () => {
          await createOffer(socket, roomId, onChannelReady);
        }, 500);
      }
    };
    
    onReconnect(handleReconnection);

    // Setup signaling listeners
    setupSignalingListeners({
      onUserJoined: async (data) => {
        // Support both old (string) and new (object) payloads
        const userId = typeof data === 'object' ? data.userId : data;
        logger.log(`[Room] Peer joined: ${userId}`);
        if (isHost) {
          logger.log('[Room] Creating offer...');
          await createOffer(socket, roomId, onChannelReady);
        }
      },
      onUserLeft: (data) => {
        const userId = data?.userId;
        logger.log(`[Room] Peer left: ${userId}`);
        addLog('Peer disconnected', 'warning');
        setDataChannelReady(false);
        setPeerDisconnected(true);
        setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
        handshakeSentRef.current = false;
      },
      onRoomFull: (data) => {
        logger.log(`[Room] Room full: ${data?.message}`);
        addLog('Room is full', 'warning');
      },
      onRoomDismissed: (data) => {
        logger.log(`[Room] Room dismissed: ${data?.reason}`);
        addLog(`Room closed: ${data?.reason || 'host left'}`, 'warning');
        setPeerDisconnected(true);
      },
      onOffer: async (offer) => {
        logger.log('[Room] Received offer');
        await handleOffer(offer, socket, roomId);
      },
      onAnswer: async (answer) => {
        logger.log('[Room] Received answer');
        await handleAnswer(answer);
      },
      onIceCandidate: async (candidate) => {
        await handleIceCandidate(candidate);
      },
    });
    
    return () => {
      offReconnect(handleReconnection);
    };
    // Functions (onDataChannelReady, setConnectionState) are captured in closure and shouldn't be dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, isHost, roomJoined, socketConnected]);

  return {
    // State
    socketConnected,
    socketId,
    dataChannelReady,
    shareUrl,
    connInfo,
    peerDisconnected,
    
    // Data channel
    dataChannelRef,
    sendJSON,
    sendBinary,
    waitForDrain,
    
    // Handshake tracking
    handshakeSentRef,
  };
}
