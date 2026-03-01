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

  // Receive-side state
  const [incomingManifest, setIncomingManifest] = useState(null);
  const [awaitingDirectory, setAwaitingDirectory] = useState(false);

  // ─── Refs ───────────────────────────────────────────────────────

  const managerRef = useRef(null);   // MultiFileTransferManager (sender)
  const receiverRef = useRef(null);  // MultiFileReceiver (receiver)

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
      mode: transferMode,
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

    managerRef.current = manager;
    setMultiTransferState('sending');

    await manager.start(selectedFiles);
  }, [selectedFiles, tofuVerified, roomId, transferMode, sendJSON, sendBinary, waitForDrain, addLog]);

  // ─── Receiver: handle manifest ──────────────────────────────────

  const handleMultiFileManifest = useCallback(async (manifest) => {
    const receiver = new MultiFileReceiver();

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
      addLog('All files received!', 'success');
    };

    receiver.onError = (err) => {
      setMultiTransferState('error');
      addLog(`Receive error: ${err.message}`, 'error');
    };

    receiverRef.current = receiver;
    await receiver.handleManifest(manifest);
  }, [addLog]);

  // ─── Receiver: accept and pick directory ─────────────────────────

  const acceptMultiFileTransfer = useCallback(async () => {
    const receiver = receiverRef.current;
    if (!receiver) return;

    try {
      if (receiver.supportsDirectoryPicker) {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await receiver.setDirectoryHandle(dirHandle);
        addLog('Save directory selected', 'success');
      } else {
        addLog('Directory picker not supported — files will be downloaded individually', 'info');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        addLog('Directory selection cancelled — files will be downloaded individually', 'info');
      } else {
        addLog(`Directory picker error: ${err.message}`, 'error');
      }
    }

    setAwaitingDirectory(false);
    setMultiTransferState('receiving');

    // Tell sender we're ready
    sendJSON({ type: MESSAGE_TYPE.RECEIVER_READY });
  }, [sendJSON, addLog]);

  // ─── Receiver: chunk routing ─────────────────────────────────────

  const handleMultiChunkMetadata = useCallback((metadata) => {
    receiverRef.current?.handleChunkMetadata(metadata);
  }, []);

  const handleMultiBinaryChunk = useCallback(async (data, fileIndex) => {
    await receiverRef.current?.handleBinaryChunk(data, fileIndex);
  }, []);

  const handleFileComplete = useCallback(async (fileIndex) => {
    await receiverRef.current?.handleFileComplete(fileIndex);
  }, []);

  // ─── Controls ───────────────────────────────────────────────────

  const pauseAll = useCallback(() => {
    managerRef.current?.pause();
    setIsPaused(true);
    sendJSON({ type: MESSAGE_TYPE.TRANSFER_PAUSED });
  }, [sendJSON]);

  const resumeAll = useCallback(() => {
    managerRef.current?.resume();
    setIsPaused(false);
    sendJSON({ type: MESSAGE_TYPE.TRANSFER_RESUMED });
  }, [sendJSON]);

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
    if (isHost) {
      managerRef.current?.pause();
    }
    setIsPaused(true);
    addLog('Peer paused transfer', 'warning');
  }, [isHost, addLog]);

  const handleRemoteResume = useCallback(() => {
    if (isHost) {
      managerRef.current?.resume();
    }
    setIsPaused(false);
    addLog('Peer resumed transfer', 'success');
  }, [isHost, addLog]);

  const handleRemoteCancel = useCallback(() => {
    managerRef.current?.cancel();
    receiverRef.current?.destroy();
    setMultiTransferState('idle');
    setOverallProgress(0);
    setPerFileProgress([]);
    setIsPaused(false);
    addLog('Peer cancelled transfer', 'warning');
  }, [addLog]);

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
    transferMode,
    setTransferMode,

    // Incoming (receiver)
    incomingManifest,
    awaitingDirectory,

    // Sender actions
    startMultiTransfer,

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

    // Remote signal handlers
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,

    // Cleanup
    cleanup,
  };
}
