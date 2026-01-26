/**
 * Room Page - Production-ready P2P file transfer room
 * Uses existing utils: signaling.js, p2pManager.js, tofuSecurity.js, chunkingSystem.js, fileReceiver.js
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import logger from '../utils/logger.js';

// Zustand stores
import { useRoomStore } from '../stores/roomStore';
import { useTransferStore } from '../stores/transferStore';
import { getLocalUUID, savePeerSession, verifyPeer } from '../utils/identityManager';

// Existing utils - NO DUPLICATION
import {
  initSocket,
  getSocket,
  joinRoom,
  setupSignalingListeners,
  waitForConnection,
  onReconnect,
  offReconnect
} from '../utils/signaling';
import {
  initializePeerConnection,
  createOffer,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  setPolite,
  getConnectionState
} from '../utils/p2pManager';
import {
  deriveHMACKey,
  generateChallenge,
  signChallenge,
  verifyChallenge
} from '../utils/tofuSecurity';
import { ChunkingEngine } from '../utils/chunkingSystem';
import { fileReceiver } from '../utils/fileReceiver';
import { getQRCodeUrl } from '../utils/qrCode';
import { cleanupTransferData } from '../utils/indexedDB.js';
import { resumableTransferManager } from '../utils/resumableTransfer.js';

// UI Components
import {
  StatusSection,
  FileInfo,
  TransferProgress,
  TransferProgressWithControls,
  ShareUrlBox,
  IncomingFilePrompt,
  TransferComplete,
  ActivityLog,
  ErrorDisplay,
  ConnectionInfoPanel,
  TransferInfoPanel,
  PauseResumeButton,
  CrashRecoveryPrompt,
  formatBytes,
} from '../components/RoomUI';


export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  // ============ ZUSTAND STORES ============
  const {
    isHost, securityPayload, selectedFile,
    setSecurityPayload, setRoomId, resetRoom,
    setTofuVerified, setConnectionState, setError,
    tofuVerified, connectionState, error: roomError
  } = useRoomStore();

  const {
    initiateUpload, initiateDownload,
    updateUploadProgress, updateDownloadProgress,
    completeTransfer: completeStoreTransfer,
    uploadProgress, downloadProgress
  } = useTransferStore();

  // ============ LOCAL STATE ============
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [dataChannelReady, setDataChannelReady] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState('pending');
  const [transferState, setTransferState] = useState('idle');
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [transferEta, setTransferEta] = useState(null);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [awaitingSaveLocation, setAwaitingSaveLocation] = useState(false);
  const [downloadResult, setDownloadResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recoverableTransfers, setRecoverableTransfers] = useState([]);
  const myUUID = useRef(getLocalUUID());

  // Connection info for display
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

  // ============ REFS ============
  const dataChannelRef = useRef(null);
  const chunkingEngineRef = useRef(new ChunkingEngine());
  const challengeRef = useRef(null);
  const hmacKeyRef = useRef(null);
  const transferIdRef = useRef(null);
    const sessionIdRef = useRef(null); // Analytics session ID
  // Use a queue for chunk metadata to handle out-of-order delivery
  const chunkMetaQueueRef = useRef([]);
  const pendingBinaryQueueRef = useRef([]); // Queue of binary chunks that arrived before metadata
  const receivedBytesRef = useRef(0);
  const startTimeRef = useRef(null);
  const tofuStartedRef = useRef(false); // Prevent double TOFU verification
  const handshakeSentRef = useRef(false); // Prevent double handshake
  const tofuVerifiedRef = useRef(false); // Track TOFU status for message handler (avoids stale closure)
  const receiverLastChunkRef = useRef(-1); // Track receiver's last chunk when paused (sender side)

  // ============ LOGGING ============
  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-50), { timestamp, message, type }]);
    logger.log(`[Room] ${message}`);
  }, []);

  // ============ DATA CHANNEL HELPERS ============
  const sendJSON = useCallback((obj) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify(obj));
    }
  }, []);

  const sendBinary = useCallback((buffer) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === 'open') {
      channel.send(buffer);
    }
  }, []);

  // Wait for buffer to drain (backpressure)
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

  // ============ INITIALIZATION ============

  // Track socket state for host (socket is already connected from Home.jsx)
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
        setError(err.message);
      }
    };

    init();
    return () => { cancelled = true; };
  }, [roomId, isHost]);

  // ============ WEBRTC SETUP ============

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

      // Set up message handler FIRST before sending anything
      channel.onmessage = handleMessage;
      channel.onclose = () => {
        setDataChannelReady(false);
        setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
        addLog('Data channel closed', 'warning');
        // Reset refs on close for reconnection
        tofuStartedRef.current = false;
        handshakeSentRef.current = false;
      };

      // Send handshake only once
      if (!handshakeSentRef.current && channel.readyState === 'open') {
        handshakeSentRef.current = true;
        const handshakeMsg = {
          type: 'handshake',
          uuid: myUUID.current
        };
        channel.send(JSON.stringify(handshakeMsg));
        addLog('Sent identity handshake', 'info');
      }
      
      // NOTE: TOFU verification will start after receiving peer's handshake
      // This ensures identity is verified before cryptographic verification
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

    // Initialize peer connection using existing p2pManager
    const pc = initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats);
    
    // Set polite mode: joiner (receiver) is polite, host (sender) is impolite
    // This implements "perfect negotiation" pattern to avoid offer collision
    setPolite(!isHost);

    if (pc) {
      pc.oniceconnectionstatechange = () => {
        setConnInfo(prev => ({ ...prev, iceState: pc.iceConnectionState }));
        
        // Handle ICE connection failures
        if (pc.iceConnectionState === 'failed') {
          addLog('ICE connection failed, attempting restart...', 'warning');
        }
      };
      pc.onsignalingstatechange = () => {
        setConnInfo(prev => ({ ...prev, signalingState: pc.signalingState }));
      };
    }

    // Handle socket reconnection - re-initiate connection if needed
    const handleReconnection = async (rejoinedRoomId) => {
      addLog('Socket reconnected, re-establishing connection...', 'info');
      
      // Reset state for reconnection
      tofuStartedRef.current = false;
      handshakeSentRef.current = false;
      setTofuVerified(false);
      setIdentityVerified(false);
      
      // If we're the host, create a new offer
      if (isHost) {
        addLog('Re-creating offer after reconnect...', 'info');
        // Small delay to ensure peer is ready
        setTimeout(async () => {
          await createOffer(socket, roomId, onChannelReady);
        }, 500);
      }
    };
    
    onReconnect(handleReconnection);

    // Setup signaling listeners using existing signaling.js
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
    
    // Cleanup reconnect listener on unmount
    return () => {
      offReconnect(handleReconnection);
    };
  }, [roomId, isHost, securityPayload]);

  // ============ TOFU VERIFICATION (using existing tofuSecurity.js) ============

  const startTOFUVerification = async () => {
    // Prevent double TOFU verification
    if (tofuStartedRef.current) {
      addLog('TOFU already started, skipping...', 'info');
      return;
    }
    if (!securityPayload?.secret) {
      addLog('No security payload, skipping TOFU', 'warning');
      return;
    }
    
    tofuStartedRef.current = true;
    setVerificationStatus('verifying');
    addLog('Starting TOFU verification...', 'info');

    try {
      // Use existing tofuSecurity functions
      const hmacKey = await deriveHMACKey(securityPayload.secret);
      hmacKeyRef.current = hmacKey;

      const challenge = generateChallenge();
      challengeRef.current = challenge;

      const signature = await signChallenge(challenge, hmacKey);

      sendJSON({
        type: 'tofu-challenge',
        challenge,
        signature,
        peerID: securityPayload.peerID,
      });

      addLog('Sent TOFU challenge', 'info');
    } catch (err) {
      tofuStartedRef.current = false; // Allow retry on error
      setVerificationStatus('failed');
      addLog(`TOFU failed: ${err.message}`, 'error');
    }
  };

  // ============ MESSAGE HANDLER ============

  const handleMessage = async (event) => {
    try {
      // Binary data = file chunk
      if (event.data instanceof ArrayBuffer) {
        // SECURITY: Queue chunks until TOFU is verified (use ref to avoid stale closure)
        if (!tofuVerifiedRef.current) {
          addLog('Received chunk before TOFU verification - queuing', 'warning');
          pendingBinaryQueueRef.current.push(new Uint8Array(event.data));
          return;
        }
        await handleChunkData(new Uint8Array(event.data));
        return;
      }

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'handshake': {
          const peerUuidShort = msg.uuid?.slice(0, 8) || 'unknown';
          addLog(`Received identity: ${peerUuidShort}...`, 'info');
          
          try {
            // Verify against DB (Scoped by Room)
            const isKnownPeer = await verifyPeer(msg.uuid, roomId);
            if (isKnownPeer) {
              addLog('Session resumed with known peer', 'success');
              // Could trigger resume UI here if needed
            } else {
              addLog('New session established', 'info');
            }
            // Save this session for next time (reloads)
            await savePeerSession(msg.uuid, roomId);
          } catch (err) {
            logger.warn('[Room] Identity storage error:', err);
            // Continue anyway - identity storage is not critical
          }
          
          setIdentityVerified(true);
          
          // START TOFU ONLY AFTER IDENTITY IS VERIFIED
          // Small delay to ensure state is updated
          setTimeout(() => {
            if (securityPayload?.secret && !tofuStartedRef.current) {
              startTOFUVerification();
            }
          }, 50);
          break;
        }
        case 'tofu-challenge':
          await handleTOFUChallenge(msg);
          break;
        case 'tofu-response':
          await handleTOFUResponse(msg);
          break;
        case 'tofu-verified':
          setTofuVerified(true);
          tofuVerifiedRef.current = true;
          setVerificationStatus('verified');
          addLog('TOFU verified!', 'success');
          // Process all pending binary data that was queued during verification
          while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
            const binary = pendingBinaryQueueRef.current.shift();
            await processChunkWithMeta(binary);
          }
          break;
        case 'file-metadata':
          await handleFileMetadata(msg);
          break;
        case 'chunk-metadata':
          // Queue metadata - binary may arrive before or after
          chunkMetaQueueRef.current.push(msg);
          // Check if we have pending binaries waiting for metadata
          while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
            const binary = pendingBinaryQueueRef.current.shift();
            await processChunkWithMeta(binary);
          }
          break;
        case 'receiver-ready':
          if (isHost) {
            // SECURITY: Only send after TOFU verification (use ref to avoid stale closure)
            if (!tofuVerifiedRef.current) {
              addLog('Ignoring receiver-ready: TOFU not verified', 'warning');
              return;
            }
            addLog('Receiver ready, sending...', 'success');
            await sendFileChunks();
          }
          break;
        case 'transfer-complete':
          await handleTransferComplete();
          break;
        case 'request-chunks':
          addLog(`Retransmit requested: ${msg.chunks.length} chunks`, 'warning');
          await handleRetransmitRequest(msg.chunks);
          break;
        case 'transfer-paused':
          await handleRemotePause(msg.transferId, msg.lastChunk);
          break;
        case 'transfer-resumed':
          await handleRemoteResume(msg.transferId, msg.resumeFromChunk);
          break;
        case 'transfer-cancelled':
          handleRemoteCancel(msg.transferId);
          break;
        default:
          logger.log('[Room] Unknown message:', msg.type);
      }
    } catch (err) {
      logger.error('[Room] Message error:', err);
    }
  };

  // ============ TOFU HANDLERS ============

  const handleTOFUChallenge = async (msg) => {
    addLog('Received TOFU challenge', 'info');

    try {
      const hmacKey = await deriveHMACKey(securityPayload.secret);
      hmacKeyRef.current = hmacKey;

      const isValid = await verifyChallenge(msg.challenge, msg.signature, hmacKey);

      if (isValid) {
        addLog('Challenge valid', 'success');
        const response = await signChallenge(msg.challenge, hmacKey);
        sendJSON({ type: 'tofu-response', signature: response, challenge: msg.challenge });
        setTofuVerified(true);
        tofuVerifiedRef.current = true;
        setVerificationStatus('verified');
        
        // Process any pending binary data
        while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
          const binary = pendingBinaryQueueRef.current.shift();
          await processChunkWithMeta(binary);
        }
      } else {
        setVerificationStatus('failed');
        addLog('Challenge invalid!', 'error');
      }
    } catch (err) {
      setVerificationStatus('failed');
      addLog(`Challenge error: ${err.message}`, 'error');
    }
  };

  const handleTOFUResponse = async (msg) => {
    addLog('Received TOFU response', 'info');

    try {
      const isValid = await verifyChallenge(challengeRef.current, msg.signature, hmacKeyRef.current);

      if (isValid) {
        addLog('Peer verified!', 'success');
        sendJSON({ type: 'tofu-verified' });
        setTofuVerified(true);
        tofuVerifiedRef.current = true;
        setVerificationStatus('verified');
        
        // Process any pending binary data
        while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
          const binary = pendingBinaryQueueRef.current.shift();
          await processChunkWithMeta(binary);
        }
      } else {
        setVerificationStatus('failed');
        addLog('Peer verification failed!', 'error');
      }
    } catch (err) {
      setVerificationStatus('failed');
      addLog(`TOFU response error: ${err.message}`, 'error');
    }
  };

  // ============ FILE TRANSFER - SENDER ============

  const handleStartTransfer = () => {
    if (!selectedFile || !tofuVerified) return;

    const transferId = crypto.randomUUID();
    const sessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    transferIdRef.current = transferId;
    sessionIdRef.current = sessionId;

    // Emit analytics event: transfer-start
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('transfer-start', {
        roomId,
        sessionId,
        fileCount: 1,
        totalBytes: selectedFile.size
      });
      addLog('Analytics: Transfer started', 'info');
    }

    // Use Zustand store to track transfer
    initiateUpload({
      transferId,
      fileName: selectedFile.name,
      fileSize: selectedFile.size,
      fileType: selectedFile.type,
      totalChunks: Math.ceil(selectedFile.size / (64 * 1024)),
    });

    setTransferState('preparing');
    addLog(`Starting: ${selectedFile.name} (${formatBytes(selectedFile.size)})`, 'info');

    // Send file metadata
    sendJSON({
      type: 'file-metadata',
      transferId,
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType: selectedFile.type,
      totalChunks: Math.ceil(selectedFile.size / (64 * 1024)),
    });

    addLog('Waiting for receiver...', 'info');
  };

  const sendFileChunks = async () => {
    // SECURITY: Don't send until TOFU is verified (use ref to avoid stale closure)
    if (!selectedFile || !tofuVerifiedRef.current) {
      addLog('Cannot send: TOFU not verified', 'error');
      return;
    }

    setTransferState('sending');
    startTimeRef.current = Date.now();

    try {
      // Use existing ChunkingEngine from chunkingSystem.js
      await chunkingEngineRef.current.startChunking(
        transferIdRef.current,
        selectedFile,
        securityPayload?.peerID,
        async ({ metadata, binaryData }) => {
          // Wait for buffer drain (backpressure)
          await waitForDrain();

          // Send chunk metadata
          sendJSON({ type: 'chunk-metadata', ...metadata });

          // Wait again then send binary
          await waitForDrain();

          // Send binary data
          const buffer = binaryData.buffer.slice(
            binaryData.byteOffset,
            binaryData.byteOffset + binaryData.byteLength
          );
          sendBinary(buffer);
        },
        (bytesRead, totalSize) => {
          const progress = Math.round((bytesRead / totalSize) * 100);
          setTransferProgress(progress);

          // Calculate speed
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          if (elapsed > 0) {
            const speed = bytesRead / elapsed;
            setTransferSpeed(speed);
            setTransferEta((totalSize - bytesRead) / speed);
          }
        }
      );

      sendJSON({ type: 'transfer-complete' });
      setTransferState('completed');
      setTransferProgress(100);
      addLog('Transfer complete!', 'success');

      // Emit analytics event: transfer-complete
      const socket = getSocket();
      if (socket?.connected && sessionIdRef.current) {
        socket.emit('transfer-complete', {
          roomId,
          sessionId: sessionIdRef.current
        });
        addLog('Analytics: Transfer completed', 'success');
      }
            // Clean up all transfer data (sender side)
      try {
        // Clean up in-memory state in resumable manager
        await resumableTransferManager.completeTransfer(transferIdRef.current);
        // Clean up IndexedDB data (chunks, transfer metadata, file metadata)
        await cleanupTransferData(transferIdRef.current);
        // Clean up chunking engine state
        chunkingEngineRef.current.cleanup(transferIdRef.current);
        logger.log('[Room] Full cleanup completed for sender transfer:', transferIdRef.current);
      } catch (cleanupErr) {
        logger.warn('[Room] Cleanup failed:', cleanupErr);
      }

    } catch (err) {
      setTransferState('error');
      addLog(`Transfer failed: ${err.message}`, 'error');

          // Emit analytics event: transfer-failed
          const socket = getSocket();
          if (socket?.connected && sessionIdRef.current) {
            socket.emit('transfer-failed', {
              roomId,
              sessionId: sessionIdRef.current,
              reason: err.message || 'chunking-error'
            });
            addLog('Analytics: Transfer failed', 'error');
          }
    }
  };

  // Handle retransmission request from receiver
  const handleRetransmitRequest = useCallback(async (chunkIndices) => {
    if (!selectedFile || !isHost) {
      addLog('Cannot retransmit: file not available', 'error');
      return;
    }
    
    addLog(`Retransmitting ${chunkIndices.length} chunks...`, 'info');
    
    try {
      const result = await chunkingEngineRef.current.retransmitChunks(
        transferIdRef.current,
        chunkIndices,
        selectedFile,
        async ({ metadata, binaryData }) => {
          // Wait for buffer drain
          await waitForDrain();
          
          // Send chunk metadata
          sendJSON({ type: 'chunk-metadata', ...metadata });
          
          // Wait then send binary
          await waitForDrain();
          
          const buffer = binaryData.buffer.slice(
            binaryData.byteOffset,
            binaryData.byteOffset + binaryData.byteLength
          );
          sendBinary(buffer);
        }
      );
      
      if (result.success) {
        addLog(`Retransmitted ${result.sent} chunks successfully`, 'success');
        // Send transfer complete again
        sendJSON({ type: 'transfer-complete' });
      } else {
        addLog(`Retransmission partial: ${result.sent} sent, ${result.failed} failed`, 'warning');
      }
    } catch (err) {
      addLog(`Retransmission failed: ${err.message}`, 'error');
    }
  }, [selectedFile, isHost, addLog, sendJSON, sendBinary, waitForDrain]);

  // ============ FILE TRANSFER - RECEIVER ============

  const handleFileMetadata = async (msg) => {
    const { transferId, name, size, mimeType, totalChunks } = msg;
    
    // Receiver does not emit analytics events; sender is source of truth
    // SECURITY: Block file metadata until TOFU is verified (use ref to avoid stale closure)
    if (!tofuVerifiedRef.current) {
      addLog('Received file metadata before TOFU verification - ignoring', 'warning');
      return;
    }
    
    addLog(`Incoming: ${name} (${formatBytes(size)})`, 'info');

    transferIdRef.current = transferId;
    setPendingFile({ name, size, totalChunks });
    setAwaitingSaveLocation(true);
    receivedBytesRef.current = 0;

    // Clear any previous metadata queue
    chunkMetaQueueRef.current = [];
    pendingBinaryQueueRef.current = [];

    // Initialize FileReceiver for this transfer
    await fileReceiver.initializeReceive({
      transferId,
      name,
      size,
      mimeType,
    });

    // Set up progress callback
    fileReceiver.onProgress = (tid, progress) => {
      setTransferProgress(progress.progress);
      setTransferSpeed(progress.speed);
      setTransferEta(progress.eta);
      receivedBytesRef.current = progress.bytesReceived;
    };

    fileReceiver.onComplete = (tid, result) => {
      addLog('File saved!', 'success');
      setDownloadResult({ savedToFileSystem: result.savedToFileSystem });
    };

    fileReceiver.onError = (tid, error) => {
      addLog(`Receive error: ${error}`, 'error');
    };

    // Use Zustand store
    initiateDownload({
      transferId,
      fileName: name,
      fileSize: size,
      fileType: mimeType,
      totalChunks,
    });
  };

  const handleSelectSaveLocation = async () => {
    if (!pendingFile) return;

    try {
      // Use FileReceiver to setup file writer (must be from user gesture)
      const result = await fileReceiver.setupFileWriter(transferIdRef.current, pendingFile.name);

      addLog(`Save location selected (${result.method})`, 'success');
      setAwaitingSaveLocation(false);
      setTransferState('receiving');
      startTimeRef.current = Date.now();

      // Tell sender we're ready
      sendJSON({ type: 'receiver-ready' });

    } catch (err) {
      if (err.message.includes('cancelled')) {
        addLog('Save cancelled', 'warning');
      } else {
        addLog(`Error: ${err.message}`, 'error');
      }
    }
  };

  // Handle incoming binary chunk data
  const handleChunkData = async (data) => {
    // Check if we have metadata waiting
    if (chunkMetaQueueRef.current.length > 0) {
      await processChunkWithMeta(data);
    } else {
      // Binary arrived before metadata - queue it
      pendingBinaryQueueRef.current.push(data);
    }
  };

  // Process a chunk once we have both metadata and binary
  const processChunkWithMeta = async (data) => {
    const meta = chunkMetaQueueRef.current.shift();
    if (!meta) {
      addLog('No metadata for chunk', 'error');
      return;
    }

    try {
      // Use FileReceiver to handle the chunk (includes validation, writing, IndexedDB)
      const result = await fileReceiver.receiveChunk(
        transferIdRef.current,
        {
          chunkIndex: meta.chunkIndex,
          checksum: meta.checksum,
          size: meta.size,
          fileOffset: meta.fileOffset,
          isFinal: meta.isFinal,
        },
        data
      );

      if (!result.success) {
        addLog(`Chunk ${meta.chunkIndex}: ${result.error}`, 'error');
      } else {
      }

    } catch (err) {
      addLog(`Chunk ${meta.chunkIndex} error: ${err.message}`, 'error');
    }
  };

  const handleTransferComplete = async () => {
    addLog('Transfer complete signal', 'info');

    // Wait longer for any in-flight chunks to arrive and be queued
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      // Use FileReceiver to complete the transfer
      const result = await fileReceiver.completeTransfer(transferIdRef.current);

      if (result.success) {
        setTransferState('completed');
        setTransferProgress(100);
        setDownloadResult({
          savedToFileSystem: result.savedToFileSystem,
          url: result.url,
          blob: result.blob,
        });
        addLog('File saved!', 'success');

        // Receiver does not emit analytics events; sender already emitted
        
        // Clean up all transfer data (receiver side)
        try {
          // Clean up in-memory state in resumable manager
          await resumableTransferManager.completeTransfer(transferIdRef.current);
          // Clean up IndexedDB data (chunks, transfer metadata, file metadata)
          await cleanupTransferData(transferIdRef.current);
          logger.log('[Room] Full cleanup completed for receiver transfer:', transferIdRef.current);
        } catch (cleanupErr) {
          logger.warn('[Room] Cleanup failed:', cleanupErr);
        }
      } else if (result.pendingChunks?.length > 0) {
        // Chunks are received but waiting to be written (out of order)
        addLog(`${result.pendingChunks.length} chunks pending write, waiting...`, 'warning');
        
        // Wait longer for sequential chunks to arrive
        setTimeout(async () => {
          addLog('Retrying completion after pending chunks...', 'info');
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const retryResult = await fileReceiver.completeTransfer(transferIdRef.current);
          if (retryResult.success) {
            setTransferState('completed');
            setTransferProgress(100);
            setDownloadResult({
              savedToFileSystem: retryResult.savedToFileSystem,
              url: retryResult.url,
              blob: retryResult.blob,
            });
            addLog('File saved after pending chunks written!', 'success');
            
            fileReceiver.forceCleanup(transferIdRef.current);
            try {
              await resumableTransferManager.completeTransfer(transferIdRef.current);
              await cleanupTransferData(transferIdRef.current);
              logger.log('[Room] Cleanup completed after pending chunks:', transferIdRef.current);
            } catch (cleanupErr) {
              logger.warn('[Room] Cleanup failed:', cleanupErr);
            }
          } else if (retryResult.missingChunks?.length > 0) {
            // Now we know chunks are truly missing
            addLog(`Actually missing ${retryResult.missingChunks.length} chunks, requesting retransmit...`, 'warning');
            sendJSON({ type: 'request-chunks', chunks: retryResult.missingChunks });
            
            // Wait for retransmission
            setTimeout(async () => {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const finalResult = await fileReceiver.completeTransfer(transferIdRef.current);
              if (finalResult.success) {
                setTransferState('completed');
                setTransferProgress(100);
                setDownloadResult({
                  savedToFileSystem: finalResult.savedToFileSystem,
                  url: finalResult.url,
                  blob: finalResult.blob,
                });
                addLog('File saved after retransmission!', 'success');
                fileReceiver.forceCleanup(transferIdRef.current);
                try {
                  await resumableTransferManager.completeTransfer(transferIdRef.current);
                  await cleanupTransferData(transferIdRef.current);
                } catch (cleanupErr) {
                  logger.warn('[Room] Cleanup failed:', cleanupErr);
                }
              }
            }, 3000);
          }
        }, 3000); // Wait 3 seconds for sequential chunks
      } else if (result.missingChunks?.length > 0) {
        addLog(`Missing ${result.missingChunks.length} chunks, requesting retransmit...`, 'warning');
        // DON'T cleanup yet - keep transfer state active for retransmission
        // The receiver needs to stay initialized to receive retransmitted chunks
        sendJSON({ type: 'request-chunks', chunks: result.missingChunks });
        
        // Set a timeout to retry completion after retransmission should be done
        setTimeout(async () => {
          addLog('Checking transfer again after retransmission...', 'info');
          // Wait for chunks to arrive and be written
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Try completing again
          const retryResult = await fileReceiver.completeTransfer(transferIdRef.current);
          if (retryResult.success) {
            setTransferState('completed');
            setTransferProgress(100);
            setDownloadResult({
              savedToFileSystem: retryResult.savedToFileSystem,
              url: retryResult.url,
              blob: retryResult.blob,
            });
            addLog('File saved after retransmission!', 'success');
            
            // Force cleanup of receiver state
            fileReceiver.forceCleanup(transferIdRef.current);
            
            // Now cleanup database
            try {
              await resumableTransferManager.completeTransfer(transferIdRef.current);
              await cleanupTransferData(transferIdRef.current);
              logger.log('[Room] Full cleanup completed after retransmission:', transferIdRef.current);
            } catch (cleanupErr) {
              logger.warn('[Room] Cleanup failed:', cleanupErr);
            }
          } else if (retryResult.missingChunks?.length > 0) {
            addLog(`Still missing ${retryResult.missingChunks.length} chunks after retransmit`, 'error');
            // Could request retransmit again or give up
          }
        }, 3000); // Wait 3 seconds for retransmission
      } else {
        addLog(`Complete error: ${result.error}`, 'error');
      }

    } catch (err) {
      addLog(`Complete error: ${err.message}`, 'error');
    }
  };

  // ============ UI ACTIONS ============

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      addLog('Copy failed', err);
    }
  };

  // Pause transfer handler - sends signal to peer
  const handlePauseTransfer = useCallback(async () => {
    const transferId = transferIdRef.current;
    if (!transferId) return;

    if (isHost) {
      // Sender side - pause chunking
      await chunkingEngineRef.current.pause(transferId);
      sendJSON({ type: 'transfer-paused', transferId });
      addLog('Sending paused', 'warning');
    } else {
      // Receiver side - pause and get last received chunk
      const result = await fileReceiver.pause(transferId);
      sendJSON({ type: 'transfer-paused', transferId, lastChunk: result.lastChunk });
      addLog(`Receiving paused at chunk ${result.lastChunk}`, 'warning');
    }
    setIsPaused(true);
  }, [isHost, addLog, sendJSON]);

  // Resume transfer handler - sends signal to peer with sync info
  const handleResumeTransfer = useCallback(async () => {
    const transferId = transferIdRef.current;
    if (!transferId) return;

    if (isHost) {
      // Sender side - when sender initiates resume, check if we have receiver's last position
      const resumeFromChunk = receiverLastChunkRef.current >= 0 
        ? receiverLastChunkRef.current + 1 
        : undefined;
      
      if (resumeFromChunk !== undefined && selectedFile) {
        // Get sender's current pause state
        const pauseState = chunkingEngineRef.current.getPauseState(transferId);
        
        // If sender paused ahead of receiver, we need to resync
        if (pauseState && pauseState.currentChunkIndex > resumeFromChunk) {
          addLog(`Resyncing: sender at chunk ${pauseState.currentChunkIndex}, receiver at ${resumeFromChunk}`, 'info');
          
          // Retransmit missing chunks
          const missingChunks = [];
          for (let i = resumeFromChunk; i < pauseState.currentChunkIndex; i++) {
            missingChunks.push(i);
          }
          
          if (missingChunks.length > 0) {
            addLog(`Retransmitting ${missingChunks.length} chunks from ${resumeFromChunk}`, 'info');
            await handleRetransmitRequest(missingChunks);
          }
        }
      }
      
      await chunkingEngineRef.current.resume(transferId);
      sendJSON({ type: 'transfer-resumed', transferId, resumeFromChunk });
      addLog('Sending resumed', 'success');
      
      // Reset stored position
      receiverLastChunkRef.current = -1;
    } else {
      // Receiver side - resume and tell sender which chunk to resume from
      const result = await fileReceiver.resume(transferId);
      const resumeFromChunk = result.lastChunk + 1;
      sendJSON({ type: 'transfer-resumed', transferId, resumeFromChunk });
      addLog(`Receiving resumed, requesting sender to resume from chunk ${resumeFromChunk}`, 'success');
    }
    setIsPaused(false);
  }, [isHost, addLog, sendJSON, selectedFile, handleRetransmitRequest]);

  // Cancel transfer handler - sends signal to peer
  const handleCancelTransfer = useCallback(() => {
    const transferId = transferIdRef.current;
    if (!transferId) return;

    // Notify peer about cancellation
    sendJSON({ type: 'transfer-cancelled', transferId });

    if (isHost) {
      chunkingEngineRef.current.cleanup(transferId);
    } else {
      fileReceiver.cancelTransfer(transferId);
    }
    setTransferState('idle');
    setTransferProgress(0);
    setIsPaused(false);
    addLog('Transfer cancelled', 'warning');
  }, [isHost, addLog, sendJSON]);

  // Handle remote pause signal from peer
  const handleRemotePause = useCallback(async (transferId, lastChunk) => {
    if (isHost) {
      // Sender receives pause from receiver - pause and note where receiver stopped
      await chunkingEngineRef.current.pause(transferId);
      if (lastChunk !== undefined) {
        receiverLastChunkRef.current = lastChunk;
        addLog(`Receiver paused at chunk ${lastChunk}`, 'warning');
      } else {
        addLog('Peer paused transfer', 'warning');
      }
    } else {
      // Receiver receives pause from sender
      await fileReceiver.pause(transferId);
      addLog('Sender paused transfer', 'warning');
    }
    setIsPaused(true);
  }, [isHost, addLog]);

  // Handle remote resume signal from peer
  const handleRemoteResume = useCallback(async (transferId, resumeFromChunk) => {
    if (isHost) {
      // Sender receives resume from receiver - resume from specified chunk
      
      // Use resumeFromChunk if provided, otherwise use stored lastChunk + 1
      const targetChunk = resumeFromChunk ?? (receiverLastChunkRef.current >= 0 ? receiverLastChunkRef.current + 1 : undefined);
      
      if (targetChunk !== undefined && selectedFile) {
        addLog(`Receiver requested resume from chunk ${targetChunk}`, 'info');
        
        // Get pause state to check current position
        const pauseState = chunkingEngineRef.current.getPauseState(transferId);
        
        // If sender paused ahead of receiver, retransmit missing chunks BEFORE resuming
        if (pauseState && pauseState.currentChunkIndex > targetChunk) {
          const missingChunks = [];
          for (let i = targetChunk; i < pauseState.currentChunkIndex; i++) {
            missingChunks.push(i);
          }
          if (missingChunks.length > 0) {
            addLog(`Retransmitting ${missingChunks.length} chunks from ${targetChunk} before resuming`, 'info');
            await handleRetransmitRequest(missingChunks);
          }
        }
        
        // Now resume normal sending from where sender left off
        await chunkingEngineRef.current.resume(transferId);
        addLog('Sending resumed', 'success');
      } else {
        await chunkingEngineRef.current.resume(transferId);
        addLog('Peer resumed transfer', 'success');
      }
      
      // Reset the stored last chunk
      receiverLastChunkRef.current = -1;
    } else {
      // Receiver receives resume from sender
      await fileReceiver.resume(transferId);
      addLog('Sender resumed transfer', 'success');
    }
    setIsPaused(false);
  }, [isHost, addLog, selectedFile, handleRetransmitRequest]);

  // Handle remote cancel signal from peer
  const handleRemoteCancel = useCallback((transferId) => {
    if (isHost) {
      chunkingEngineRef.current.cleanup(transferId);
    } else {
      fileReceiver.cancelTransfer(transferId);
    }
    setTransferState('idle');
    setTransferProgress(0);
    setIsPaused(false);
    addLog('Peer cancelled transfer', 'warning');
  }, [isHost, addLog]);

  // Handle recoverable transfer recovery
  const handleRecoverTransfer = useCallback(async (recoveryTransferId) => {
    // TODO: Implement full recovery logic - reconnect to peer and resume
    addLog(`Recovering transfer: ${recoveryTransferId}`, 'info');
    setRecoverableTransfers(prev => prev.filter(t => t.transferId !== recoveryTransferId));
  }, [addLog]);

  // Discard recoverable transfer
  const handleDiscardRecovery = useCallback((recoveryTransferId) => {
    setRecoverableTransfers(prev => prev.filter(t => t.transferId !== recoveryTransferId));
    addLog('Transfer discarded', 'info');
  }, [addLog]);

  // Handle file selection for crash recovery (sender)
  const handleSelectFileForRecovery = useCallback(async (recoveryTransferId) => {
    // TODO: Implement file picker and resume sending
    addLog(`Select file to resume: ${recoveryTransferId}`, 'info');
    setRecoverableTransfers(prev => prev.filter(t => t.transferId !== recoveryTransferId));
  }, [addLog]);

  const handleLeave = () => {
    chunkingEngineRef.current.cleanup(transferIdRef.current);
    resetRoom();
    navigate('/');
  };

  // ============ RENDER ============

  const transferInfo = {
    fileName: pendingFile?.name || selectedFile?.name,
    fileSize: pendingFile?.size || selectedFile?.size || 0,
    progress: transferProgress,
    speed: transferSpeed,
    eta: transferEta,
    isPaused: isPaused,
  };

  const isTransferring = transferState === 'sending' || transferState === 'receiving' || transferState === 'preparing';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
      {/* Crash Recovery Prompt */}
      <CrashRecoveryPrompt
        transfers={recoverableTransfers}
        onResume={handleRecoverTransfer}
        onDiscard={handleDiscardRecovery}
        onSelectFile={handleSelectFileForRecovery}
      />

      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-light tracking-tight mb-1">
            {isHost ? 'Send File' : 'Receive File'}
          </h1>
          <p className="text-zinc-500 text-sm font-mono">Room: {roomId}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left Column */}
          <div className="space-y-4">
            {/* Connection Status */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Status</h2>
              <StatusSection
                socketConnected={socketConnected || connInfo.socketConnected}
                dataChannelReady={dataChannelReady}
                tofuVerified={tofuVerified}
                tofuStatus={verificationStatus}
              />
            </div>

            {/* Share URL */}
            {isHost && !dataChannelReady && shareUrl && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <ShareUrlBox url={shareUrl} onCopy={handleCopy} copied={copied} />
              </div>
            )}

            {/* File Info */}
            {isHost && selectedFile && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <FileInfo file={selectedFile} />
              </div>
            )}

            {/* Incoming File */}
            {awaitingSaveLocation && pendingFile && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <IncomingFilePrompt file={pendingFile} onAccept={handleSelectSaveLocation} />
              </div>
            )}

            {/* Progress with Pause/Resume Controls */}
            {isTransferring && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <TransferProgressWithControls
                  progress={transferProgress}
                  state={transferState}
                  speed={transferSpeed}
                  eta={transferEta}
                  isPaused={isPaused}
                  onPause={handlePauseTransfer}
                  onResume={handleResumeTransfer}
                  onCancel={handleCancelTransfer}
                />
              </div>
            )}

            {/* Complete */}
            {transferState === 'completed' && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <TransferComplete
                  isHost={isHost}
                  savedToFileSystem={downloadResult?.savedToFileSystem}
                  fileName={pendingFile?.name}
                />
              </div>
            )}

            {/* Send Button */}
            {isHost && tofuVerified && dataChannelReady && transferState === 'idle' && (
              <button
                onClick={handleStartTransfer}
                className="w-full py-3 bg-zinc-100 text-zinc-900 hover:bg-white rounded-xl font-medium transition-colors"
              >
                Send File
              </button>
            )}

            {/* Error */}
            <ErrorDisplay error={roomError} />

            {/* Leave */}
            <button
              onClick={handleLeave}
              className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-400 transition-colors"
            >
              Leave Room
            </button>
          </div>

          {/* Right Column */}
          <div className="space-y-4">
            {/* Connection Info */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Connection</h2>
              <ConnectionInfoPanel info={connInfo} />
            </div>

            {/* Transfer Info */}
            {transferInfo.fileName && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <h2 className="text-sm font-medium text-zinc-400 mb-3">Transfer</h2>
                <TransferInfoPanel info={transferInfo} />
              </div>
            )}

            {/* Activity Log */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Activity</h2>
              <ActivityLog logs={logs} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
