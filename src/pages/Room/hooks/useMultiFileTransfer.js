/**
 * useMultiFileTransfer Hook
 *
 * Wraps MultiFileTransferManager (sender) and MultiFileReceiver (receiver)
 * to support multi-file and multi-channel transfers.
 *
 * Drop-in alongside useFileTransfer — the Room page chooses this hook when
 * selectedFiles.length > 0.
 *
 * Exposes:
 *   startMultiTransfer(), pauseAll(), resumeAll(), cancelAll(),
 *   transferMode / setTransferMode,
 *   overallProgress, perFileProgress, speed, eta, channelCount,
 *   multiTransferState (idle | preparing | sending | receiving | completed | error)
 */
import { useState, useRef, useCallback } from 'react';
import { MultiFileTransferManager } from '../../../transfer/multifile/MultiFileTransferManager.js';
import { MultiFileReceiver } from '../../../transfer/multifile/MultiFileReceiver.js';
import { ZipStreamWriter } from '../../../transfer/multifile/ZipStreamWriter.js';
import { getChannelPool } from '../../../utils/p2pManager.js';
import { getSocket } from '../../../utils/signaling.js';
import { TRANSFER_MODE } from '../../../constants/transfer.constants.js';
import { MESSAGE_TYPE } from '../../../constants/messages.constants.js';
import logger from '../../../utils/logger.js';

/**
 * @param {Object} params
 * @param {string} params.roomId
 * @param {boolean} params.isHost
 * @param {Array<{file: File, relativePath: string|null}>} params.selectedFiles
 * @param {boolean} params.tofuVerified
 * @param {Function} params.sendJSON   — send JSON on channel-0
 * @param {Function} params.sendBinary — send binary on channel-0 (backward-compat)
 * @param {Function} params.waitForDrain — wait for channel-0 drain
 * @param {Function} params.addLog
 * @param {Function} [params.trackChunkProgress] — track chunk completion in bitmap
 * @param {import('react').MutableRefObject} [params.negotiatedConfigRef] — negotiated config ref from useMessages
 */
