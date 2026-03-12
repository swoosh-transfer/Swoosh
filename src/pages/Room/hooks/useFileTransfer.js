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
import { AssemblyEngine } from '../../../transfer/receiving/AssemblyEngine.js';
import { getSocket } from '../../../utils/signaling.js';
import { cleanupTransferData } from '../../../infrastructure/database/index.js';
import { getTransfer } from '../../../infrastructure/database/transfers.repository.js';
import { resumableTransferManager } from '../../../transfer/resumption/ResumableTransferManager.js';
import { progressTracker } from '../../../transfer/shared/ProgressTracker.js';
import { useTransferStore } from '../../../stores/transferStore.js';
import { formatBytes } from '../../../lib/formatters.js';
import { STORAGE_CHUNK_SIZE } from '../../../constants/transfer.constants.js';
import { heartbeatMonitor } from '../../../utils/heartbeatMonitor.js';
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
  const assemblyEngineRef = useRef(new AssemblyEngine()); // NEW: Replace old fileReceiver
  const transferIdRef = useRef(null);
  const sessionIdRef = useRef(null);
  const receivedBytesRef = useRef(0);
  const startTimeRef = useRef(null);
  const receiverLastChunkRef = useRef(-1); // Track receiver's last chunk when paused (sender side)
  const progressUnsubRef = useRef(null); // ProgressTracker subscription cleanup
  const resumeFromChunkRef = useRef(0); // Resume chunk offset when resuming from IndexedDB
  const fileHashRef = useRef(null); // SHA-256 fingerprint for resume verification
  const fileHashKeyRef = useRef(null); // Cache key for current file hash
  const fileHashPromiseRef = useRef(null); // In-flight hash calculation
  const chunkAuthKeyRef = useRef(null); // HMAC key for chunk authentication
  const chunkAuthKeyPromiseRef = useRef(null); // In-flight key derivation

  // Cleanup progress subscription on unmount
  useEffect(() => {
    return () => {
      if (progressUnsubRef.current) {
        progressUnsubRef.current();
        progressUnsubRef.current = null;
      }
    };
  }, []);

  // Auto-pause active transfers when heartbeat detects connection loss
  useEffect(() => {
    const handleConnectionLost = (lostRoomId) => {
      if (lostRoomId !== roomId) return;
      const transferId = transferIdRef.current;
      if (!transferId || transferState === 'idle' || transferState === 'completed' || transferState === 'failed') return;
      if (isPaused) return; // Already paused

      logger.warn(`[FileTransfer] Connection lost, auto-pausing transfer ${transferId}`);
      addLog('Connection lost — transfer auto-paused', 'warning');

      // Pause locally without sending message (connection is down)
      if (isHost) {
        chunkingEngineRef.current.pause(transferId).catch(() => {});
      } else {
        assemblyEngineRef.current.pause?.(transferId)?.catch?.(() => {});
      }
      setIsPaused(true);
      setPausedBy('connection-lost');
      setTransferState('paused');
    };

    const handleConnectionRestored = (restoredRoomId) => {
      if (restoredRoomId !== roomId) return;
      if (pausedBy !== 'connection-lost') return;
      const transferId = transferIdRef.current;
      if (!transferId) return;

      logger.log(`[FileTransfer] Connection restored, auto-resuming transfer ${transferId}`);
      addLog('Connection restored — resuming transfer', 'success');

      if (isHost) {
        chunkingEngineRef.current.resume(transferId).catch(() => {});
      } else {
        assemblyEngineRef.current.resume?.(transferId)?.catch?.(() => {});
      }
      setIsPaused(false);
      setPausedBy(null);
      setTransferState('transferring');
    };

    const unsubLost = heartbeatMonitor.onLost(handleConnectionLost);
    const unsubRestored = heartbeatMonitor.onRestored(handleConnectionRestored);

    return () => {
      unsubLost();
      unsubRestored();
    };
  }, [roomId, isHost, transferState, isPaused, pausedBy, addLog]);

  /**
   * Compute a deterministic file fingerprint used by resume protocol.
   * Uses the first 1MB SHA-256 plus file size/lastModified metadata.
   *
   * @param {File} file
   * @returns {Promise<string|null>}
   */
  const ensureFileHash = useCallback(async (file = selectedFile) => {
    if (!file) return null;

    const cacheKey = `${file.name}:${file.size}:${file.lastModified ?? 0}`;
    if (fileHashRef.current && fileHashKeyRef.current === cacheKey) {
      return fileHashRef.current;
    }

    if (fileHashPromiseRef.current && fileHashKeyRef.current === cacheKey) {
      return fileHashPromiseRef.current;
    }

    fileHashKeyRef.current = cacheKey;
    fileHashPromiseRef.current = (async () => {
      try {
        const sampleSize = Math.min(file.size, 1024 * 1024);
        const sample = await file.slice(0, sampleSize).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', sample);
        const digestHex = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');

        const fingerprint = `${digestHex}:${file.size}:${file.lastModified ?? 0}`;
        fileHashRef.current = fingerprint;
        return fingerprint;
      } catch (error) {
        logger.warn('[FileTransfer] Failed to compute file hash:', error);
        return null;
      } finally {
        fileHashPromiseRef.current = null;
      }
    })();

    return fileHashPromiseRef.current;
  }, [selectedFile]);

  const bytesToHex = useCallback((bytes) => {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }, []);

  const ensureChunkAuthKey = useCallback(async () => {
    if (chunkAuthKeyRef.current) {
      return chunkAuthKeyRef.current;
    }

    if (chunkAuthKeyPromiseRef.current) {
      return chunkAuthKeyPromiseRef.current;
    }

    const sharedSecret = securityPayload?.secret;
    if (!sharedSecret) {
      return null;
    }

    chunkAuthKeyPromiseRef.current = (async () => {
      try {
        const secretBytes = new Uint8Array(
          atob(sharedSecret).split('').map((char) => char.charCodeAt(0))
        );

        const key = await crypto.subtle.importKey(
          'raw',
          secretBytes,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign', 'verify']
        );

        chunkAuthKeyRef.current = key;
        return key;
      } catch (error) {
        logger.warn('[FileTransfer] Failed to derive chunk auth key:', error);
        return null;
      } finally {
        chunkAuthKeyPromiseRef.current = null;
      }
    })();

    return chunkAuthKeyPromiseRef.current;
  }, [securityPayload]);

  const createChunkAuthTag = useCallback(async (metadata, binaryData) => {
    const key = await ensureChunkAuthKey();
    if (!key || !binaryData) {
      return null;
    }

    try {
      const descriptor = `${metadata.transferId ?? transferIdRef.current}:${metadata.chunkIndex}:${metadata.size}`;
      const descriptorBytes = new TextEncoder().encode(descriptor);
      const payload = new Uint8Array(descriptorBytes.length + binaryData.length);
      payload.set(descriptorBytes, 0);
      payload.set(binaryData, descriptorBytes.length);

      const signature = await crypto.subtle.sign('HMAC', key, payload);
      return bytesToHex(new Uint8Array(signature));
    } catch (error) {
      logger.warn('[FileTransfer] Failed to create chunk auth tag:', error);
      return null;
    }
  }, [ensureChunkAuthKey, bytesToHex]);

  const verifyChunkAuthTag = useCallback(async (metadata, data) => {
    const key = await ensureChunkAuthKey();
    if (!key) {
      return true;
    }

    if (!metadata?.authTag) {
      return false;
    }

    try {
      const binaryData = data instanceof Uint8Array ? data : new Uint8Array(data);
      const descriptor = `${metadata.transferId ?? transferIdRef.current}:${metadata.chunkIndex}:${metadata.size}`;
      const descriptorBytes = new TextEncoder().encode(descriptor);
      const payload = new Uint8Array(descriptorBytes.length + binaryData.length);
      payload.set(descriptorBytes, 0);
      payload.set(binaryData, descriptorBytes.length);

      const expectedHex = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, payload)));
      return expectedHex === metadata.authTag;
    } catch (error) {
      logger.warn('[FileTransfer] Failed to verify chunk auth tag:', error);
      return false;
    }
  }, [ensureChunkAuthKey, bytesToHex]);

  /**
   * Start transfer process (send file metadata)
   * @param {string} [resumeTransferId] - Optional: reuse existing transferId when resuming
   */
  const startTransfer = useCallback((resumeTransferId) => {
    if (!selectedFile || !tofuVerified) return null;

    // Use existing transferId when resuming, otherwise generate new UUID
    const transferId = resumeTransferId || crypto.randomUUID();
    const sessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    transferIdRef.current = transferId;
    sessionIdRef.current = sessionId;

    // Precompute file hash in background for secure resume validation.
    // Sending should not block on this calculation.
    ensureFileHash(selectedFile).catch(() => {});

    // Emit analytics event (skip if resuming to avoid duplicate analytics)
    const socket = getSocket();
    if (socket?.connected && !resumeTransferId) {
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
      fileHash: fileHashRef.current || null,
    });

    addLog('Waiting for receiver...', 'info');

    return transferId;
  }, [selectedFile, tofuVerified, roomId, sendJSON, addLog, initiateUpload, ensureFileHash]);

  /**
   * Initialize resume for a paused transfer
   * Sets transferIdRef without resending metadata (metadata already known)
   * @param {string} transferId - Transfer ID to resume
   */
  const initializeResume = useCallback((transferId) => {
    if (!transferId) {
      addLog('Cannot resume: invalid transferId', 'error');
      return;
    }
    
    transferIdRef.current = transferId;
    setTransferState('preparing');
    addLog(`Resuming transfer: ${transferId}`, 'info');

    // Ensure sender has a file hash ready before resume validation messages.
    if (selectedFile) {
      ensureFileHash(selectedFile).catch(() => {});
    }
  }, [addLog]);

  /**
   * Send file chunks to receiver
   * @param {number} [startFromChunk] - Optional: chunk index to resume from
   */
  const sendFileChunks = useCallback(async (startFromChunk) => {
    if (!selectedFile || !tofuVerified) {
      addLog('Cannot send: TOFU not verified', 'error');
      return;
    }

    setTransferState('sending');
    startTimeRef.current = Date.now();

    // Ensure hash is available during active transfer for resume validation.
    await ensureFileHash(selectedFile);

    // Determine resume chunk: use parameter, or ref, or default to 0
    const resumeFromChunk = startFromChunk ?? resumeFromChunkRef.current ?? 0;
    if (resumeFromChunk > 0) {
      addLog(`Resuming from chunk ${resumeFromChunk}...`, 'info');
    }
    resumeFromChunkRef.current = 0; // Clear after use

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

          const authTag = await createChunkAuthTag(metadata, binaryData);

          // Send chunk metadata
          sendJSON({ type: 'chunk-metadata', ...metadata, authTag });

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
        },
        null, // onProgress callback
        resumeFromChunk // resume from this chunk
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
  }, [selectedFile, tofuVerified, securityPayload, roomId, sendJSON, sendBinary, waitForDrain, addLog, ensureFileHash, createChunkAuthTag]);

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
          const authTag = await createChunkAuthTag(metadata, binaryData);
          sendJSON({ type: 'chunk-metadata', ...metadata, authTag });
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
  }, [selectedFile, isHost, sendJSON, sendBinary, waitForDrain, addLog, createChunkAuthTag]);

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

    // Initialize AssemblyEngine for this transfer (replacing old fileReceiver)
    await assemblyEngineRef.current.initializeReceive({
      transferId,
      name,
      size,
      mimeType,
    });

    // Subscribe to ProgressTracker for canonical progress updates (receive side)
    // AssemblyEngine already updates ProgressTracker internally — we just subscribe.
    if (progressUnsubRef.current) progressUnsubRef.current();
    progressUnsubRef.current = progressTracker.subscribe(
      transferId,
      (progress) => {
        setTransferProgress(Math.round(progress.percentage));
        setTransferSpeed(progress.transferSpeed);
        if (progress.estimatedTimeRemaining != null) {
          setTransferEta(progress.estimatedTimeRemaining / 1000);
        }
        receivedBytesRef.current = progress.bytesTransferred || 0;
      }
    );

    assemblyEngineRef.current.onComplete = (tid, result) => {
      addLog('File saved!', 'success');
    };

    // Wire onChunkReceived to send ACKs to sender for sender-side tracking
    assemblyEngineRef.current.onChunkReceived = (tid, chunkIndices, totalChunks) => {
      try {
        sendJSON({
          type: 'chunk-received-ack',
          transferId: tid,
          chunkIndices,
          totalChunks,
        });
      } catch (error) {
        logger.warn('[useFileTransfer] Failed to send chunk ACK:', error);
      }
    };

    assemblyEngineRef.current.onError = (tid, error) => {
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
      const result = await assemblyEngineRef.current.setupFileWriter(transferIdRef.current, fileName);
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
      const authValid = await verifyChunkAuthTag(metadata, data);
      if (!authValid) {
        addLog(`Chunk ${metadata.chunkIndex} authentication failed`, 'error');
        return;
      }

      const result = await assemblyEngineRef.current.receiveChunk(
        transferIdRef.current,
        data,
        {
          chunkIndex: metadata.chunkIndex,
          checksum: metadata.checksum,
          size: metadata.size,
          fileOffset: metadata.fileOffset,
          isFinal: metadata.isFinal,
        }
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
  }, [addLog, trackChunkProgress, verifyChunkAuthTag]);

  /**
   * Complete transfer (finalize file)
   * @param {Function} setDownloadResult - Callback to set download result
   */
  const completeReceive = useCallback(async (setDownloadResult) => {
    addLog('Transfer complete signal', 'info');

    // Wait for any in-flight chunks
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      const result = await assemblyEngineRef.current.completeTransfer(transferIdRef.current);

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
    
    const retryResult = await assemblyEngineRef.current.completeTransfer(transferIdRef.current);
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
    
    const retryResult = await assemblyEngineRef.current.completeTransfer(transferIdRef.current);
    if (retryResult.success) {
      setTransferState('completed');
      setTransferProgress(100);
      setDownloadResult({
        savedToFileSystem: retryResult.savedToFileSystem,
        url: retryResult.url,
        blob: retryResult.blob,
      });
      addLog('File saved after retransmission!', 'success');
      
      assemblyEngineRef.current.forceCleanup(transferIdRef.current);
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
      try {
        await assemblyEngineRef.current.pause(transferId);
        // Get last chunk info from assembly state if available
        const progress = assemblyEngineRef.current.getProgress(transferId);
        const lastChunk = progress ? progress.chunksReceived - 1 : 0;
        sendJSON({ type: 'transfer-paused', transferId, lastChunk });
        addLog(`Receiving paused at chunk ${lastChunk}`, 'warning');
      } catch (error) {
        logger.warn('[FileTransfer] Error pausing transfer:', error);
        addLog(`Error pausing transfer: ${error.message}`, 'error');
      }
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
      try {
        const result = await assemblyEngineRef.current.resume(transferId);
        const resumeFromChunk = result.lastChunk + 1;
        sendJSON({ type: 'transfer-resumed', transferId, resumeFromChunk });
        addLog(`Receiving resumed, requesting sender to resume from chunk ${resumeFromChunk}`, 'success');
      } catch (error) {
        addLog(`Failed to resume receiving: ${error.message}`, 'error');
        logger.warn(`[useFileTransfer] Resume failed for receiver: ${error.message}`);
      }
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
      assemblyEngineRef.current.cancelTransfer(transferId);
    }
    if (progressUnsubRef.current) {
      progressUnsubRef.current();
      progressUnsubRef.current = null;
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
    if (!transferId) {
      addLog('Received pause with undefined transferId — ignoring', 'warning');
      return;
    }

    try {
      if (isHost) {
        await chunkingEngineRef.current.pause(transferId);
        if (lastChunk !== undefined) {
          receiverLastChunkRef.current = lastChunk;
          addLog(`Receiver paused at chunk ${lastChunk}`, 'warning');
        } else {
          addLog('Peer paused transfer', 'warning');
        }
      } else {
        await assemblyEngineRef.current.pause(transferId);
        addLog('Sender paused transfer', 'warning');
      }
      setIsPaused(true);
      setPausedBy('remote');
    } catch (error) {
      logger.warn('[FileTransfer] Error handling remote pause:', error);
      // Don't fail — just log and continue. The transfer might resume via other means.
    }
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
      try {
        await assemblyEngineRef.current.resume(transferId);
        addLog('Sender resumed transfer', 'success');
      } catch (error) {
        addLog(`Failed to resume receiving: ${error.message}`, 'error');
        logger.warn(`[useFileTransfer] handleRemoteResume failed for receiver: ${error.message}`);
      }
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
      assemblyEngineRef.current.cancelTransfer(transferId);
    }
    setTransferState('idle');
    setTransferProgress(0);
    setIsPaused(false);
    setPausedBy(null);
    addLog('Peer cancelled transfer', 'warning');
  }, [isHost, addLog]);

  /**
   * Set the resume chunk offset (called from Room when resume is accepted)
   */
  const setResumeFromChunk = useCallback((chunkIndex) => {
    resumeFromChunkRef.current = chunkIndex;
    logger.log(`[FileTransfer] Resume offset set to chunk ${chunkIndex}`);
  }, []);

  /**
   * Apply receiver bitmap when resume is accepted (sender side)
   * Allows sender to skip chunks that receiver has already received
   */
  const applyReceiverBitmap = useCallback(async (transferId, receiverBitmap, totalChunks) => {
    if (!isHost) {
      logger.warn('[FileTransfer] applyReceiverBitmap called on receiver side');
      return;
    }

    try {
      await chunkingEngineRef.current.applyReceiverBitmap(transferId, receiverBitmap, totalChunks);
      logger.log('[FileTransfer] Applied receiver bitmap to skip already-sent chunks');
    } catch (error) {
      logger.warn('[FileTransfer] Failed to apply receiver bitmap:', error);
    }
  }, [isHost]);

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

  // Apply negotiated config to the chunking engine before a transfer starts
  const applyNegotiatedConfig = useCallback((config) => {
    chunkingEngineRef.current.applyNegotiatedConfig(config);
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
    currentFile: selectedFile,
    fileHash: fileHashRef.current,
    
    // Sending
    startTransfer,
    initializeResume,
    sendFileChunks,
    applyNegotiatedConfig,
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
    
    // Resume
    setResumeFromChunk,
    applyReceiverBitmap,
    ensureFileHash,
    getTransferRecord: getTransfer,
    
    // Remote signals
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,
  };
}
