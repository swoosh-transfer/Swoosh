/**
 * useFileTransfer Hook
 * Manages file transfer lifecycle for both sending and receiving
 * - Chunked file sending with progress tracking
 * - Chunked file receiving with sequential writes
 * - Pause/resume/cancel functionality
 * - Crash recovery
 * - Retransmission handling
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { ChunkingEngine } from '../../../transfer/sending/ChunkingEngine.js';
// TODO: Migrate to AssemblyEngine once it supports pause/resume and two-step init flow
import { fileReceiver } from '../../../utils/fileReceiver.js';
import { getSocket } from '../../../utils/signaling.js';
import { cleanupTransferData } from '../../../infrastructure/database/index.js';
import { resumableTransferManager } from '../../../transfer/resumption/ResumableTransferManager.js';
import { progressTracker } from '../../../transfer/shared/ProgressTracker.js';
import { useTransferStore } from '../../../stores/transferStore.js';
import { formatBytes } from '../../../lib/formatters.js';
import { STORAGE_CHUNK_SIZE } from '../../../constants/transfer.constants.js';
import logger from '../../../utils/logger.js';

/**
 * Hook for managing file transfers
 * @param {string} roomId - Room identifier
 * @param {boolean} isHost - Whether user is the host (sender)
 * @param {Object} selectedFile - File selected by host to send
 * @param {Object} securityPayload - Security payload for encryption
 * @param {boolean} tofuVerified - Whether TOFU verification is complete
 * @param {Function} sendJSON - Function to send JSON messages
 * @param {Function} sendBinary - Function to send binary data
 * @param {Function} waitForDrain - Function to wait for buffer drain
 * @param {Function} addLog - Logging function
 * @param {Function} trackChunkProgress - Callback to track chunk completion in bitmap
 * @returns {Object} Transfer state and methods
 */