export function useMultiFileTransfer({
  roomId,
  isHost,
  selectedFiles,
  tofuVerified,
  sendJSON,
  sendBinary,
  waitForDrain,
  addLog,
  trackChunkProgress,
  negotiatedConfigRef,
}) {
  // ─── State ──────────────────────────────────────────────────────

  const [multiTransferState, setMultiTransferState] = useState('idle');
  const [transferMode, setTransferMode] = useState(TRANSFER_MODE.SEQUENTIAL);
  const [overallProgress, setOverallProgress] = useState(0);
  const [perFileProgress, setPerFileProgress] = useState([]);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(null);
  const [channelCount, setChannelCount] = useState(1);
  const [isPaused, setIsPaused] = useState(false);
  // Track who initiated the pause: 'local' | 'remote' | null
  const [pausedBy, setPausedBy] = useState(null);

  // Receive-side state
  const [incomingManifest, setIncomingManifest] = useState(null);
  const [awaitingDirectory, setAwaitingDirectory] = useState(false);
  const [saveAsZip, setSaveAsZip] = useState(false);

  // ─── Refs ───────────────────────────────────────────────────────

  const managerRef = useRef(null);   // MultiFileTransferManager (sender)
  const receiverRef = useRef(null);  // MultiFileReceiver (receiver)
  const saveAsZipRef = useRef(false); // tracks saveAsZip for async callbacks

  // ─── Sender: start transfer ─────────────────────────────────────

  const startMultiTransfer = useCallback(async () => {
    if (!selectedFiles || selectedFiles.length === 0 || !tofuVerified) return;

    const pool = getChannelPool();
    if (!pool) {
      addLog('No channel pool available', 'error');
      return;
    }

    // Analytics
    const socket = getSocket();
    const sessionId = 'multi-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    if (socket?.connected) {
      socket.emit('transfer-start', {
        roomId,
        sessionId,
        fileCount: selectedFiles.length,
        totalBytes: selectedFiles.reduce((s, f) => s + f.file.size, 0),
      });
    }

    const manager = new MultiFileTransferManager(pool, {
      sendJSON,
      sendBinary,
      waitForDrain,
      addLog,
      trackChunkProgress,
      mode: transferMode,
      negotiatedConfig: negotiatedConfigRef?.current || null,
    });

    // Wire callbacks
    manager.onProgress = (p) => {
      setOverallProgress(p.overallProgress ?? Math.round((p.sentBytes / p.totalBytes) * 100));
      setSpeed(p.speed);
      setEta(p.eta);
      setChannelCount(p.channelCount ?? 1);
      setPerFileProgress(p.perFile ?? []);
    };
    manager.onFileStart = (idx) => {
      addLog(`Sending file ${idx + 1}/${selectedFiles.length}`, 'info');
    };
    manager.onAllComplete = () => {
      setMultiTransferState('completed');
      setOverallProgress(100);
      addLog('All files sent!', 'success');
      if (socket?.connected) {
        socket.emit('transfer-complete', { roomId, sessionId });
      }
    };
    manager.onError = (err) => {
      setMultiTransferState('error');
      addLog(`Transfer error: ${err.message}`, 'error');
    };

    if (managerRef.current) {
      managerRef.current.destroy();
    }
    managerRef.current = manager;
    setMultiTransferState('sending');

    await manager.start(selectedFiles);
  }, [selectedFiles, tofuVerified, roomId, transferMode, sendJSON, sendBinary, waitForDrain, addLog, trackChunkProgress]);

  // ─── Receiver: handle manifest ──────────────────────────────────

  const handleMultiFileManifest = useCallback(async (manifest) => {
    // If we were in a completed/error state, sender is re-sending — notify receiver
    const wasCompleted = receiverRef.current != null;
    if (wasCompleted) {
      // Destroy old receiver before creating new one
      try {
        receiverRef.current?.destroy();
      } catch (e) {
        logger.warn('[MultiFileTransfer] Error destroying old receiver:', e);
      }
      receiverRef.current = null;
      addLog('📦 Sender wants to send more files!', 'info');
    }

    // Reset state for the new incoming transfer
    setMultiTransferState('idle');
    setOverallProgress(0);
    setPerFileProgress([]);
    setSpeed(0);
    setEta(null);
    setIsPaused(false);

    // Sync transfer mode from sender's manifest so the receiver UI shows correctly
    if (manifest.mode) {
      setTransferMode(manifest.mode);
    }

    const receiver = new MultiFileReceiver({
      trackChunkProgress,
    });

    receiver.onManifest = (m) => {
      setIncomingManifest(m);
      // If any files have relativePath, ask user for directory
      if (receiver.hasRelativePaths && receiver.supportsDirectoryPicker) {
        setAwaitingDirectory(true);
      } else {
        setAwaitingDirectory(true); // still prompt to pick a directory or accept
      }
    };

    receiver.onProgress = (p) => {
      setOverallProgress(p.overallProgress);
      setSpeed(p.speed);
      setEta(p.eta);
      setPerFileProgress(p.perFile ?? []);
    };

    receiver.onFileComplete = (idx, name) => {
      addLog(`✓ Received: ${name}`, 'success');
    };

    receiver.onAllComplete = () => {
      setMultiTransferState('completed');
      setOverallProgress(100);
      if (saveAsZipRef.current && manifest.totalFiles > 1) {
        addLog(`✅ ZIP archive complete — ${manifest.totalFiles} files bundled`, 'success');
      } else {
        addLog('All files received!', 'success');
      }
    };

    receiver.onError = (err) => {
      setMultiTransferState('error');
      const isZipError = err.message?.includes('ZIP');
      addLog(
        isZipError
          ? `ZIP error: ${err.message}`
          : `Receive error: ${err.message}`,
        'error'
      );
    };

    receiverRef.current = receiver;
    await receiver.handleManifest(manifest);
  }, [addLog, trackChunkProgress]);

  // ─── Receiver: accept and pick directory ─────────────────────────

  const acceptMultiFileTransfer = useCallback(async () => {
    const receiver = receiverRef.current;
    if (!receiver) return;

    // Sync ref so async callbacks (onAllComplete) see the latest value
    saveAsZipRef.current = saveAsZip;

    let fileSystemSelected = false;
    const isSingleFile = receiver.manifest?.totalFiles === 1;

    try {
      if (saveAsZip && !isSingleFile) {
        // ─── ZIP mode: save all files into a single .zip archive ───
        const archiveName = receiver.manifest?.archiveName || 'transfer';
        if (typeof window.showSaveFilePicker === 'function') {
          const fileHandle = await window.showSaveFilePicker({
            suggestedName: `${archiveName}.zip`,
            types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
          });
          const writable = await fileHandle.createWritable();
          const zipWriter = new ZipStreamWriter(writable);
          receiver.setZipWriter(zipWriter);
          addLog('Save location selected — files will be saved as ZIP archive', 'success');
          fileSystemSelected = true;
        } else {
          // Blob fallback — build ZIP in memory
          const zipWriter = new ZipStreamWriter(null);
          receiver.setZipWriter(zipWriter);
          addLog('Saving as ZIP archive (in-memory fallback)', 'info');
        }
      } else if (isSingleFile && typeof window.showSaveFilePicker === 'function') {
        // Single file: use showSaveFilePicker for cleaner UX (no folder prompt)
        const fileName = receiver.manifest.files[0].name;
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: fileName,
        });
        await receiver.setSingleFileHandle(fileHandle);
        addLog('Save location selected — file will be saved via File System API', 'success');
        fileSystemSelected = true;
      } else if (receiver.supportsDirectoryPicker) {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await receiver.setDirectoryHandle(dirHandle);
        addLog('Save directory selected — files will be saved via File System API', 'success');
        fileSystemSelected = true;
      } else {
        addLog('Directory picker not supported — files will be downloaded individually via browser', 'info');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // User cancelled the file/directory picker — stay on the prompt so they can retry
        addLog('Save location cancelled — you can try again or change options', 'info');
        return;
      }
      addLog(`File picker error: ${err.message} — files will be downloaded individually`, 'error');
    }

    setAwaitingDirectory(false);
    setMultiTransferState('receiving');

    // Tell sender we're ready
    sendJSON({ type: MESSAGE_TYPE.RECEIVER_READY });
    addLog(fileSystemSelected
      ? 'Ready to receive — saving via File System API'
      : 'Ready to receive — will prompt to save each file individually', 'info');
  }, [sendJSON, addLog, saveAsZip]);

  // ─── Receiver: chunk routing ─────────────────────────────────────

  const handleMultiChunkMetadata = useCallback((metadata) => {
    receiverRef.current?.handleChunkMetadata(metadata);
  }, []);

  const handleMultiBinaryChunk = useCallback(async (data, fileIndex, matchedMeta) => {
    await receiverRef.current?.handleBinaryChunk(data, fileIndex, matchedMeta);
  }, []);

  const handleFileComplete = useCallback(async (fileIndex) => {
    await receiverRef.current?.handleFileComplete(fileIndex);
  }, []);

  // ─── Sender: receiver-ready signal ──────────────────────────────

  const onReceiverReady = useCallback(() => {
    managerRef.current?.receiverReady();
  }, []);

  // ─── Controls ───────────────────────────────────────────────────

  const pauseAll = useCallback(() => {
    managerRef.current?.pause();
    setIsPaused(true);
    setPausedBy('local');
    sendJSON({ type: MESSAGE_TYPE.TRANSFER_PAUSED });
  }, [sendJSON]);

  const resumeAll = useCallback(() => {
    // Only the person who paused can resume
    if (pausedBy === 'remote') return;
    managerRef.current?.resume();
    setIsPaused(false);
    setPausedBy(null);
    sendJSON({ type: MESSAGE_TYPE.TRANSFER_RESUMED });
  }, [sendJSON, pausedBy]);

  const cancelAll = useCallback(() => {
    managerRef.current?.cancel();
    receiverRef.current?.destroy();
    setMultiTransferState('idle');
    setOverallProgress(0);
    setPerFileProgress([]);
    setIsPaused(false);
    sendJSON({ type: MESSAGE_TYPE.TRANSFER_CANCELLED });
    addLog('Transfer cancelled', 'warning');
  }, [sendJSON, addLog]);

  // ─── Remote signals ─────────────────────────────────────────────

  const handleRemotePause = useCallback(() => {
    // Pause sender if we are the sender, otherwise no-op
    managerRef.current?.pause();
    setIsPaused(true);
    setPausedBy('remote');
    addLog('Peer paused transfer', 'warning');
  }, [addLog]);

  const handleRemoteResume = useCallback(() => {
    // Resume sender if we are the sender, otherwise no-op
    managerRef.current?.resume();
    setIsPaused(false);
    setPausedBy(null);
    addLog('Peer resumed transfer', 'success');
  }, [addLog]);

  const handleRemoteCancel = useCallback(() => {
    managerRef.current?.cancel();
    receiverRef.current?.destroy();
    setMultiTransferState('idle');
    setOverallProgress(0);
    setPerFileProgress([]);
    setIsPaused(false);
    addLog('Peer cancelled transfer', 'warning');
  }, [addLog]);

  // ─── Reset (allow re-transfer) ────────────────────────────────

  const resetTransfer = useCallback(() => {
    managerRef.current?.destroy();
    receiverRef.current?.destroy();
    managerRef.current = null;
    receiverRef.current = null;
    setMultiTransferState('idle');
    setOverallProgress(0);
    setPerFileProgress([]);
    setSpeed(0);
    setEta(null);
    setChannelCount(1);
    setIsPaused(false);
    setPausedBy(null);
    setIncomingManifest(null);
    setAwaitingDirectory(false);
  }, []);

  // ─── Cleanup ────────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    managerRef.current?.destroy();
    receiverRef.current?.destroy();
    managerRef.current = null;
    receiverRef.current = null;
  }, []);

  return {
    // State
    multiTransferState,
    overallProgress,
    perFileProgress,
    speed,
    eta,
    channelCount,
    isPaused,
    pausedBy,
    transferMode,
    setTransferMode,

    // Incoming (receiver)
    incomingManifest,
    awaitingDirectory,
    saveAsZip,
    setSaveAsZip,

    // Sender actions
    startMultiTransfer,
    onReceiverReady,

    // Receiver actions
    handleMultiFileManifest,
    acceptMultiFileTransfer,
    handleMultiChunkMetadata,
    handleMultiBinaryChunk,
    handleFileComplete,

    // Controls
    pauseAll,
    resumeAll,
    cancelAll,

    // Reset for re-transfer
    resetTransfer,

    // Remote signal handlers
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,

    // Cleanup
    cleanup,
  };
}
