/**
 * TransferSection Component
 * Displays file transfer UI - file info, progress, controls
 */
import React from 'react';
import {
  FileInfo,
  IncomingFilePrompt,
  TransferProgressWithControls,
  TransferComplete,
  TransferInfoPanel,
} from '../../../components/RoomUI.jsx';

export function TransferSection({
  isHost,
  selectedFile,
  pendingFile,
  awaitingSaveLocation,
  onAcceptFile,
  transferState,
  transferProgress,
  transferSpeed,
  transferEta,
  isPaused,
  onPause,
  onResume,
  onCancel,
  downloadResult,
  tofuVerified,
  dataChannelReady,
  onStartTransfer,
  roomError,
}) {
  const isTransferring = transferState === 'sending' || transferState === 'receiving' || transferState === 'preparing';
  
  const transferInfo = {
    fileName: pendingFile?.name || selectedFile?.name,
    fileSize: pendingFile?.size || selectedFile?.size || 0,
    progress: transferProgress,
    speed: transferSpeed,
    eta: transferEta,
    isPaused: isPaused,
  };

  return (
    <div className="space-y-4">
      {/* Host: File Info */}
      {isHost && selectedFile && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <FileInfo file={selectedFile} />
        </div>
      )}

      {/* Receiver: Incoming file prompt */}
      {awaitingSaveLocation && pendingFile && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <IncomingFilePrompt file={pendingFile} onAccept={onAcceptFile} />
        </div>
      )}

      {/* Progress with Controls */}
      {isTransferring && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <TransferProgressWithControls
            progress={transferProgress}
            state={transferState}
            speed={transferSpeed}
            eta={transferEta}
            isPaused={isPaused}
            onPause={onPause}
            onResume={onResume}
            onCancel={onCancel}
          />
        </div>
      )}

      {/* Transfer Complete */}
      {transferState === 'completed' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <TransferComplete
            isHost={isHost}
            savedToFileSystem={downloadResult?.savedToFileSystem}
            fileName={pendingFile?.name}
          />
        </div>
      )}

      {/* Transfer Info Panel */}
      {transferInfo.fileName && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">Transfer</h2>
          <TransferInfoPanel info={transferInfo} />
        </div>
      )}

      {/* Host: Send Button */}
      {isHost && tofuVerified && dataChannelReady && transferState === 'idle' && (
        <button
          onClick={onStartTransfer}
          className="w-full py-3 bg-zinc-100 text-zinc-900 hover:bg-white rounded-xl font-medium transition-colors"
        >
          Send File
        </button>
      )}
    </div>
  );
}
