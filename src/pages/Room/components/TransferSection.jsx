/**
 * TransferSection Component
 * Displays file transfer UI - file info, progress, controls
 * Supports both single-file and multi-file modes.
 * 
 * Layout priority (top to bottom):
 *  1. File selection (drop zone)
 *  2. Send button (immediately after files, easy to reach on mobile)
 *  3. Transfer mode toggle
 *  4. Warnings / info
 *  5. Incoming file prompts
 *  6. Progress / completion
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
import { formatBytes as formatFileSize } from '../../../lib/formatters.js';

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
  const supportsResumePicker = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
  const hasFiles = selectedFiles.length > 0 || selectedFile;
  const canSend = hasFiles && tofuVerified && dataChannelReady && isIdle;

  const transferInfo = {
    fileName: pendingFile?.name || selectedFile?.name,
    fileSize: pendingFile?.size || selectedFile?.size || 0,
    progress: transferProgress,
    speed: transferSpeed,
    eta: transferEta,
    isPaused: isPaused,
  };

  return (
    <div className="space-y-3">
      {/* ─── 1. File Selection ──────────────────────────────────────── */}
      {isIdle && !awaitingDirectory && !incomingManifest && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 overflow-hidden">
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

      {/* ─── 2. Send Button (right after file info for quick access) ── */}
      {canSend && (
        <button
          onClick={onStartTransfer}
          className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-xl font-semibold transition-colors shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-4 4m4-4l4 4" />
          </svg>
          {selectedFiles.length > 1 ? `Send ${selectedFiles.length} Files` : 'Send File'}
        </button>
      )}

      {/* ─── 3. Transfer Mode Toggle ───────────────────────────────── */}
      {isIdle && selectedFiles.length >= 2 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Transfer Mode</span>
          </div>
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
          <p className="text-xs text-zinc-600 mt-1.5">
            {transferMode === TRANSFER_MODE.SEQUENTIAL
              ? 'One at a time — more reliable'
              : 'Simultaneous — faster'}
          </p>
        </div>
      )}

      {/* ─── 4. Warnings ───────────────────────────────────────────── */}
      {isIdle && selectedFiles.length > 0 && (selectedFiles.some(f => f.file.size > 100 * 1024 * 1024) || selectedFiles.length > 5) && (
        <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl p-3">
          <p className="text-xs text-amber-300/90">
            ⚠️ For {selectedFiles.length > 5 ? 'many files' : 'large files'}, compressing into a ZIP first can improve speed & reliability.
          </p>
        </div>
      )}

      {!isHost && !supportsResumePicker && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-2.5">
          <p className="text-xs text-zinc-500">
            Limited resume support in this browser. Connection drops may require restarting the transfer.
          </p>
        </div>
      )}

      {/* Host: Single-file info (legacy) */}
      {isHost && !isMultiFile && selectedFile && isIdle && !onAddFiles && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <FileInfo file={selectedFile} />
        </div>
      )}

      {/* ─── 5. Receiver: Waiting / Incoming Prompts ───────────────── */}
      {!isHost && selectedFiles.length === 0 && !pendingFile && !incomingManifest && dataChannelReady && !isTransferring && !isCompleted && !isError && (
        <div className="bg-zinc-900 border border-emerald-900/50 rounded-xl p-6">
          <div className="flex flex-col items-center justify-center">
            <div className="mb-4">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
            <h2 className="text-base font-medium text-emerald-400 mb-1">Waiting for file...</h2>
            <p className="text-xs text-zinc-500 text-center">Connected and ready. Sender can now share files.</p>
          </div>
        </div>
      )}

      {/* Receiver: Incoming multi-file manifest */}
      {awaitingDirectory && incomingManifest && (
        <div className="bg-zinc-900 border border-emerald-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-900/50 flex items-center justify-center">
              <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-emerald-400">
                Incoming: {incomingManifest.totalFiles} file{incomingManifest.totalFiles > 1 ? 's' : ''}
              </h2>
              <p className="text-xs text-zinc-500">{formatFileSize(incomingManifest.totalSize)}</p>
            </div>
          </div>
          {/* File list preview */}
          <div className="max-h-32 overflow-y-auto space-y-0.5 mb-3">
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
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-xl font-semibold transition-colors"
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

      {/* ─── 6. Progress / Completion ──────────────────────────────── */}
      {isTransferring && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          {/* Channel & mode badges */}
          {isMultiFile && (
            <div className="flex items-center gap-2 mb-3">
              {channelCount > 1 && (
                <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded-full text-zinc-400">
                  {channelCount} ch
                </span>
              )}
              <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded-full text-zinc-400">
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

          {/* Per-file progress */}
          {perFileProgress.length >= 1 && (
            <div className="mt-3 space-y-1 max-h-36 overflow-y-auto">
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
        <div className="bg-zinc-900 border border-emerald-900/50 rounded-xl p-4">
          <TransferComplete
            isHost={isHost}
            savedToFileSystem={downloadResult?.savedToFileSystem}
            fileName={pendingFile?.name}
            fileCount={isMultiFile ? (incomingManifest?.totalFiles || selectedFiles.length || 1) : 1}
          />
          {dataChannelReady && onReset && (
            <button
              onClick={onReset}
              className="w-full mt-3 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl font-medium transition-colors"
            >
              {isHost ? 'Send More Files' : 'Receive More / Send Files'}
            </button>
          )}
        </div>
      )}

      {/* Transfer Error */}
      {isError && (
        <div className="bg-zinc-900 border border-red-800/50 rounded-xl p-4">
          <div className="text-center">
            <p className="text-red-400 font-medium mb-1">Transfer Failed</p>
            <p className="text-xs text-zinc-500 mb-3">Something went wrong during the transfer.</p>
            {dataChannelReady && onReset && (
              <button
                onClick={onReset}
                className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl font-medium transition-colors"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

