/**
 * TransferSection Component
 * Displays file transfer UI - file info, progress, controls
 * Supports both single-file and multi-file modes.
 */
import React from 'react';
import {
  FileInfo,
  IncomingFilePrompt,
  TransferProgressWithControls,
  TransferComplete,
  TransferInfoPanel,
} from '../../../components/RoomUI.jsx';
import FileDropZone from '../../../components/FileDropZone.jsx';
import { TRANSFER_MODE } from '../../../constants/transfer.constants.js';

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function TransferSection({
  isHost,
  selectedFile,
  selectedFiles = [],
  isMultiFile = false,
  pendingFile,
  awaitingSaveLocation,
  onAcceptFile,
  transferState,
  transferProgress,
  transferSpeed,
  transferEta,
  isPaused,
  pausedBy,
  onPause,
  onResume,
  onCancel,
  downloadResult,
  tofuVerified,
  dataChannelReady,
  onStartTransfer,
  roomError,
  // Multi-file props
  perFileProgress = [],
  channelCount = 1,
  transferMode,
  onTransferModeChange,
  incomingManifest,
  awaitingDirectory,
  onAcceptMultiFile,
  onAddFiles,
  onRemoveFile,
  onClearFiles,
  onReset,
}) {
  const isTransferring = transferState === 'sending' || transferState === 'receiving' || transferState === 'preparing';
  const isIdle = transferState === 'idle';
  const isCompleted = transferState === 'completed';
  const isError = transferState === 'error';

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
      {/* FileDropZone for adding files in-room — shown when idle for both sender and receiver */}
      {isIdle && !awaitingDirectory && !incomingManifest && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">
            {isHost ? 'Files to Send' : 'Send Files Back'}
          </h2>
          {!isHost && selectedFiles.length === 0 && (
            <p className="text-xs text-zinc-500 mb-3">
              You can also send files to the other peer. Select files below, or wait to receive.
            </p>
          )}
          <FileDropZone
            compact
            files={selectedFiles}
            onFilesAdded={onAddFiles}
            onFileRemoved={onRemoveFile}
            onFilesCleared={onClearFiles}
            disabled={isTransferring}
          />
        </div>
      )}

      {/* Transfer mode toggle — shown when files are selected (all transfers use multi-file path) */}
      {isIdle && selectedFiles.length >= 1 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">Transfer Mode</h2>
          <div className="flex rounded-lg overflow-hidden border border-zinc-700">
            <button
              onClick={() => onTransferModeChange?.(TRANSFER_MODE.SEQUENTIAL)}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                transferMode === TRANSFER_MODE.SEQUENTIAL
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              Sequential
            </button>
            <button
              onClick={() => onTransferModeChange?.(TRANSFER_MODE.PARALLEL)}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                transferMode === TRANSFER_MODE.PARALLEL
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              Parallel
            </button>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            {transferMode === TRANSFER_MODE.SEQUENTIAL
              ? 'Files sent one at a time (more reliable)'
              : 'Multiple files sent simultaneously (faster)'}
          </p>
        </div>
      )}

      {/* Large file / folder warning */}
      {isIdle && selectedFiles.length > 0 && (selectedFiles.some(f => f.file.size > 100 * 1024 * 1024) || selectedFiles.length > 5) && (
        <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl p-3">
          <p className="text-sm text-amber-300">
            ⚠️ <strong>Recommendation:</strong> For {selectedFiles.length > 5 ? 'many files or folders' : 'large files'}, compress them into a ZIP/RAR archive before sending.
            This significantly reduces transfer time, improves reliability, and keeps folder structure intact.
          </p>
        </div>
      )}

      {/* Host: Single-file info (legacy, shown when just one file) */}
      {isHost && !isMultiFile && selectedFile && isIdle && !onAddFiles && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <FileInfo file={selectedFile} />
        </div>
      )}

      {/* Receiver: Waiting for file loading state — only when no files selected to send */}
      {!isHost && selectedFiles.length === 0 && !pendingFile && !incomingManifest && dataChannelReady && !isTransferring && !isCompleted && !isError && (
        <div className="bg-zinc-900 border border-emerald-800 rounded-xl p-8">
          <div className="flex flex-col items-center justify-center">
            <div className="mb-6">
              <div className="flex gap-2">
                <div className="w-3 h-3 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-3 h-3 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-3 h-3 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
            <h2 className="text-lg font-medium text-emerald-400 mb-2">Waiting for file...</h2>
            <p className="text-sm text-zinc-500 text-center">Connected and ready. Sender can now share files.</p>
          </div>
        </div>
      )}

      {/* Receiver: Incoming multi-file manifest prompt */}
      {awaitingDirectory && incomingManifest && (
        <div className="bg-zinc-900 border border-emerald-800 rounded-xl p-4">
          <h2 className="text-base font-medium text-emerald-400 mb-3">
            Incoming: {incomingManifest.totalFiles} file{incomingManifest.totalFiles > 1 ? 's' : ''}
          </h2>
          <p className="text-sm text-zinc-400 mb-3">
            Total size: {formatFileSize(incomingManifest.totalSize)}
          </p>
          {/* File list preview */}
          <div className="max-h-40 overflow-y-auto space-y-1 mb-4">
            {incomingManifest.files.map((f, i) => (
              <div key={i} className="flex items-center justify-between text-xs py-1 px-2 bg-zinc-800/50 rounded">
                <span className="text-zinc-300 truncate flex-1 mr-2">
                  {f.relativePath ? `${f.relativePath}/` : ''}{f.name}
                </span>
                <span className="text-zinc-500 shrink-0">{formatFileSize(f.size)}</span>
              </div>
            ))}
          </div>
          <button
            onClick={onAcceptMultiFile}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors"
          >
            Accept & Choose Save Location
          </button>
        </div>
      )}

      {/* Receiver: Single-file incoming prompt */}
      {!incomingManifest && awaitingSaveLocation && pendingFile && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <IncomingFilePrompt file={pendingFile} onAccept={onAcceptFile} />
        </div>
      )}

      {/* Progress with Controls */}
      {isTransferring && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          {/* Channel count & mode indicator for multi-file */}
          {isMultiFile && (
            <div className="flex items-center gap-3 mb-3">
              {channelCount > 1 && (
                <span className="text-xs px-2 py-1 bg-zinc-800 rounded text-zinc-400">
                  {channelCount} channels
                </span>
              )}
              <span className="text-xs px-2 py-1 bg-zinc-800 rounded text-zinc-400">
                {transferMode === TRANSFER_MODE.PARALLEL ? 'Parallel' : 'Sequential'}
              </span>
            </div>
          )}

          <TransferProgressWithControls
            progress={transferProgress}
            state={transferState}
            speed={transferSpeed}
            eta={transferEta}
            isPaused={isPaused}
            pausedBy={pausedBy}
            onPause={onPause}
            onResume={onResume}
            onCancel={onCancel}
          />

          {/* Per-file progress list */}
          {perFileProgress.length >= 1 && (
            <div className="mt-3 space-y-1 max-h-40 overflow-y-auto">
              {perFileProgress.map((f) => {
                const done = f.completed || f.state === 'completed';
                const active = f.progress > 0 || f.state === 'sending';
                const failed = f.state === 'failed';
                return (
                  <div key={f.index} className="flex items-center gap-2 text-xs">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      failed ? 'bg-red-500' : done ? 'bg-emerald-500' : active ? 'bg-blue-500 animate-pulse' : 'bg-zinc-600'
                    }`} />
                    <span className="text-zinc-400 truncate flex-1">{f.name}</span>
                    <span className="text-zinc-500 shrink-0">
                      {failed ? 'Failed' : `${f.progress}%`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Transfer Complete */}
      {isCompleted && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <TransferComplete
            isHost={isHost}
            savedToFileSystem={downloadResult?.savedToFileSystem}
            fileName={pendingFile?.name}
            fileCount={isMultiFile ? (incomingManifest?.totalFiles || selectedFiles.length || 1) : 1}
          />
          {/* Reset button to allow re-transfer */}
          {dataChannelReady && onReset && (
            <button
              onClick={onReset}
              className="w-full mt-3 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors"
            >
              {isHost ? 'Send More Files' : 'Receive More Files / Send Files'}
            </button>
          )}
        </div>
      )}

      {/* Transfer Error — with reset */}
      {isError && (
        <div className="bg-zinc-900 border border-red-800 rounded-xl p-4">
          <div className="text-center">
            <p className="text-red-400 font-medium mb-2">Transfer Failed</p>
            <p className="text-sm text-zinc-500 mb-3">Something went wrong during the transfer.</p>
            {dataChannelReady && onReset && (
              <button
                onClick={onReset}
                className="w-full py-3 bg-zinc-700 hover:bg-zinc-600 text-white rounded-xl font-medium transition-colors"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      )}

      {/* Transfer Info Panel */}
      {transferInfo.fileName && !isMultiFile && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">Transfer</h2>
          <TransferInfoPanel info={transferInfo} />
        </div>
      )}

      {/* Send Button — shown for anyone with files when idle and connected */}
      {(selectedFiles.length > 0 || selectedFile) && tofuVerified && dataChannelReady && isIdle && (
        <button
          onClick={onStartTransfer}
          className="w-full py-3 bg-zinc-100 text-zinc-900 hover:bg-white rounded-xl font-medium transition-colors"
        >
          {selectedFiles.length > 1 ? `Send ${selectedFiles.length} Files` : 'Send File'}
        </button>
      )}
    </div>
  );
}
