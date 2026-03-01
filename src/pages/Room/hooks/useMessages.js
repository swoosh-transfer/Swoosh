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
    startMultiTransfer,
  } = multiTransfer;

  const {
    setPendingFileData,
    setDownloadResultData,
  } = uiState;

  const chunkMetaQueueRef = useRef([]);
  const pendingBinaryQueueRef = useRef([]);
  /** Track whether we're in a multi-file transfer */
  const isMultiFileRef = useRef(false);

  /**
   * Handle incoming binary chunk data
   * @param {Uint8Array} data - Binary chunk data
   */
  const handleChunkData = useCallback(async (data) => {
    if (isMultiFileRef.current) {
      // Multi-file: route based on pending metadata
      await handleMultiBinaryChunk(data);
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
   * Main message handler for data channel.
   * All messages arrive only after encrypted signaling succeeded,
   * so they are implicitly trusted.
   * @param {MessageEvent} event - Message event
   */
  const handleMessage = useCallback(async (event) => {
    try {
      // Binary data = file chunk
      if (event.data instanceof ArrayBuffer) {
        await handleChunkData(new Uint8Array(event.data));
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
            handleMultiChunkMetadata(msg);
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
          if (isHost) {
            addLog('Receiver ready, sending...', 'success');
            // Determine if we're in multi-file mode based on whether manifest was sent
            if (isMultiFileRef.current) {
              // Multi-file already started via startMultiTransfer
              // The receiver-ready signal comes in during the start flow
            } else {
              await sendFileChunks();
            }
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

        default:
          logger.log('[Room] Unknown message:', msg.type);
      }
    } catch (err) {
      logger.error('[Room] Message error:', err);
    }
  }, [
    isHost,
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
    setPendingFileData,
    setDownloadResultData,
    addLog,
  ]);

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

  return {
    handleMessage,
  };
}