export function useFileTransfer(
  roomId,
  isHost,
  selectedFile,
  securityPayload,
  tofuVerified,
  sendJSON,
  sendBinary,
  waitForDrain,
  addLog,
  trackChunkProgress
) {
  const {
    initiateUpload, initiateDownload,
    completeTransfer: completeStoreTransfer,
  } = useTransferStore();

  // Transfer state
  const [transferState, setTransferState] = useState('idle');
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [transferEta, setTransferEta] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  // Track who initiated the pause: 'local' | 'remote' | null
  const [pausedBy, setPausedBy] = useState(null);

  // Refs
  const chunkingEngineRef = useRef(new ChunkingEngine());
  const transferIdRef = useRef(null);
  const sessionIdRef = useRef(null);
  const receivedBytesRef = useRef(0);
  const startTimeRef = useRef(null);
  const receiverLastChunkRef = useRef(-1); // Track receiver's last chunk when paused (sender side)
  const progressUnsubRef = useRef(null); // ProgressTracker subscription cleanup

  // Cleanup progress subscription on unmount
  useEffect(() => {
    return () => {
      if (progressUnsubRef.current) {
        progressUnsubRef.current();
        progressUnsubRef.current = null;
      }
    };
  }, []);

  /**
   * Start transfer process (send file metadata)
   */
  const startTransfer = useCallback(() => {
    if (!selectedFile || !tofuVerified) return;

    const transferId = crypto.randomUUID();
    const sessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    transferIdRef.current = transferId;
    sessionIdRef.current = sessionId;

    // Emit analytics event
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
      totalChunks: Math.ceil(selectedFile.size / STORAGE_CHUNK_SIZE),
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
      totalChunks: Math.ceil(selectedFile.size / STORAGE_CHUNK_SIZE),
    });

    addLog('Waiting for receiver...', 'info');
  }, [selectedFile, tofuVerified, roomId, sendJSON, addLog, initiateUpload]);

  /**
   * Send file chunks to receiver
   */
  const sendFileChunks = useCallback(async () => {
    if (!selectedFile || !tofuVerified) {
      addLog('Cannot send: TOFU not verified', 'error');
      return;
    }

    setTransferState('sending');
    startTimeRef.current = Date.now();

    // Subscribe to ProgressTracker for canonical progress updates
    if (progressUnsubRef.current) progressUnsubRef.current();
    progressUnsubRef.current = progressTracker.subscribe(
      transferIdRef.current,
      (progress) => {
        setTransferProgress(Math.round(progress.percentage));
        setTransferSpeed(progress.transferSpeed);
        if (progress.estimatedTimeRemaining != null) {
          setTransferEta(progress.estimatedTimeRemaining / 1000);
        }
      }
    );

    try {
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

          // Track chunk completion in bitmap (for resume)
          if (trackChunkProgress) {
            trackChunkProgress(transferIdRef.current, metadata.chunkIndex);
          }
        }
      );

      // Unsubscribe from progress tracker
      if (progressUnsubRef.current) {
        progressUnsubRef.current();
        progressUnsubRef.current = null;
      }

      sendJSON({ type: 'transfer-complete' });
      setTransferState('completed');
      setTransferProgress(100);
      addLog('Transfer complete!', 'success');

      // Emit analytics event
      const socket = getSocket();
      if (socket?.connected && sessionIdRef.current) {
        socket.emit('transfer-complete', {
          roomId,
          sessionId: sessionIdRef.current
        });
        addLog('Analytics: Transfer completed', 'success');
      }

      // Clean up all transfer data
      try {
        await resumableTransferManager.completeTransfer(transferIdRef.current);
        await cleanupTransferData(transferIdRef.current);
        chunkingEngineRef.current.cleanup(transferIdRef.current);
        logger.log('[Transfer] Full cleanup completed for sender:', transferIdRef.current);
      } catch (cleanupErr) {
        logger.warn('[Transfer] Cleanup failed:', cleanupErr);
      }

    } catch (err) {
      setTransferState('error');
      addLog(`Transfer failed: ${err.message}`, 'error');

      // Emit analytics event
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
  }, [selectedFile, tofuVerified, securityPayload, roomId, sendJSON, sendBinary, waitForDrain, addLog]);

  /**
   * Handle retransmission request from receiver
   * @param {number[]} chunkIndices - Chunk indices to retransmit
   */
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
          await waitForDrain();
          sendJSON({ type: 'chunk-metadata', ...metadata });
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
        sendJSON({ type: 'transfer-complete' });
      } else {
        addLog(`Retransmission partial: ${result.sent} sent, ${result.failed} failed`, 'warning');
      }
    } catch (err) {
      addLog(`Retransmission failed: ${err.message}`, 'error');
    }
  }, [selectedFile, isHost, sendJSON, sendBinary, waitForDrain, addLog]);

  /**
   * Initialize file receive (setup FileReceiver)
   * @param {Object} metadata - File metadata
   * @param {Function} setPendingFile - Callback to set pending file state
   */
  const initializeReceive = useCallback(async (metadata, setPendingFile) => {
    const { transferId, name, size, mimeType, totalChunks } = metadata;
    
    addLog(`Incoming: ${name} (${formatBytes(size)})`, 'info');

    transferIdRef.current = transferId;
    setPendingFile({ name, size, totalChunks });
    receivedBytesRef.current = 0;

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
  }, [addLog, initiateDownload]);

  /**
   * Setup file writer (file save location picker)
   * @param {string} fileName - File name
   * @param {Function} onReady - Callback when ready
   */
  const setupFileWriter = useCallback(async (fileName, onReady) => {
    try {
      const result = await fileReceiver.setupFileWriter(transferIdRef.current, fileName);
      addLog(`Save location selected (${result.method})`, 'success');
      setTransferState('receiving');
      startTimeRef.current = Date.now();

      // Tell sender we're ready
      sendJSON({ type: 'receiver-ready' });
      
      if (onReady) onReady();
    } catch (err) {
      if (err.message.includes('cancelled')) {
        addLog('Save cancelled', 'warning');
      } else {
        addLog(`Error: ${err.message}`, 'error');
      }
    }
  }, [sendJSON, addLog]);

  /**
   * Receive a chunk (called from message handler)
   * @param {Object} metadata - Chunk metadata
   * @param {Uint8Array} data - Chunk binary data
   */
  const receiveChunk = useCallback(async (metadata, data) => {
    try {
      const result = await fileReceiver.receiveChunk(
        transferIdRef.current,
        {
          chunkIndex: metadata.chunkIndex,
          checksum: metadata.checksum,
          size: metadata.size,
          fileOffset: metadata.fileOffset,
          isFinal: metadata.isFinal,
        },
        data
      );

      if (!result.success) {
        addLog(`Chunk ${metadata.chunkIndex}: ${result.error}`, 'error');
      } else {
        // Track chunk completion in bitmap (for resume)
        if (trackChunkProgress) {
          trackChunkProgress(transferIdRef.current, metadata.chunkIndex);
        }
      }
    } catch (err) {
      addLog(`Chunk ${metadata.chunkIndex} error: ${err.message}`, 'error');
    }
  }, [addLog, trackChunkProgress]);

  /**
   * Complete transfer (finalize file)
   * @param {Function} setDownloadResult - Callback to set download result
   */
  const completeReceive = useCallback(async (setDownloadResult) => {
    addLog('Transfer complete signal', 'info');

    // Wait for any in-flight chunks
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
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

        // Clean up - mark transfer as complete in resumable manager, catching "not found" errors
        try {
          await resumableTransferManager.completeTransfer(transferIdRef.current);
        } catch (completeErr) {
          // Ignore "transfer not found" - metadata may have been cleaned up already
          if (!completeErr.message || !completeErr.message.includes('transfer not found')) {
            throw completeErr;
          }
        }
        
        // Now cleanup remaining data
        try {
          await cleanupTransferData(transferIdRef.current);
          logger.log('[Transfer] Full cleanup completed for receiver:', transferIdRef.current);
        } catch (cleanupErr) {
          logger.warn('[Transfer] Cleanup failed:', cleanupErr);
        }
      } else if (result.pendingChunks?.length > 0) {
        // Handle pending chunks scenario
        addLog(`${result.pendingChunks.length} chunks pending write, waiting...`, 'warning');
        
        setTimeout(async () => {
          await handlePendingChunksRetry(setDownloadResult);
        }, 3000);
      } else if (result.missingChunks?.length > 0) {
        addLog(`Missing ${result.missingChunks.length} chunks, requesting retransmit...`, 'warning');
        sendJSON({ type: 'request-chunks', chunks: result.missingChunks });
        
        setTimeout(async () => {
          await handleMissingChunksRetry(setDownloadResult);
        }, 3000);
      } else {
        addLog(`Complete error: ${result.error}`, 'error');
      }
    } catch (err) {
      addLog(`Complete error: ${err.message}`, 'error');
    }
  }, [sendJSON, addLog]);

  /**
   * Handle pending chunks retry (internal)
   * @param {Function} setDownloadResult - Callback to set download result
   */
  const handlePendingChunksRetry = async (setDownloadResult) => {
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
      
      try {
        await resumableTransferManager.completeTransfer(transferIdRef.current);
        await cleanupTransferData(transferIdRef.current);
      } catch (cleanupErr) {
        logger.warn('[Transfer] Cleanup failed:', cleanupErr);
      }
    } else if (retryResult.missingChunks?.length > 0) {
      addLog(`Actually missing ${retryResult.missingChunks.length} chunks, requesting retransmit...`, 'warning');
      sendJSON({ type: 'request-chunks', chunks: retryResult.missingChunks });
      setTimeout(() => handleMissingChunksRetry(setDownloadResult), 3000);
    }
  };

  /**
   * Handle missing chunks retry (internal)
   * @param {Function} setDownloadResult - Callback to set download result
   */
  const handleMissingChunksRetry = async (setDownloadResult) => {
    addLog('Checking transfer again after retransmission...', 'info');
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
      addLog('File saved after retransmission!', 'success');
      
      fileReceiver.forceCleanup(transferIdRef.current);
      try {
        await resumableTransferManager.completeTransfer(transferIdRef.current);
        await cleanupTransferData(transferIdRef.current);
      } catch (cleanupErr) {
        logger.warn('[Transfer] Cleanup failed:', cleanupErr);
      }
    } else if (retryResult.missingChunks?.length > 0) {
      addLog(`Still missing ${retryResult.missingChunks.length} chunks after retransmit`, 'error');
    }
  };

  /**
   * Pause transfer
   */
  const pauseTransfer = useCallback(async () => {
    const transferId = transferIdRef.current;
    if (!transferId) return;

    if (isHost) {
      await chunkingEngineRef.current.pause(transferId);
      sendJSON({ type: 'transfer-paused', transferId });
      addLog('Sending paused', 'warning');
    } else {
      const result = await fileReceiver.pause(transferId);
      sendJSON({ type: 'transfer-paused', transferId, lastChunk: result.lastChunk });
      addLog(`Receiving paused at chunk ${result.lastChunk}`, 'warning');
    }
    setIsPaused(true);
    setPausedBy('local');
  }, [isHost, sendJSON, addLog]);

  /**
   * Resume transfer
   */
  const resumeTransfer = useCallback(async () => {
    // Only the person who paused can resume
    if (pausedBy === 'remote') return;
    const transferId = transferIdRef.current;
    if (!transferId) return;

    if (isHost) {
      const resumeFromChunk = receiverLastChunkRef.current >= 0 
        ? receiverLastChunkRef.current + 1 
        : undefined;
      
      if (resumeFromChunk !== undefined && selectedFile) {
        const pauseState = chunkingEngineRef.current.getPauseState(transferId);
        
        if (pauseState && pauseState.currentChunkIndex > resumeFromChunk) {
          addLog(`Resyncing: sender at chunk ${pauseState.currentChunkIndex}, receiver at ${resumeFromChunk}`, 'info');
          
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
      receiverLastChunkRef.current = -1;
    } else {
      const result = await fileReceiver.resume(transferId);
      const resumeFromChunk = result.lastChunk + 1;
      sendJSON({ type: 'transfer-resumed', transferId, resumeFromChunk });
      addLog(`Receiving resumed, requesting sender to resume from chunk ${resumeFromChunk}`, 'success');
    }
    setIsPaused(false);
    setPausedBy(null);
  }, [isHost, selectedFile, sendJSON, addLog, handleRetransmitRequest, pausedBy]);

  /**
   * Cancel transfer
   */
  const cancelTransfer = useCallback(() => {
    const transferId = transferIdRef.current;
    if (!transferId) return;

    sendJSON({ type: 'transfer-cancelled', transferId });

    if (isHost) {
      chunkingEngineRef.current.cleanup(transferId);
    } else {
      fileReceiver.cancelTransfer(transferId);
    }
    setTransferState('idle');
    setTransferProgress(0);
    setIsPaused(false);
    setPausedBy(null);
    addLog('Transfer cancelled', 'warning');
  }, [isHost, sendJSON, addLog]);

  /**
   * Handle remote pause signal
   * @param {string} transferId - Transfer ID
   * @param {number} lastChunk - Last chunk received by peer
   */
  const handleRemotePause = useCallback(async (transferId, lastChunk) => {
    if (isHost) {
      await chunkingEngineRef.current.pause(transferId);
      if (lastChunk !== undefined) {
        receiverLastChunkRef.current = lastChunk;
        addLog(`Receiver paused at chunk ${lastChunk}`, 'warning');
      } else {
        addLog('Peer paused transfer', 'warning');
      }
    } else {
      await fileReceiver.pause(transferId);
      addLog('Sender paused transfer', 'warning');
    }
    setIsPaused(true);
    setPausedBy('remote');
  }, [isHost, addLog]);

  /**
   * Handle remote resume signal
   * @param {string} transferId - Transfer ID
   * @param {number} resumeFromChunk - Chunk to resume from
   */
  const handleRemoteResume = useCallback(async (transferId, resumeFromChunk) => {
    if (isHost) {
      const targetChunk = resumeFromChunk ?? (receiverLastChunkRef.current >= 0 ? receiverLastChunkRef.current + 1 : undefined);
      
      if (targetChunk !== undefined && selectedFile) {
        addLog(`Receiver requested resume from chunk ${targetChunk}`, 'info');
        
        const pauseState = chunkingEngineRef.current.getPauseState(transferId);
        
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
        
        await chunkingEngineRef.current.resume(transferId);
        addLog('Sending resumed', 'success');
      } else {
        await chunkingEngineRef.current.resume(transferId);
        addLog('Peer resumed transfer', 'success');
      }
      
      receiverLastChunkRef.current = -1;
    } else {
      await fileReceiver.resume(transferId);
      addLog('Sender resumed transfer', 'success');
    }
    setIsPaused(false);
    setPausedBy(null);
  }, [isHost, selectedFile, addLog, handleRetransmitRequest]);

  /**
   * Handle remote cancel signal
   * @param {string} transferId - Transfer ID
   */
  const handleRemoteCancel = useCallback((transferId) => {
    if (isHost) {
      chunkingEngineRef.current.cleanup(transferId);
    } else {
      fileReceiver.cancelTransfer(transferId);
    }
    setTransferState('idle');
    setTransferProgress(0);
    setIsPaused(false);
    setPausedBy(null);
    addLog('Peer cancelled transfer', 'warning');
  }, [isHost, addLog]);

  /**
   * Reset transfer state to idle (used when switching to a new transfer)
   */
  const resetTransferState = useCallback(() => {
    setTransferState('idle');
    setTransferProgress(0);
    setTransferSpeed(0);
    setTransferEta(null);
    setIsPaused(false);
    setPausedBy(null);
  }, []);

  return {
    // State
    transferState,
    transferProgress,
    transferSpeed,
    transferEta,
    isPaused,
    pausedBy,
    transferId: transferIdRef.current,
    
    // Sending
    startTransfer,
    sendFileChunks,
    handleRetransmitRequest,
    
    // Receiving
    initializeReceive,
    setupFileWriter,
    receiveChunk,
    completeReceive,
    
    // Control
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    resetTransferState,
    
    // Remote signals
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,
  };
}
