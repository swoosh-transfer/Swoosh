/**
 * useMessages Hook
 * Manages all message protocol handling for the data channel.
 * Routes messages to appropriate handlers.
 *
 * With encrypted signaling, verification happens at the signaling layer —
 * if the data channel opens the peer is already trusted, so there is no
 * TOFU challenge/response exchange and no pre-verification queuing.
 *
 * Supports both single-file (legacy) and multi-file message types.
 */
import { useEffect, useCallback, useRef } from 'react';
import { MESSAGE_TYPE } from '../../../constants/messages.constants.js';
import { getChannelPool } from '../../../utils/p2pManager.js';
import logger from '../../../utils/logger.js';

/**
 * Hook for managing message protocol handling
 * @param {Object} dataChannelRef - Ref to data channel
 * @param {boolean} dataChannelReady - Whether data channel is open
 * @param {boolean} isHost - Whether user is the host
 * @param {Object} security - Security hook return value
 * @param {Object} transfer - Single-file transfer hook return value
 * @param {Object} multiTransfer - Multi-file transfer hook return value
 * @param {Object} uiState - UI state hook return value
 * @param {Function} addLog - Logging function
 * @returns {Object} Message handlers
 */
export function useMessages(
  dataChannelRef,
  dataChannelReady,
  isHost,
  security,
  transfer,
  multiTransfer,
  uiState,
  addLog
) {
  const {
    handleHandshake,
    sendHandshake,
  } = security;

  const {
    sendFileChunks,
    handleRetransmitRequest,
    initializeReceive,
    receiveChunk,
    completeReceive,
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,
  } = transfer;

  const {
    handleMultiFileManifest,
    handleMultiChunkMetadata,
    handleMultiBinaryChunk,
    handleFileComplete: handleMultiFileComplete,
    handleRemotePause: handleMultiRemotePause,
    handleRemoteResume: handleMultiRemoteResume,
    handleRemoteCancel: handleMultiRemoteCancel,
    onReceiverReady: handleMultiReceiverReady,
  } = multiTransfer;

  const {
    setPendingFileData,
    setDownloadResultData,
  } = uiState;

  const chunkMetaQueueRef = useRef([]);
  const pendingBinaryQueueRef = useRef([]);
  /** Track whether we're in a multi-file transfer */
  const isMultiFileRef = useRef(false);
  /** Per-channel metadata queues for correct binary↔metadata matching in multi-channel mode */
  const perChannelMetaRef = useRef(new Map());
  /** Per-channel pending binary queues (for chunks arriving before metadata) */
  const perChannelPendingBinaryRef = useRef(new Map());
  /** Message processing serialization */
  const messageQueueRef = useRef([]);
  const isProcessingRef = useRef(false);

  /**
   * Mark that we're in multi-file transfer mode (called by sender before sending manifest)
   */
  const setMultiFileMode = useCallback((value) => {
    isMultiFileRef.current = value;
  }, []);

  /**
   * Handle incoming binary chunk data
   * @param {Uint8Array} data - Binary chunk data
   * @param {number} channelIndex - Channel the binary arrived on (for multi-channel matching)
   */
  const handleChunkData = useCallback(async (data, channelIndex = 0) => {
    if (isMultiFileRef.current) {
      // Multi-file: match binary to metadata from the SAME channel.
      // This prevents cross-channel interleaving from corrupting file data.
      // Since messages are serialized, metadata should always be in the queue when binary arrives.
      const queue = perChannelMetaRef.current.get(channelIndex);
      const meta = queue?.length > 0 ? queue.shift() : null;
      
      if (meta) {
        // Metadata found — process immediately
        const fileIndex = meta.fileIndex;
        await handleMultiBinaryChunk(data, fileIndex);
      } else {
        // No metadata yet — this should rarely happen due to message serialization,
        // but queue the binary just in case of out-of-order network delivery
        if (!perChannelPendingBinaryRef.current.has(channelIndex)) {
          perChannelPendingBinaryRef.current.set(channelIndex, []);
        }
        perChannelPendingBinaryRef.current.get(channelIndex).push(data);
        logger.warn(`[Room] Binary arrived before metadata on channel ${channelIndex}, queued`);
      }
      return;
    }

    if (chunkMetaQueueRef.current.length > 0) {
      const meta = chunkMetaQueueRef.current.shift();
      await receiveChunk(meta, data);
    } else {
      // Binary arrived before metadata — queue it
      pendingBinaryQueueRef.current.push(data);
    }
  }, [receiveChunk, handleMultiBinaryChunk]);

  /**
   * Main message processor for data channel.
   * All messages arrive only after encrypted signaling succeeded,
   * so they are implicitly trusted.
   * @param {MessageEvent} event - Message event
   */
  const processMessage = useCallback(async (event) => {
    try {
      // Extract channel index (set by pool listener for channels 1+, 0 for control)
      const channelIndex = event._channelIndex ?? 0;

      // Binary data = file chunk
      if (event.data instanceof ArrayBuffer) {
        await handleChunkData(new Uint8Array(event.data), channelIndex);
        return;
      }

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'handshake':
          await handleHandshake(msg);
          break;

        // ─── Multi-file messages ──────────────────────────────
        case MESSAGE_TYPE.MULTI_FILE_MANIFEST:
          isMultiFileRef.current = true;
          // Clear per-channel metadata & pending binary queues for new transfer
          perChannelMetaRef.current.clear();
          perChannelPendingBinaryRef.current.clear();
          await handleMultiFileManifest(msg);
          break;

        case MESSAGE_TYPE.FILE_START:
          // Handled internally by MultiFileReceiver
          break;

        case MESSAGE_TYPE.FILE_COMPLETE:
          await handleMultiFileComplete(msg.fileIndex);
          break;

        case MESSAGE_TYPE.CHANNEL_READY:
          addLog(`Channel ${msg.channelIndex} ready`, 'info');
          break;

        // ─── Single-file messages ─────────────────────────────
        case 'file-metadata':
          await initializeReceive(msg, setPendingFileData);
          break;

        case 'chunk-metadata':
          if (isMultiFileRef.current) {
            // Store in per-channel queue so the next binary on this channel
            // matches the correct metadata (prevents cross-channel corruption)
            const chIdx = channelIndex;
            if (!perChannelMetaRef.current.has(chIdx)) {
              perChannelMetaRef.current.set(chIdx, []);
            }
            perChannelMetaRef.current.get(chIdx).push(msg);
            handleMultiChunkMetadata(msg);
            
            // Drain any pending binaries on this channel that were waiting for metadata
            const pendingQueue = perChannelPendingBinaryRef.current.get(chIdx);
            if (pendingQueue?.length > 0) {
              let nextBinary;
              while ((nextBinary = pendingQueue.shift()) !== undefined) {
                await handleChunkData(nextBinary, chIdx);
              }
            }
          } else {
            chunkMetaQueueRef.current.push(msg);
            // Drain any pending binaries waiting for metadata
            while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
              const binary = pendingBinaryQueueRef.current.shift();
              await handleChunkData(binary);
            }
          }
          break;

        case 'receiver-ready':
          // Either side can be the sender (bidirectional), so no isHost gate.
          // If we have an active sender, unblock it; otherwise the call is a safe no-op.
          addLog('Receiver ready, sending...', 'success');
          if (isMultiFileRef.current) {
            // Signal the MultiFileTransferManager to start sending data
            handleMultiReceiverReady();
          } else {
            await sendFileChunks();
          }
          break;

        case 'transfer-complete':
          if (!isMultiFileRef.current) {
            await completeReceive(setDownloadResultData);
          }
          // Multi-file completion is handled by MultiFileReceiver
          break;

        case 'request-chunks':
          addLog(`Retransmit requested: ${msg.chunks.length} chunks`, 'warning');
          await handleRetransmitRequest(msg.chunks);
          break;

        case 'transfer-paused':
          if (isMultiFileRef.current) {
            handleMultiRemotePause();
          } else {
            await handleRemotePause(msg.transferId, msg.lastChunk);
          }
          break;

        case 'transfer-resumed':
          if (isMultiFileRef.current) {
            handleMultiRemoteResume();
          } else {
            await handleRemoteResume(msg.transferId, msg.resumeFromChunk);
          }
          break;

        case 'transfer-cancelled':
          if (isMultiFileRef.current) {
            handleMultiRemoteCancel();
          } else {
            handleRemoteCancel(msg.transferId);
          }
          break;

        // ─── Resume protocol ─────────────────────────────────
        case MESSAGE_TYPE.RESUME_TRANSFER:
          addLog(`Peer requests resume: ${msg.fileName || msg.transferId}`, 'info');
          // TODO Phase 4: Verify file match, accept/reject resume
          logger.log('[Room] Resume request received:', msg);
          break;

        case MESSAGE_TYPE.RESUME_ACCEPTED:
          addLog(`Resume accepted, starting from chunk ${msg.startFromChunk}`, 'success');
          // TODO Phase 4: Start sending from msg.startFromChunk
          logger.log('[Room] Resume accepted:', msg);
          break;

        case MESSAGE_TYPE.RESUME_REJECTED:
          addLog(`Resume rejected: ${msg.reason || 'file mismatch'}`, 'warning');
          logger.log('[Room] Resume rejected:', msg);
          break;

        default:
          logger.log('[Room] Unknown message:', msg.type);
      }
    } catch (err) {
      logger.error('[Room] Message error:', err);
    }
  }, [
    handleHandshake,
    sendFileChunks,
    initializeReceive,
    handleChunkData,
    completeReceive,
    handleRetransmitRequest,
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,
    handleMultiFileManifest,
    handleMultiChunkMetadata,
    handleMultiBinaryChunk,
    handleMultiFileComplete,
    handleMultiRemotePause,
    handleMultiRemoteResume,
    handleMultiRemoteCancel,
    handleMultiReceiverReady,
    setPendingFileData,
    setDownloadResultData,
    addLog,
  ]);

  /**
   * Serializing message handler — ensures messages are processed one at a time
   * to prevent race conditions with async chunk processing.
   */
  const handleMessage = useCallback((event) => {
    messageQueueRef.current.push(event);

    if (isProcessingRef.current) return;

    const drain = async () => {
      isProcessingRef.current = true;
      while (messageQueueRef.current.length > 0) {
        const nextEvent = messageQueueRef.current.shift();
        await processMessage(nextEvent);
      }
      isProcessingRef.current = false;
    };

    drain();
  }, [processMessage]);

  /**
   * Setup message listener on data channel
   */
  useEffect(() => {
    const channel = dataChannelRef.current;
    if (!channel || !dataChannelReady) return;

    channel.onmessage = handleMessage;

    // Send handshake when channel is ready
    if (channel.readyState === 'open') {
      sendHandshake(channel);
    }
  }, [dataChannelRef, dataChannelReady, handleMessage, sendHandshake]);

  /**
   * Listen for messages on ALL data channels (1+) via ChannelPool.
   * Channel-0 is handled directly above via channel.onmessage.
   * Channels 1+ are used by MultiFileTransferManager for multi-channel chunk delivery.
   */
  useEffect(() => {
    const pool = getChannelPool();
    if (!pool || !dataChannelReady) return;

    const onPoolMessage = (channelIndex, event) => {
      // Only handle messages from data channels (1+)
      // Channel-0 is already handled via its own onmessage above
      if (channelIndex >= 1) {
        // Wrap event with channel index for correct per-channel binary↔metadata matching
        handleMessage({ data: event.data, _channelIndex: channelIndex });
      }
    };

    pool.on('channel-message', onPoolMessage);
    return () => pool.off('channel-message', onPoolMessage);
  }, [handleMessage, dataChannelReady]);

  return {
    handleMessage,
    setMultiFileMode,
  };
}
