/**
 * Room Page - Production-ready P2P file transfer room
 * Uses existing utils: signaling.js, p2pManager.js, tofuSecurity.js, chunkingSystem.js, fileReceiver.js
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

// Zustand stores
import { useRoomStore } from '../stores/roomStore';
import { useTransferStore } from '../stores/transferStore';

// Existing utils - NO DUPLICATION
import { 
  initSocket, 
  getSocket,
  joinRoom, 
  setupSignalingListeners,
  waitForConnection 
} from '../utils/signaling';
import { 
  initializePeerConnection, 
  createOffer, 
  handleOffer, 
  handleAnswer, 
  handleIceCandidate 
} from '../utils/p2pManager';
import { 
  deriveHMACKey,
  generateChallenge,
  signChallenge,
  verifyChallenge
} from '../utils/tofuSecurity';
import { ChunkingEngine } from '../utils/chunkingSystem';
import { fileReceiver } from '../utils/fileReceiver';

// UI Components
import {
  StatusSection,
  FileInfo,
  TransferProgress,
  ShareUrlBox,
  IncomingFilePrompt,
  TransferComplete,
  ActivityLog,
  ErrorDisplay,
  ConnectionInfoPanel,
  TransferInfoPanel,
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
  // Use a queue for chunk metadata to handle out-of-order delivery
  const chunkMetaQueueRef = useRef([]);
  const pendingBinaryRef = useRef(null); // Store binary if it arrives before metadata
  const receivedBytesRef = useRef(0);
  const startTimeRef = useRef(null);

  // ============ LOGGING ============
  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-50), { timestamp, message, type }]);
    console.log(`[Room] ${message}`);
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
      setConnInfo(prev => ({ ...prev, dataChannelState: 'open' }));
      
      channel.binaryType = 'arraybuffer';
      channel.onmessage = handleMessage;
      channel.onclose = () => {
        setDataChannelReady(false);
        setConnInfo(prev => ({ ...prev, dataChannelState: 'closed' }));
        addLog('Data channel closed', 'warning');
      };

      // Start TOFU verification
      if (securityPayload?.secret) {
        startTOFUVerification();
      }
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
    
    if (pc) {
      pc.oniceconnectionstatechange = () => {
        setConnInfo(prev => ({ ...prev, iceState: pc.iceConnectionState }));
      };
      pc.onsignalingstatechange = () => {
        setConnInfo(prev => ({ ...prev, signalingState: pc.signalingState }));
      };
    }

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
  }, [roomId, isHost, securityPayload]);

  // ============ TOFU VERIFICATION (using existing tofuSecurity.js) ============
  
  const startTOFUVerification = async () => {
    if (!securityPayload?.secret) return;
    
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
      setVerificationStatus('failed');
      addLog(`TOFU failed: ${err.message}`, 'error');
    }
  };

  // ============ MESSAGE HANDLER ============
  
  const handleMessage = async (event) => {
    try {
      // Binary data = file chunk
      if (event.data instanceof ArrayBuffer) {
        await handleChunkData(new Uint8Array(event.data));
        return;
      }

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'tofu-challenge':
          await handleTOFUChallenge(msg);
          break;
        case 'tofu-response':
          await handleTOFUResponse(msg);
          break;
        case 'tofu-verified':
          setTofuVerified(true);
          setVerificationStatus('verified');
          addLog('TOFU verified!', 'success');
          break;
        case 'file-metadata':
          await handleFileMetadata(msg);
          break;
        case 'chunk-metadata':
          // Queue metadata - binary may arrive before or after
          chunkMetaQueueRef.current.push(msg);
          // Check if we have pending binary waiting for this metadata
          if (pendingBinaryRef.current) {
            const binary = pendingBinaryRef.current;
            pendingBinaryRef.current = null;
            await processChunkWithMeta(binary);
          }
          break;
        case 'receiver-ready':
          if (isHost) {
            addLog('Receiver ready, sending...', 'success');
            await sendFileChunks();
          }
          break;
        case 'transfer-complete':
          await handleTransferComplete();
          break;
        case 'request-chunks':
          addLog(`Retransmit requested: ${msg.chunks.length} chunks`, 'warning');
          // TODO: Implement retransmission
          break;
        default:
          console.log('[Room] Unknown message:', msg.type);
      }
    } catch (err) {
      console.error('[Room] Message error:', err);
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
        setVerificationStatus('verified');
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
        setVerificationStatus('verified');
      } else {
        setVerificationStatus('failed');
        addLog('Peer verification failed!', 'error');
      }
    } catch (err) {
      setVerificationStatus('failed');
    }
  };

  // ============ FILE TRANSFER - SENDER ============
  
  const handleStartTransfer = () => {
    if (!selectedFile || !tofuVerified) return;
    
    const transferId = crypto.randomUUID();
    transferIdRef.current = transferId;
    
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
    if (!selectedFile) return;
    
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
      
    } catch (err) {
      setTransferState('error');
      addLog(`Transfer failed: ${err.message}`, 'error');
    }
  };

  // ============ FILE TRANSFER - RECEIVER ============
  
  const handleFileMetadata = async (msg) => {
    addLog(`Incoming: ${msg.name} (${formatBytes(msg.size)})`, 'info');
    
    transferIdRef.current = msg.transferId;
    setPendingFile({ name: msg.name, size: msg.size, totalChunks: msg.totalChunks });
    setAwaitingSaveLocation(true);
    receivedBytesRef.current = 0;
    
    // Clear any previous metadata queue
    chunkMetaQueueRef.current = [];
    pendingBinaryRef.current = null;
    
    // Initialize FileReceiver for this transfer
    await fileReceiver.initializeReceive({
      transferId: msg.transferId,
      name: msg.name,
      size: msg.size,
      mimeType: msg.mimeType,
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
      transferId: msg.transferId,
      fileName: msg.name,
      fileSize: msg.size,
      fileType: msg.mimeType,
      totalChunks: msg.totalChunks,
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
      // Binary arrived before metadata - store it temporarily
      pendingBinaryRef.current = data;
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
      }
      
    } catch (err) {
      addLog(`Chunk ${meta.chunkIndex} error: ${err.message}`, 'error');
    }
  };

  const handleTransferComplete = async () => {
    addLog('Transfer complete signal', 'info');
    
    // Wait a moment for any in-flight chunks
    await new Promise(resolve => setTimeout(resolve, 100));
    
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
      } else if (result.missingChunks?.length > 0) {
        addLog(`Missing ${result.missingChunks.length} chunks, requesting retransmit...`, 'warning');
        sendJSON({ type: 'request-chunks', chunks: result.missingChunks });
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
      addLog('Copy failed', 'error');
    }
  };

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
  };

  const isTransferring = transferState === 'sending' || transferState === 'receiving' || transferState === 'preparing';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
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

            {/* Progress */}
            {isTransferring && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <TransferProgress 
                  progress={transferProgress}
                  state={transferState}
                  speed={transferSpeed}
                  eta={transferEta}
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
            {isHost && tofuVerified && transferState === 'idle' && (
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
