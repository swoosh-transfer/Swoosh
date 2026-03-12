/**
 * Room Page - Refactored and Modular
 * Composes hooks and components for clean, maintainable architecture
 * 
 * Down from 1,401 lines to ~200 lines ✨
 */
import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useRoomStore } from '../../stores/roomStore.js';
import { ErrorDisplay } from '../../components/RoomUI.jsx';
import FileDropZone from '../../components/FileDropZone.jsx';
import { disconnectSocket, leaveRoom } from '../../utils/signaling.js';
import { closePeerConnection } from '../../utils/p2pManager.js';
import { getQRCodeUrl } from '../../utils/qrCode.js';
import { heartbeatMonitor } from '../../utils/heartbeatMonitor.js';
import { initNotifications } from '../../utils/transferNotifications.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { updateTransfer } from '../../infrastructure/database/transfers.repository.js';

// Custom hooks
import {
  useRoomState,
  useRoomConnection,
  useSecurity,
  useFileTransfer,
  useMultiFileTransfer,
  useMessages,
  useTransferTracking,
  useResumeTransfer,
} from './hooks/index.js';

// UI Components
import {
  TransferSection,
  ActivityLogSection,
} from './components/index.js';

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { isHost, securityPayload, selectedFiles, addFiles, removeFile, clearFiles, resetRoom, error: roomError } = useRoomStore();
  const [showQRCode, setShowQRCode] = useState(false);
  const pendingResumeRef = useRef(null); // No longer used — file re-selection removed
  const resumeFallbackFiredRef = useRef(false); // Prevent repeated auto-start on resume failure
  const negotiatedConfigRef = useRef(null);

  // Derive selectedFile from selectedFiles (first file or null)
  const selectedFile = selectedFiles.length > 0 ? selectedFiles[0].file : null;

  // ============ HOOKS ============
  
  // UI State (logs, copy state, pending file, etc.)
  const uiState = useRoomState();
  const { addLog, logs, copied, handleCopy, pendingFile, awaitingSaveLocation, downloadResult, clearPendingFile, resetUiTransferState } = uiState;

  // WebRTC Connection (socket, peer connection, data channel)
  const connection = useRoomConnection(
    roomId,
    isHost,
    (channel) => {
      // Data channel opened — encrypted signaling succeeded, peer is verified
      security.markVerified();
      // Send optional identity handshake for session resumption
      security.sendHandshake(channel);
    },
    addLog
  );
  const {
    socketConnected,
    dataChannelReady,
    shareUrl,
    connInfo,
    peerDisconnected,
    sendJSON,
    sendBinary,
    waitForDrain,
    dataChannelRef,
    requestConnectionRecovery,
  } = connection;

  // Security (encrypted signaling verification)
  const security = useSecurity(roomId, sendJSON, addLog);
  const { verificationStatus, identityVerified, tofuVerified, isReturningPeer, interruptedTransfer } = security;

  // Transfer Tracking (IndexedDB persistence for cross-session resume)
  const tracking = useTransferTracking({
    roomId,
    peerDisconnected,
    addLog,
  });

  // File Transfer (send/receive with pause/resume/cancel)
  const transfer = useFileTransfer(
    roomId,
    isHost,
    selectedFile,
    securityPayload,
    tofuVerified,
    sendJSON,
    sendBinary,
    waitForDrain,
    addLog,
    tracking.trackChunkProgress
  );
  const {
    transferState,
    transferProgress,
    transferSpeed,
    transferEta,
    isPaused,
    startTransfer,
    setupFileWriter,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    resetTransferState,
  } = transfer;

  // Multi-file transfer (wraps MultiFileTransferManager / MultiFileReceiver)
  const multiTransfer = useMultiFileTransfer({
    roomId,
    isHost,
    selectedFiles,
    tofuVerified,
    sendJSON,
    sendBinary,
    waitForDrain,
    addLog,
    trackChunkProgress: tracking.trackChunkProgress,
    negotiatedConfigRef,
  });

  // Determine if we're in multi-file mode
  // Always use multi-file path (even for 1 file) to leverage multi-channel transfer
  // Receiver: has incoming manifest or actively receiving/completed multi-file
  const isMultiFile = selectedFiles.length >= 1 || 
    multiTransfer.incomingManifest != null || 
    multiTransfer.multiTransferState === 'sending' ||
    multiTransfer.multiTransferState === 'receiving' || 
    multiTransfer.multiTransferState === 'completed' ||
    multiTransfer.multiTransferState === 'error';

  // Message Protocol (routes messages to appropriate handlers)
  const { setMultiFileMode } = useMessages(
    dataChannelRef,
    dataChannelReady,
    isHost,
    security,
    transfer,
    multiTransfer,
    uiState,
    addLog,
    sendJSON,
    roomId,
    security.myUUID?.current,
    security.sessionToken,
    security.peerSessionToken,
    negotiatedConfigRef
  );

  // Resume Transfer (handles resume handshake when entering with resume context)
  const resumeFlow = useResumeTransfer({
    dataChannelReady,
    addLog,
  });

  // When resume is accepted, store the startFromChunk for sendFileChunks
  useEffect(() => {
    if (resumeFlow.resumeState === 'accepted' && resumeFlow.resumeInfo?.startFromChunk !== undefined) {
      // Store in the transfer hook so it knows where to resume from
      // This will be picked up by sendFileChunks when receiver-ready is received
      if (transfer.setResumeFromChunk) {
        transfer.setResumeFromChunk(resumeFlow.resumeInfo.startFromChunk);
      }
      
      // For sender: actually resume the transfer
      if (isHost && transfer.resumeTransfer) {
        try {
          transfer.resumeTransfer();
        } catch (error) {
          addLog(`Failed to resume transfer: ${error.message}`, 'error');
        }
      }
    }
  }, [resumeFlow.resumeState, resumeFlow.resumeInfo, transfer, isHost, addLog]);

  // ★ FALLBACK: When resume times out or is rejected, fall back to fresh transfer
  // This effect detects when resume fails and triggers a fresh start automatically
  useEffect(() => {
    if (resumeFlow.resumeState === 'timeout' || resumeFlow.resumeState === 'rejected') {
      // Prevent repeated auto-starts if this effect fires multiple times
      if (resumeFallbackFiredRef.current) return;
      resumeFallbackFiredRef.current = true;

      // Resume failed — fall back to fresh transfer start
      addLog('Auto-starting fresh transfer after resume failed', 'info');
      
      if (isMultiFile && isHost && selectedFiles.length > 0) {
        // Multi-file sender: restart with fresh files
        setMultiFileMode(true);
        setTimeout(() => {
          multiTransfer.startMultiTransfer();
        }, 300);
      } else if (!isMultiFile && isHost && selectedFile) {
        // Single-file sender: restart with fresh file
        setMultiFileMode(false);
        startTransfer();
      } else if (!isMultiFile && !isHost) {
        // Single-file receiver: wait for sender to re-initiate
        addLog('Waiting for sender to re-initiate transfer...', 'info');
      } else if (isMultiFile && !isHost) {
        // Multi-file receiver: wait for sender to re-send manifest
        addLog('Waiting for sender to restart transfer...', 'info');
      }
    }
  }, [resumeFlow.resumeState, isMultiFile, isHost, selectedFiles, selectedFile, addLog, startTransfer, multiTransfer, setMultiFileMode]);

  // Reset resume fallback guard when resume state resets to idle
  useEffect(() => {
    if (resumeFlow.resumeState === 'idle') {
      resumeFallbackFiredRef.current = false;
    }
  }, [resumeFlow.resumeState]);

  // ============ HEARTBEAT & NOTIFICATIONS ============
  // Initialize notifications on mount and set up heartbeat monitor for connection health
  useEffect(() => {
    initNotifications();
    addLog('Transfer notifications enabled', 'info');
  }, [addLog]);

  // Start heartbeat monitor when peer connects, stop when disconnects
  useEffect(() => {
    if (dataChannelReady) {
      const sendHeartbeatMessage = () => {
        try {
          sendJSON({ type: 'heartbeat' });
        } catch (error) {
          console.warn('[Room] Failed to send heartbeat:', error);
        }
      };

      const handleHeartbeatLost = async (lostRoomId) => {
        if (lostRoomId !== roomId) return;
        const currentState = isMultiFile ? multiTransfer.multiTransferState : transferState;
        const transferActive = currentState === 'sending' || currentState === 'receiving' || currentState === 'preparing';

        if (transferActive) {
          addLog('Heartbeat delayed during active transfer — keeping current connection', 'warning');
          return;
        }

        addLog('Connection heartbeat missed — attempting recovery...', 'warning');
        await requestConnectionRecovery?.('heartbeat-timeout');
      };

      const handleHeartbeatRestored = (restoredRoomId) => {
        if (restoredRoomId !== roomId) return;
        addLog('Connection heartbeat restored', 'success');
      };

      const unsubLost = heartbeatMonitor.onLost(handleHeartbeatLost);
      const unsubRestored = heartbeatMonitor.onRestored(handleHeartbeatRestored);
      heartbeatMonitor.start(roomId, sendHeartbeatMessage);
      addLog('Connection health monitoring active', 'info');

      return () => {
        unsubLost();
        unsubRestored();
        heartbeatMonitor.stop(roomId);
      };
    }
  }, [
    dataChannelReady,
    roomId,
    sendJSON,
    addLog,
    requestConnectionRecovery,
    isMultiFile,
    transferState,
    multiTransfer.multiTransferState,
  ]);

  // ============ AUTO-PAUSE ON DISCONNECT ============
  const autoPausedRef = useRef(false);
  const wasDisconnectedRef = useRef(false);
  const awaitingIdentityRef = useRef(false); // true while waiting for identity check
  const hasHandledResumeRef = useRef(false); // Prevents resume flow from running multiple times

  useEffect(() => {
    if (!peerDisconnected) {
      // Peer reconnected
      if (wasDisconnectedRef.current) {
        const wasActive = autoPausedRef.current;
        const currentState = isMultiFile ? multiTransfer.multiTransferState : transferState;
        const isErrored = currentState === 'error';

        if (wasActive || isErrored) {
          // Don't reset yet — wait for identity handshake to determine
          // if this is the same peer (resume) or a new peer (reset).
          awaitingIdentityRef.current = true;
          addLog('Peer reconnected — verifying identity...', 'info');
        }
      }
      autoPausedRef.current = false;
      wasDisconnectedRef.current = false;
      return;
    }

    // Peer disconnected — mark and auto-pause any active transfer
    wasDisconnectedRef.current = true;
    hasHandledResumeRef.current = false; // Allow resume flow to run again on reconnection
    const activeState = isMultiFile ? multiTransfer.multiTransferState : transferState;
    const isActive = activeState === 'sending' || activeState === 'receiving';

    if (isActive && !isPaused && !autoPausedRef.current) {
      autoPausedRef.current = true;
      addLog('Peer disconnected — auto-pausing transfer', 'warning');

      if (isMultiFile) {
        multiTransfer.pauseAll?.();
      } else {
        pauseTransfer?.();
      }

      // Save progress to IndexedDB
      if (transfer.transferId) {
        tracking.trackTransferPause(transfer.transferId);
      }
    }
  }, [peerDisconnected, transferState, multiTransfer.multiTransferState, isMultiFile, isPaused]);

  // ============ IN-ROOM RECONNECTION RESUME ============
  // After identity handshake completes, decide: resume (same peer) or reset (new peer).
  // This effect fires when `identityVerified` transitions to true.
  // Handles three cases:
  //   1. Reconnection after disconnect (awaitingIdentityRef was set)
  //   2. Page refresh with interrupted transfer in IndexedDB
  //   3. Fresh connection (no interrupted transfer)
  
  useEffect(() => {
    // Wait for identity verification to complete
    if (!identityVerified) return;
    
    // Only run once per connection
    if (hasHandledResumeRef.current) return;
    
    // Check if we should attempt resume:
    // - Either we were waiting for identity (in-session reconnect)
    // - OR we just connected and found an interrupted transfer (cross-session/refresh)
    const shouldAttemptResume = awaitingIdentityRef.current || (isReturningPeer && interruptedTransfer);
    
    if (!shouldAttemptResume) {
      // No interrupted transfer — normal connection, nothing to do
      return;
    }
    
    // For multi-file transfers, wait for data channel to be ready before proceeding
    // (channel pool must be established to create additional channels)
    const isMultiFileTransfer = !!interruptedTransfer?.fileManifest;
    if (isMultiFileTransfer && !dataChannelReady) {
      // Wait for channel to be ready, this effect will re-run when dataChannelReady changes
      return;
    }
    
    // Mark as handled
    hasHandledResumeRef.current = true;
    awaitingIdentityRef.current = false;

    if (isReturningPeer && interruptedTransfer) {
      // ── Same peer with an interrupted transfer → auto-resume ──
      const isSender = interruptedTransfer.direction === 'sending';
      const hasFiles = selectedFiles.length > 0;
      const isMultiFileTransfer = !!interruptedTransfer.fileManifest;

      if (isMultiFileTransfer) {
        // ── Multi-file in-room reconnection ──
        // Old manager/receiver has dead channels — reset instances but keep mode
        multiTransfer.resetTransfer();
        resetTransferState();
        resetUiTransferState();

        if (isSender) {
          // Sender: always try resume protocol first (with auto-fallback to fresh if it fails)
          // Restore file manifest to resumeContext for resume handshake
          setMultiFileMode(true);
          addLog('Same peer returned — attempting to resume multi-file transfer', 'success');
          
          const resumeCtx = {
            transferId: interruptedTransfer.transferId,
            fileName: interruptedTransfer.fileName,
            fileSize: interruptedTransfer.fileSize,
            totalChunks: interruptedTransfer.totalChunks,
            chunkBitmap: interruptedTransfer.chunkBitmap || null,
            direction: 'sending',
            fileManifest: interruptedTransfer.fileManifest,
            progress: interruptedTransfer.lastProgress || 0,
            inRoom: true,
            isMultiFile: true,
          };
          
          const { setResumeContext } = useRoomStore.getState();
          setResumeContext(resumeCtx);
          
          // If resume times out or fails, useResumeTransfer will clear context
          // and Room will fall back to fresh transfer start
        } else {
          // Receiver: restore multi-file mode and wait for sender to re-send manifest
          setMultiFileMode(true);
          addLog('Same peer returned — waiting for sender to restart transfer', 'info');
        }
      } else {
        // ── Single-file transfer — use resume protocol ──
        const resumeCtx = {
          transferId: interruptedTransfer.transferId,
          fileName: interruptedTransfer.fileName,
          fileSize: interruptedTransfer.fileSize,
          totalChunks: interruptedTransfer.totalChunks,
          chunkBitmap: interruptedTransfer.chunkBitmap || null,
          direction: isSender ? 'sending' : 'receiving',
          fileManifest: null,
          progress: interruptedTransfer.lastProgress || 0,
          inRoom: true,
        };

        multiTransfer.resetTransfer();
        resetTransferState();
        resetUiTransferState();
        setMultiFileMode(false);

        if (isSender) {
          // Sender-side: always try resume protocol (auto-fallback to fresh if it fails)
          // Don't prompt for file re-selection — let resume handshake timeout/fail, then fall back to fresh
          transfer.initializeResume(resumeCtx.transferId);
          addLog('Same peer returned — attempting to resume transfer', 'success');
          const { setResumeContext } = useRoomStore.getState();
          setResumeContext(resumeCtx);
          
          // If resume times out or is rejected, clearResumeContext() fires
          // and that triggers the fallback to fresh transfer start
        } else {
          // Receiver-side resume: initialize assembly & restore file writer
          addLog('Same peer returned — resuming reception', 'success');
          
          // Initialize assembly engine with the resumed transfer metadata
          // For resumed transfers, don't prompt for save location again — just resume
          transfer.initializeReceive(
            {
              transferId: resumeCtx.transferId,
              name: resumeCtx.fileName,
              size: resumeCtx.fileSize,
              mimeType: interruptedTransfer.mimeType || 'application/octet-stream',
            },
            (pendingFileData) => {
              // Store pending file data
              uiState.setPendingFileData(pendingFileData);
            }
          ).then(async () => {
            // Assembly initialized — now restore the file writer
            // setupFileWriter with resume=true will prompt user to select the file again
            // (browser security requirement for File System Access API)
            try {
              addLog('Please select the file again to resume receiving (browser security requirement).', 'info');
              await transfer.setupFileWriter(resumeCtx.fileName, () => {
                addLog('File selected — resuming reception', 'success');
              });
              
              // File writer ready — now trigger resume protocol
              const { setResumeContext } = useRoomStore.getState();
              setResumeContext(resumeCtx);
            } catch (error) {
              addLog(`Failed to restore file writer: ${error.message}`, 'error');
            }
          }).catch((error) => {
            addLog(`Failed to initialize resume: ${error.message}`, 'error');
          });
        }
      }
    } else {
      // ── New/different peer or no interrupted transfer → full reset ──
      addLog('Peer reconnected — ready to re-send', 'info');
      multiTransfer.resetTransfer();
      resetTransferState();
      resetUiTransferState();
      setMultiFileMode(false);
    }
  }, [identityVerified, isReturningPeer, interruptedTransfer, dataChannelReady]);

  // ============ PROGRESS PERSISTENCE ============
  // Periodically save transfer progress to IndexedDB during active transfers
  useEffect(() => {
    // For multi-file transfers, transfer.transferId is null — use the tracking ID instead
    const currentTransferId = transfer.transferId || tracking.activeTrackingId?.current;
    if (!currentTransferId) return;

    const currentState = isMultiFile ? multiTransfer.multiTransferState : transferState;
    const currentProgress = isMultiFile ? multiTransfer.overallProgress : transferProgress;

    if (currentState === 'sending' || currentState === 'receiving') {
      tracking.trackTransferProgress({
        transferId: currentTransferId,
        progress: currentProgress,
      });
    }

    // Track completion
    if (currentState === 'completed') {
      tracking.trackTransferComplete(currentTransferId);
    }
  }, [transferProgress, multiTransfer.overallProgress, transferState, multiTransfer.multiTransferState]);

  // ============ RECEIVER-SIDE TRANSFER TRACKING ============
  // Track incoming transfers in IndexedDB so receiver can also recover on reconnect
  // Skip if resuming — transfer record already exists from previous session
  useEffect(() => {
    if (isHost || !pendingFile || !transfer.transferId) return;
    if (resumeFlow.resumeContext) return; // Skip if resuming

    // Single-file receive: track when we receive file-metadata
    const totalChunks = pendingFile.totalChunks || Math.ceil((pendingFile.size || 0) / STORAGE_CHUNK_SIZE);
    tracking.trackTransferStart({
      transferId: transfer.transferId,
      fileName: pendingFile.name,
      fileSize: pendingFile.size,
      totalChunks,
      direction: 'receiving',
    });
  }, [pendingFile, resumeFlow.resumeContext]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isHost || !multiTransfer.incomingManifest) return;
    if (resumeFlow.resumeContext) return; // Skip if resuming

    // Multi-file receive: track the overall manifest as a single recoverable transfer
    const manifest = multiTransfer.incomingManifest;
    const transferId = `multi-recv-${roomId}-${Date.now()}`;
    const totalChunks = (manifest.files || []).reduce(
      (sum, f) => sum + Math.ceil((f.size || 0) / STORAGE_CHUNK_SIZE), 0
    );
    tracking.trackTransferStart({
      transferId,
      fileName: `${manifest.totalFiles} files`,
      fileSize: manifest.totalSize || 0,
      totalChunks,
      direction: 'receiving',
      fileManifest: (manifest.files || []).map((f, i) => ({
        fileName: f.name,
        fileSize: f.size,
        totalChunks: Math.ceil((f.size || 0) / STORAGE_CHUNK_SIZE),
        index: f.index ?? i,
        status: 'pending',
      })),
    });
  }, [multiTransfer.incomingManifest, resumeFlow.resumeContext]); // eslint-disable-line react-hooks/exhaustive-deps

  // ============ UI HANDLERS ============

  const handleStartTransfer = () => {
    // Check if resuming — use existing transferId from resume context
    const resumeTransferId = resumeFlow.resumeContext?.transferId;
    let actualTransferId = null;

    if (isMultiFile) {
      // Tell message handler we're in multi-file mode (sender-side)
      setMultiFileMode(true);
      multiTransfer.startMultiTransfer();
    } else {
      setMultiFileMode(false);
      actualTransferId = startTransfer(resumeTransferId); // Returns the transferId
    }

    // Track transfer start in IndexedDB for crash recovery
    // Skip if resuming — transfer record already exists
    if (isHost && !resumeFlow.resumeContext) {
      if (isMultiFile && selectedFiles.length > 0) {
        // Multi-file send — totalChunks is the sum of per-file chunks, not the file count
        const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
        const totalChunks = selectedFiles.reduce((sum, f) => sum + Math.ceil(f.size / STORAGE_CHUNK_SIZE), 0);
        tracking.trackTransferStart({
          transferId: `multi-${roomId}-${Date.now()}`,
          fileName: `${selectedFiles.length} files`,
          fileSize: totalSize,
          totalChunks,
          direction: 'sending',
          fileManifest: selectedFiles.map((f, i) => ({
            fileName: f.name || f.file?.name,
            fileSize: f.size || f.file?.size,
            totalChunks: Math.ceil((f.size || f.file?.size || 0) / STORAGE_CHUNK_SIZE),
            index: i,
            status: 'pending',
          })),
        });
      } else if (selectedFile && actualTransferId) {
        // Single-file send — use the actual transferId from startTransfer()
        tracking.trackTransferStart({
          transferId: actualTransferId,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          totalChunks: Math.ceil(selectedFile.size / STORAGE_CHUNK_SIZE),
          direction: 'sending',
        });
      }
    }
  };

  const handleReset = () => {
    // Clean up tracking for current transfer
    if (transfer.transferId) {
      tracking.trackTransferCancel(transfer.transferId);
    }
    // Reset multi-file transfer state
    multiTransfer.resetTransfer();
    // Reset single-file transfer state so UI doesn't show stale 'completed'
    resetTransferState();
    // Reset UI state (pendingFile, downloadResult, awaitingSaveLocation)
    resetUiTransferState();
    // Reset message handler mode
    setMultiFileMode(false);
    // Clear file selections so user can pick new files
    clearFiles();
  };

  const handleSelectSaveLocation = async () => {
    await setupFileWriter(pendingFile?.name, clearPendingFile);
  };

  const handleLeave = () => {
    // If there's an active transfer in progress, mark it as interrupted in IndexedDB
    // so Home page can offer a Resume option. Don't delete it — user may want to resume.
    const currentTransferId = transfer.transferId;
    const currentState = isMultiFile ? multiTransfer.multiTransferState : transferState;
    const isActive = currentState === 'sending' || currentState === 'receiving' || currentState === 'paused';

    if (currentTransferId && isActive) {
      // Flush bitmap and mark interrupted (fire-and-forget)
      tracking.flushBitmap().then(() => {
        updateTransfer(currentTransferId, {
          status: 'interrupted',
          interruptedAt: Date.now(),
        }).catch(() => {}); // best-effort
      }).catch(() => {});
    }

    // Close data channel, peer connection, and all WebRTC resources
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
    }
    closePeerConnection();

    leaveRoom();
    disconnectSocket();

    resetRoom();
    navigate('/');
  };

  // ============ RENDER ============

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
      {/* Peer Disconnected Banner */}
      {peerDisconnected && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-900/95 border-b border-red-700 px-4 py-3 text-center animate-in slide-in-from-top">
          <div className="flex items-center justify-center gap-3">
            <span className="text-red-200 text-sm font-medium">
              ⚠️ Peer has disconnected
              {(isMultiFile ? multiTransfer.multiTransferState : transferState) === 'sending' || 
               (isMultiFile ? multiTransfer.multiTransferState : transferState) === 'receiving'
                ? ` — transfer paused at ${Math.round(isMultiFile ? multiTransfer.overallProgress : transferProgress)}%`
                : ''}
            </span>
            <button
              onClick={handleLeave}
              className="px-3 py-1 bg-red-800 hover:bg-red-700 text-red-100 text-xs rounded-lg transition-colors"
            >
              Leave Room
            </button>
          </div>
        </div>
      )}

      {/* Resume Negotiation Banner */}
      {resumeFlow.resumeState === 'proposing' && (
        <div className="fixed top-0 left-0 right-0 z-40 bg-blue-900/95 border-b border-blue-700 px-4 py-3 text-center">
          <span className="text-blue-100 text-sm font-medium">
            ⏳ Negotiating transfer resume with peer...
          </span>
        </div>
      )}

      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              File Transfer
            </h1>
            <p className="text-zinc-500 text-xs font-mono mt-0.5">Room: {roomId}</p>
          </div>
          <button
            onClick={handleLeave}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-400 transition-colors"
          >
            Leave
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left Column - Room Link, Leave Button, File Info, File Actions */}
          <div className="space-y-4">
            {/* Share URL & QR Code (host only) */}
            {isHost && shareUrl && (
              <div className={`bg-zinc-900 border rounded-xl p-4 transition-all ${
                !dataChannelReady 
                  ? 'border-blue-500 shadow-lg shadow-blue-500/20' 
                  : 'border-zinc-800'
              }`}>
                <h2 className="text-sm font-medium text-zinc-400 mb-3">
                  {!dataChannelReady ? '📱 Share this link to connect' : '🔗 Room Link'}
                </h2>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={shareUrl}
                      className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-mono text-zinc-300"
                    />
                    <button
                      onClick={() => handleCopy(shareUrl)}
                      className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors"
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <button
                    onClick={() => setShowQRCode(!showQRCode)}
                    className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors"
                  >
                    {showQRCode ? 'Hide QR Code' : 'Show QR Code'}
                  </button>
                  {showQRCode && (
                    <div className="flex justify-center p-4 bg-zinc-800 rounded-lg">
                      <img 
                        src={getQRCodeUrl(shareUrl)} 
                        alt="Room QR Code" 
                        className="w-40 h-40"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* File Transfer UI - File Info & Send Button */}
            <TransferSection
              isHost={isHost}
              selectedFile={selectedFile}
              selectedFiles={selectedFiles}
              isMultiFile={isMultiFile}
              pendingFile={pendingFile}
              awaitingSaveLocation={awaitingSaveLocation}
              onAcceptFile={handleSelectSaveLocation}
              transferState={isMultiFile ? multiTransfer.multiTransferState : transferState}
              transferProgress={isMultiFile ? multiTransfer.overallProgress : transferProgress}
              transferSpeed={isMultiFile ? multiTransfer.speed : transferSpeed}
              transferEta={isMultiFile ? multiTransfer.eta : transferEta}
              isPaused={isMultiFile ? multiTransfer.isPaused : isPaused}
              pausedBy={isMultiFile ? multiTransfer.pausedBy : transfer.pausedBy}
              onPause={isMultiFile ? multiTransfer.pauseAll : pauseTransfer}
              onResume={isMultiFile ? multiTransfer.resumeAll : resumeTransfer}
              onCancel={isMultiFile ? multiTransfer.cancelAll : cancelTransfer}
              downloadResult={downloadResult}
              tofuVerified={tofuVerified}
              dataChannelReady={dataChannelReady}
              onStartTransfer={handleStartTransfer}
              roomError={roomError}
              perFileProgress={multiTransfer.perFileProgress}
              channelCount={multiTransfer.channelCount}
              transferMode={multiTransfer.transferMode}
              onTransferModeChange={multiTransfer.setTransferMode}
              incomingManifest={multiTransfer.incomingManifest}
              awaitingDirectory={multiTransfer.awaitingDirectory}
              onAcceptMultiFile={multiTransfer.acceptMultiFileTransfer}
              onAddFiles={(files) => addFiles(files)}
              onRemoveFile={(idx) => removeFile(idx)}
              onClearFiles={() => clearFiles()}
              onReset={handleReset}
            />

            {/* Error Display */}
            <ErrorDisplay error={roomError} />
          </div>

          {/* Right Column - Connection Status, Activity Log */}
          <div className="space-y-3">
            {/* Connection Status — compact combined card */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-zinc-400">Connection</h2>
                {/* Mini status dots */}
                <div className="flex items-center gap-1.5">
                  {[
                    { label: 'Socket', done: socketConnected },
                    { label: 'P2P', done: dataChannelReady },
                    { label: 'Verified', done: tofuVerified },
                  ].map((s) => (
                    <div
                      key={s.label}
                      title={`${s.label}: ${s.done ? 'Connected' : 'Pending'}`} 
                      className={`w-2.5 h-2.5 rounded-full transition-colors ${s.done ? 'bg-emerald-500' : 'bg-zinc-700'}`}
                    />
                  ))}
                </div>
              </div>

              {/* Inline connection details */}
              {connInfo && (
                <div className="space-y-1.5 text-xs">
                  {connInfo.candidateType && (() => {
                    // Derive effective connection type from BOTH local & remote candidates.
                    // If either side uses relay/srflx/prflx, the connection crosses NAT/relay.
                    // Also use RTT as a sanity check: >10ms means definitely not LAN,
                    // even if both candidates report "host" (NAT hairpinning can cause this).
                    const local = connInfo.candidateType;
                    const remote = connInfo.remoteCandidateType || local;
                    const either = (t) => local === t || remote === t;
                    let effectiveType = either('relay') ? 'relay'
                      : (either('srflx') || either('prflx')) ? 'srflx'
                      : 'host';
                    // RTT-based override: if candidates say "host" but latency > 10ms,
                    // it's crossing networks (STUN NAT traversal with host candidates)
                    if (effectiveType === 'host' && connInfo.rtt > 10) {
                      effectiveType = 'srflx';
                    }
                    const label = effectiveType === 'host' ? 'Direct (LAN)'
                      : effectiveType === 'srflx' ? 'STUN (NAT)'
                      : effectiveType === 'relay' ? 'TURN (Relay)'
                      : effectiveType;
                    const color = effectiveType === 'host' ? 'text-emerald-400' : 'text-yellow-400';
                    return (
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Type</span>
                        <span className={color}>{label}</span>
                      </div>
                    );
                  })()}
                  {connInfo.protocol && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Protocol</span>
                      <span className="text-zinc-300 uppercase">{connInfo.protocol}</span>
                    </div>
                  )}
                  {connInfo.availableOutgoingBitrate != null && connInfo.availableOutgoingBitrate > 0 && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Bandwidth</span>
                      <span className="text-zinc-300">
                        {(connInfo.availableOutgoingBitrate / 1000000).toFixed(1)} Mbps
                      </span>
                    </div>
                  )}
                  {connInfo.rtt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Latency</span>
                      <span className="text-zinc-300">{connInfo.rtt.toFixed(0)} ms</span>
                    </div>
                  )}
                  {multiTransfer.channelCount > 1 && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Channels</span>
                      <span className="text-blue-400">{multiTransfer.channelCount}</span>
                    </div>
                  )}
                </div>
              )}

              {!connInfo && (
                <p className="text-xs text-zinc-600">Establishing connection...</p>
              )}
            </div>

            {/* Activity Log */}
            <ActivityLogSection logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
