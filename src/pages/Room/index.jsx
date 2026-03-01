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
import { TRANSFER_MODE, STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';

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
  ConnectionSection,
  SecuritySection,
  TransferSection,
  ActivityLogSection,
} from './components/index.js';

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { isHost, securityPayload, selectedFiles, addFiles, removeFile, clearFiles, resetRoom, error: roomError } = useRoomStore();
  const [showQRCode, setShowQRCode] = useState(false);

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
  const { socketConnected, dataChannelReady, shareUrl, connInfo, peerDisconnected, sendJSON, sendBinary, waitForDrain, dataChannelRef } = connection;

  // Security (encrypted signaling verification)
  const security = useSecurity(roomId, sendJSON, addLog);
  const { verificationStatus, identityVerified, tofuVerified } = security;

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

  // Resume callbacks ref — breaks circular dependency between useMessages and useResumeTransfer
  const resumeCallbacksRef = useRef({ onResumeAccepted: null, onResumeRejected: null });

  // Message Protocol (routes messages to appropriate handlers)
  const { setMultiFileMode, sendResumeRequest } = useMessages(
    dataChannelRef,
    dataChannelReady,
    isHost,
    security,
    transfer,
    multiTransfer,
    uiState,
    addLog,
    sendJSON,
    resumeCallbacksRef.current
  );

  // Resume Transfer (handles resume handshake when entering with resume context)
  const resumeFlow = useResumeTransfer({
    dataChannelReady,
    sendResumeRequest,
    addLog,
  });

  // Wire resume callbacks after both hooks are initialized
  resumeCallbacksRef.current.onResumeAccepted = resumeFlow.onResumeAccepted;
  resumeCallbacksRef.current.onResumeRejected = resumeFlow.onResumeRejected;

  // When resume is accepted, store the startFromChunk for sendFileChunks
  useEffect(() => {
    if (resumeFlow.resumeState === 'accepted' && resumeFlow.resumeInfo?.startFromChunk !== undefined) {
      // Store in the transfer hook so it knows where to resume from
      // This will be picked up by sendFileChunks when receiver-ready is received
      if (transfer.setResumeFromChunk) {
        transfer.setResumeFromChunk(resumeFlow.resumeInfo.startFromChunk);
      }
    }
  }, [resumeFlow.resumeState, resumeFlow.resumeInfo, transfer]);

  // ============ AUTO-PAUSE ON DISCONNECT ============
  const autoPausedRef = useRef(false);
  const wasDisconnectedRef = useRef(false);

  useEffect(() => {
    if (!peerDisconnected) {
      // Peer reconnected — reset transfer machinery but KEEP files so sender can re-send
      if (wasDisconnectedRef.current) {
        const wasActive = autoPausedRef.current;
        const currentState = isMultiFile ? multiTransfer.multiTransferState : transferState;
        const isErrored = currentState === 'error';

        if (wasActive || isErrored) {
          addLog('Peer reconnected — ready to re-send', 'info');
          multiTransfer.resetTransfer();
          resetTransferState();
          resetUiTransferState();
          setMultiFileMode(false);
          // Do NOT call clearFiles() — sender's file selection survives reconnect
          // so the Send button reappears once data channel opens.
        }
      }
      autoPausedRef.current = false;
      wasDisconnectedRef.current = false;
      return;
    }

    // Peer disconnected — mark and auto-pause any active transfer
    wasDisconnectedRef.current = true;
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

  // ============ PROGRESS PERSISTENCE ============
  // Periodically save transfer progress to IndexedDB during active transfers
  useEffect(() => {
    const currentTransferId = transfer.transferId;
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
    tracking.trackTransferStart({
      transferId: transfer.transferId,
      fileName: pendingFile.name,
      fileSize: pendingFile.size,
      totalChunks: pendingFile.totalChunks || 0,
      direction: 'receiving',
    });
  }, [pendingFile, resumeFlow.resumeContext]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isHost || !multiTransfer.incomingManifest) return;
    if (resumeFlow.resumeContext) return; // Skip if resuming

    // Multi-file receive: track the overall manifest as a single recoverable transfer
    const manifest = multiTransfer.incomingManifest;
    const transferId = `multi-${roomId}-${Date.now()}`;
    tracking.trackTransferStart({
      transferId,
      fileName: `${manifest.totalFiles} files`,
      fileSize: manifest.totalSize || 0,
      totalChunks: manifest.totalFiles || 0,
      direction: 'receiving',
    });
  }, [multiTransfer.incomingManifest, resumeFlow.resumeContext]); // eslint-disable-line react-hooks/exhaustive-deps

  // ============ UI HANDLERS ============

  const handleStartTransfer = () => {
    // Check if resuming — use existing transferId from resume context
    const resumeTransferId = resumeFlow.resumeContext?.transferId;

    if (isMultiFile) {
      // Tell message handler we're in multi-file mode (sender-side)
      setMultiFileMode(true);
      multiTransfer.startMultiTransfer();
    } else {
      setMultiFileMode(false);
      startTransfer(resumeTransferId); // Pass resumeTransferId if resuming
    }

    // Track transfer start in IndexedDB for crash recovery
    // Skip if resuming — transfer record already exists
    if (isHost && !resumeFlow.resumeContext) {
      if (isMultiFile && selectedFiles.length > 0) {
        // Multi-file send
        const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
        tracking.trackTransferStart({
          transferId: `multi-${roomId}-${Date.now()}`,
          fileName: `${selectedFiles.length} files`,
          fileSize: totalSize,
          totalChunks: selectedFiles.length,
          direction: 'sending',
        });
      } else if (selectedFile) {
        // Single-file send (only if NOT multi-file to prevent duplicates)
        tracking.trackTransferStart({
          transferId: transfer.transferId || `${roomId}-${Date.now()}`,
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

      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-light tracking-tight mb-1">
            File Transfer
          </h1>
          <p className="text-zinc-500 text-sm font-mono">Room: {roomId}</p>
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

            {/* Leave Button */}
            <button
              onClick={handleLeave}
              className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-400 transition-colors"
            >
              Leave Room
            </button>
          </div>

          {/* Right Column - Connection Status, Security, Activity Log */}
          <div className="space-y-4">
            {/* Connection Status */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Status</h2>
              <div className="space-y-3">
                <div className="flex justify-between">
                  {[
                    { label: 'Socket', done: socketConnected },
                    { label: 'P2P', done: dataChannelReady },
                    { label: 'Verified', done: tofuVerified },
                  ].map((status, i) => (
                    <div key={status.label} className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full ${status.done ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                      <span className="text-sm text-zinc-400">{status.label}</span>
                      {i < 2 && <div className="w-8 h-px bg-zinc-800 ml-2" />}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Connection Details */}
            {connInfo && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <h2 className="text-sm font-medium text-zinc-400 mb-3">Connection Details</h2>
                <div className="space-y-2 text-sm">
                  {connInfo.socketId && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Socket ID</span>
                      <span className="text-emerald-500 font-mono text-xs">{connInfo.socketId}</span>
                    </div>
                  )}
                  {connInfo.iceState && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">ICE State</span>
                      <span className={connInfo.iceState === 'connected' || connInfo.iceState === 'completed' ? 'text-emerald-500' : 'text-zinc-400'}>
                        {connInfo.iceState}
                      </span>
                    </div>
                  )}
                  {connInfo.rtcState && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">RTC State</span>
                      <span className={connInfo.rtcState === 'connected' ? 'text-emerald-500' : 'text-zinc-400'}>
                        {connInfo.rtcState}
                      </span>
                    </div>
                  )}
                  {connInfo.dataChannelState && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Data Channel</span>
                      <span className={connInfo.dataChannelState === 'open' ? 'text-emerald-500' : 'text-zinc-400'}>
                        {connInfo.dataChannelState}
                      </span>
                    </div>
                  )}
                  {/* Multi-channel info */}
                  {multiTransfer.channelCount > 1 && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Active Channels</span>
                      <span className="text-blue-400">{multiTransfer.channelCount}</span>
                    </div>
                  )}
                  {/* Transfer mode */}
                  {isMultiFile && (multiTransfer.multiTransferState === 'sending' || multiTransfer.multiTransferState === 'receiving') && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Transfer Mode</span>
                      <span className="text-zinc-300">
                        {multiTransfer.transferMode === TRANSFER_MODE.PARALLEL ? 'Parallel' : 'Sequential'}
                      </span>
                    </div>
                  )}
                  {/* Candidate type & protocol from WebRTC stats */}
                  {connInfo.candidateType && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Connection Type</span>
                      <span className={connInfo.candidateType === 'host' ? 'text-emerald-400' : 'text-yellow-400'}>
                        {connInfo.candidateType === 'host' ? 'Direct (LAN)' :
                         connInfo.candidateType === 'srflx' ? 'STUN (NAT)' :
                         connInfo.candidateType === 'relay' ? 'TURN (Relay)' :
                         connInfo.candidateType === 'prflx' ? 'Peer Reflexive' :
                         connInfo.candidateType}
                      </span>
                    </div>
                  )}
                  {connInfo.protocol && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Protocol</span>
                      <span className="text-zinc-300 uppercase">{connInfo.protocol}</span>
                    </div>
                  )}
                  {connInfo.availableOutgoingBitrate != null && connInfo.availableOutgoingBitrate > 0 && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Est. Bandwidth</span>
                      <span className="text-zinc-300">
                        {(connInfo.availableOutgoingBitrate / 1000000).toFixed(1)} Mbps
                      </span>
                    </div>
                  )}
                  {connInfo.rtt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">RTT</span>
                      <span className="text-zinc-300">{connInfo.rtt.toFixed(0)} ms</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Activity Log */}
            <ActivityLogSection logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
