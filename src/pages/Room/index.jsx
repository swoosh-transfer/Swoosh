/**
 * Room Page - Refactored and Modular
 * Composes hooks and components for clean, maintainable architecture
 * 
 * Down from 1,401 lines to ~200 lines ✨
 */
import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useRoomStore } from '../../stores/roomStore.js';
import { ErrorDisplay, CrashRecoveryPrompt } from '../../components/RoomUI.jsx';

// Custom hooks
import {
  useRoomState,
  useRoomConnection,
  useSecurity,
  useFileTransfer,
  useMessages,
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
  const { isHost, securityPayload, selectedFile, resetRoom, error: roomError } = useRoomStore();

  // ============ HOOKS ============
  
  // UI State (logs, copy state, pending file, etc.)
  const uiState = useRoomState();
  const { addLog, logs, copied, handleCopy, pendingFile, awaitingSaveLocation, downloadResult, recoverableTransfers, clearPendingFile, removeRecoverableTransfer } = uiState;

  // WebRTC Connection (socket, peer connection, data channel)
  const connection = useRoomConnection(
    roomId,
    isHost,
    (channel) => {
      // Data channel ready callback
      // Message handler will be set up by useMessages
      security.sendHandshake(channel);
    },
    addLog
  );
  const { socketConnected, dataChannelReady, shareUrl, connInfo, sendJSON, sendBinary, waitForDrain, dataChannelRef } = connection;

  // TOFU Security (identity verification, challenge/response)
  const security = useSecurity(roomId, sendJSON, addLog);
  const { verificationStatus, identityVerified, tofuVerified } = security;

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
    addLog
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
  } = transfer;

  // Message Protocol (routes messages to appropriate handlers)
  useMessages(
    dataChannelRef,
    isHost,
    security,
    transfer,
    uiState,
    addLog
  );

  // ============ UI HANDLERS ============

  const handleStartTransfer = () => {
    startTransfer();
  };

  const handleSelectSaveLocation = async () => {
    await setupFileWriter(pendingFile?.name, clearPendingFile);
  };

  const handleRecoverTransfer = (transferId) => {
    addLog(`Recovering transfer: ${transferId}`, 'info');
    removeRecoverableTransfer(transferId);
  };

  const handleDiscardRecovery = (transferId) => {
    removeRecoverableTransfer(transferId);
    addLog('Transfer discarded', 'info');
  };

  const handleSelectFileForRecovery = (transferId) => {
    addLog(`Select file to resume: ${transferId}`, 'info');
    removeRecoverableTransfer(transferId);
  };

  const handleLeave = () => {
    resetRoom();
    navigate('/');
  };

  // ============ RENDER ============

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
            {/* Connection Status & Share URL */}
            <ConnectionSection
              isHost={isHost}
              socketConnected={socketConnected}
              connInfo={connInfo}
              dataChannelReady={dataChannelReady}
              tofuVerified={tofuVerified}
              verificationStatus={verificationStatus}
              shareUrl={shareUrl}
              copied={copied}
              onCopy={handleCopy}
            />

            {/* Security Status (optional, mostly shown in StatusSection) */}
            {(identityVerified || tofuVerified) && (
              <SecuritySection
                identityVerified={identityVerified}
                verificationStatus={verificationStatus}
                tofuVerified={tofuVerified}
              />
            )}

            {/* File Transfer UI */}
            <TransferSection
              isHost={isHost}
              selectedFile={selectedFile}
              pendingFile={pendingFile}
              awaitingSaveLocation={awaitingSaveLocation}
              onAcceptFile={handleSelectSaveLocation}
              transferState={transferState}
              transferProgress={transferProgress}
              transferSpeed={transferSpeed}
              transferEta={transferEta}
              isPaused={isPaused}
              onPause={pauseTransfer}
              onResume={resumeTransfer}
              onCancel={cancelTransfer}
              downloadResult={downloadResult}
              tofuVerified={tofuVerified}
              dataChannelReady={dataChannelReady}
              onStartTransfer={handleStartTransfer}
              roomError={roomError}
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

          {/* Right Column */}
          <div className="space-y-4">
            {/* Activity Log */}
            <ActivityLogSection logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
