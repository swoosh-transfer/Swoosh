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
  getPeerConnection,
  requestIceRestart,
} from '../../../utils/p2pManager.js';
import { deriveEncryptionKey } from '../../../utils/tofuSecurity.js';
import { useRoomStore } from '../../../stores/roomStore.js';
import { getTransferReliabilityProfile } from '../../../constants/transfer.constants.js';
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
  const { securityPayload, setSecurityPayload, setRoomId } = useRoomStore();
  
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
  const transferProfileRef = useRef(getTransferReliabilityProfile());

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
      const lowWatermark = transferProfileRef.current.channelBufferLowWatermark;

      if (!channel || channel.bufferedAmount <= lowWatermark) {
        resolve();
        return;
      }

      const check = () => {
        if (channel.bufferedAmount <= lowWatermark) {
          channel.removeEventListener('bufferedamountlow', check);
          clearInterval(poll);
          resolve();
        }
      };

      channel.bufferedAmountLowThreshold = lowWatermark;
      channel.addEventListener('bufferedamountlow', check);
      const poll = setInterval(check, 10);
    });
  }, []);

  /**
   * Trigger explicit signaling + ICE recovery after heartbeat/lifecycle disruptions.
   */
  const requestConnectionRecovery = useCallback(async (reason = 'manual') => {
    const socket = getSocket();

    if (socket && !socket.connected) {
      logger.log(`[Room] requestConnectionRecovery(${reason}) reconnecting socket...`);
      socket.connect();
      return false;
    }

    if (socket?.connected && roomId) {
      socket.emit('verify-room', roomId);
    }

    const restartSent = await requestIceRestart(roomId);
    logger.log(`[Room] requestConnectionRecovery(${reason}) iceRestart=${restartSent}`);
    return restartSent;
  }, [roomId]);

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

    // Prevent re-init (React strict mode or deps change after first setup)
    if (webrtcSetupRef.current) return;

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

        // Named callbacks so they can be reused if peer connection is re-initialized
        const guestOnChannelReady = (channel) => {
          logger.log('[Room] Data channel ready');
          dataChannelRef.current = channel;
          setDataChannelReady(true);
          setPeerDisconnected(false); // Clear disconnect banner on reconnect
          channel.binaryType = 'arraybuffer';
          setConnInfo(prev => ({ ...prev, dataChannelState: 'open' }));
          onDataChannelReady(channel);
          channel.onclose = () => {
            setDataChannelReady(false);
            setPeerDisconnected(true);
            setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
            logger.log('[Room] Data channel closed');
            handshakeSentRef.current = false;
          };
        };
        const guestOnStateChange = (state) => {
          setConnInfo(prev => ({ ...prev, rtcState: state }));
          logger.log(`[Room] Connection: ${state}`);
        };
        const guestOnStats = (stats) => {
          setConnInfo(prev => ({ ...prev, rtt: stats.rtt, packetLoss: stats.packetLoss }));
        };

        // Attach ICE detail handlers to a peer connection (for Connection Details UI)
        const attachGuestIceHandlers = (targetPc) => {
          if (!targetPc) return;
          targetPc.oniceconnectionstatechange = () => {
            setConnInfo(prev => ({ ...prev, iceState: targetPc.iceConnectionState }));
            if (targetPc.iceConnectionState === 'connected' || targetPc.iceConnectionState === 'completed') {
              targetPc.getStats().then(stats => {
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
            if (targetPc.iceConnectionState === 'failed') {
              logger.log('[Room] ICE connection failed, attempting restart...');
            }
          };
          targetPc.onsignalingstatechange = () => {
            setConnInfo(prev => ({ ...prev, signalingState: targetPc.signalingState }));
          };
        };

        // Helper to create fresh peer connection for guest
        const createGuestPeerConnection = () => {
          const newPc = initializePeerConnection(socket, roomId, guestOnChannelReady, guestOnStateChange, guestOnStats);
          attachGuestIceHandlers(newPc);
          return newPc;
        };

        createGuestPeerConnection();

        setupSignalingListeners({
          onUserJoined: async (data) => {
            const userId = typeof data === 'object' ? data.userId : data;
            logger.log(`[Room] Peer joined: ${userId}`);
            setPeerDisconnected(false); // Clear disconnect banner when peer (re-)joins
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
            // If peer connection is dead (host reconnected), create a fresh one
            const existingPc = getPeerConnection();
            if (!existingPc || existingPc.connectionState === 'failed' || existingPc.connectionState === 'closed' || existingPc.connectionState === 'disconnected') {
              logger.log('[Room] Peer connection stale, re-initializing for new offer');
              createGuestPeerConnection();
            }
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
  }, [roomId, isHost, setSecurityPayload, setRoomId, addLog]);

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
      setPeerDisconnected(false); // Clear disconnect banner on new channel
      channel.binaryType = 'arraybuffer';
      setConnInfo(prev => ({ ...prev, dataChannelState: 'open' }));

      // Set up message handler (will be provided by parent)
      onDataChannelReady(channel);
      
      channel.onclose = () => {
        setDataChannelReady(false);
        setPeerDisconnected(true);
        setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
        logger.log('[Room] Data channel closed');
        handshakeSentRef.current = false;
      };
    };

    // Connection state callback
    const onStateChange = (state) => {
      setConnInfo(prev => ({ ...prev, rtcState: state }));
      logger.log(`[Room] Connection: ${state}`);
    };

    // Stats callback
    const onStats = (stats) => {
      setConnInfo(prev => ({ ...prev, rtt: stats.rtt, packetLoss: stats.packetLoss }));
    };

    // Attach ICE detail handlers to a peer connection (for Connection Details UI)
    const attachIceHandlers = (targetPc) => {
      if (!targetPc) return;
      targetPc.oniceconnectionstatechange = () => {
        setConnInfo(prev => ({ ...prev, iceState: targetPc.iceConnectionState }));
        if (targetPc.iceConnectionState === 'connected' || targetPc.iceConnectionState === 'completed') {
          targetPc.getStats().then(stats => {
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
        if (targetPc.iceConnectionState === 'failed') {
          logger.log('[Room] ICE connection failed, attempting restart...');
        }
      };
      targetPc.onsignalingstatechange = () => {
        setConnInfo(prev => ({ ...prev, signalingState: targetPc.signalingState }));
      };
    };

    // Create a fresh peer connection (used both on initial setup and reconnect)
    const createFreshPeerConnection = () => {
      const newPc = initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats);
      attachIceHandlers(newPc);
      return newPc;
    };

    // Initialize peer connection
    createFreshPeerConnection();

    // Handle socket reconnection
    const handleReconnection = async (rejoinedRoomId) => {
      logger.log('[Room] Socket reconnected, re-establishing connection...');
      handshakeSentRef.current = false;
      
      // Fresh peer connection for the reconnected socket
      if (isHost) {
        logger.log('[Room] Re-creating connection after socket reconnect...');
        setTimeout(async () => {
          createFreshPeerConnection();
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
        setPeerDisconnected(false); // Clear disconnect banner when a peer (re-)joins
        if (isHost) {
          // Always create fresh peer connection — old one was connected to previous socket
          createFreshPeerConnection();
          logger.log('[Room] Creating offer for (re-)joined peer...');
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
    // Functions (onDataChannelReady) are captured in closure and shouldn't be dependencies
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
    requestConnectionRecovery,
    
    // Handshake tracking
    handshakeSentRef,
  };
}
