/**
 * useMessages Hook
 * Manages all message protocol handling for the data channel
 * - Routes messages to appropriate handlers
 * - Manages chunk metadata/binary queuing
 * - Coordinates security verification with data processing
 */
import { useEffect, useCallback, useRef } from 'react';
import logger from '../../../utils/logger.js';

/**
 * Hook for managing message protocol handling
 * @param {Object} dataChannelRef - Ref to data channel
 * @param {boolean} dataChannelReady - Whether data channel is open
 * @param {boolean} isHost - Whether user is the host
 * @param {Object} security - Security hook return value
 * @param {Object} transfer - Transfer hook return value
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
  uiState,
  addLog
) {
  const {
    tofuVerifiedRef,
    chunkMetaQueueRef,
    pendingBinaryQueueRef,
    handleHandshake,
    handleTOFUChallenge,
    handleTOFUResponse,
    handleTOFUVerified,
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
    setPendingFileData,
    setDownloadResultData,
  } = uiState;

  const pendingFileMetadataRef = useRef(null);
  const receiverReadyRef = useRef(false);

  /**
   * Process pending binary data after TOFU verification
   */
  const processPendingData = useCallback(async () => {
    // Process all pending binary data that was queued during verification
    while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
      const binary = pendingBinaryQueueRef.current.shift();
      const meta = chunkMetaQueueRef.current.shift();
      if (meta && binary) {
        await receiveChunk(meta, binary);
      }
    }
  }, [pendingBinaryQueueRef, chunkMetaQueueRef, receiveChunk]);

  const processPendingControl = useCallback(async () => {
    if (!tofuVerifiedRef.current) return;

    if (pendingFileMetadataRef.current) {
      const pendingMeta = pendingFileMetadataRef.current;
      pendingFileMetadataRef.current = null;
      await initializeReceive(pendingMeta, setPendingFileData);
    }

    if (receiverReadyRef.current && isHost) {
      receiverReadyRef.current = false;
      await sendFileChunks();
    }
  }, [initializeReceive, isHost, sendFileChunks, setPendingFileData, tofuVerifiedRef]);

  /**
   * Handle incoming binary chunk data
   * @param {Uint8Array} data - Binary chunk data
   */
  const handleChunkData = useCallback(async (data) => {
    // Check if we have metadata waiting
    if (chunkMetaQueueRef.current.length > 0) {
      const meta = chunkMetaQueueRef.current.shift();
      await receiveChunk(meta, data);
    } else {
      // Binary arrived before metadata - queue it
      pendingBinaryQueueRef.current.push(data);
    }
  }, [chunkMetaQueueRef, pendingBinaryQueueRef, receiveChunk]);

  /**
   * Main message handler for data channel
   * Routes messages to appropriate handlers
   * @param {MessageEvent} event - Message event
   */
  const handleMessage = useCallback(async (event) => {
    try {
      // Binary data = file chunk
      if (event.data instanceof ArrayBuffer) {
        // SECURITY: Queue chunks until TOFU is verified
        if (!tofuVerifiedRef.current) {
          addLog('Received chunk before TOFU verification - queuing', 'warning');
          pendingBinaryQueueRef.current.push(new Uint8Array(event.data));
          return;
        }
        await handleChunkData(new Uint8Array(event.data));
        return;
      }

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'handshake': {
          await handleHandshake(msg);
          break;
        }

        case 'tofu-challenge':
          await handleTOFUChallenge(msg, async () => {
            await processPendingData();
            await processPendingControl();
          });
          break;

        case 'tofu-response':
          await handleTOFUResponse(msg, async () => {
            await processPendingData();
            await processPendingControl();
          });
          break;

        case 'tofu-verified':
          handleTOFUVerified(async () => {
            await processPendingData();
            await processPendingControl();
          });
          break;

        case 'file-metadata':
          // SECURITY: Block until TOFU is verified
          if (!tofuVerifiedRef.current) {
            addLog('Received file metadata before TOFU verification - queued', 'warning');
            pendingFileMetadataRef.current = msg;
            return;
          }
          await initializeReceive(msg, setPendingFileData);
          break;

        case 'chunk-metadata':
          // Queue metadata - binary may arrive before or after
          chunkMetaQueueRef.current.push(msg);
          // Check if we have pending binaries waiting for metadata
          while (pendingBinaryQueueRef.current.length > 0 && chunkMetaQueueRef.current.length > 0) {
            const binary = pendingBinaryQueueRef.current.shift();
            await handleChunkData(binary);
          }
          break;

        case 'receiver-ready':
          if (isHost) {
            // SECURITY: Only send after TOFU verification
            if (!tofuVerifiedRef.current) {
              addLog('Receiver ready before TOFU - queued', 'warning');
              receiverReadyRef.current = true;
              return;
            }
            addLog('Receiver ready, sending...', 'success');
            await sendFileChunks();
          }
          break;

        case 'transfer-complete':
          await completeReceive(setDownloadResultData);
          break;

        case 'request-chunks':
          addLog(`Retransmit requested: ${msg.chunks.length} chunks`, 'warning');
          await handleRetransmitRequest(msg.chunks);
          break;

        case 'transfer-paused':
          await handleRemotePause(msg.transferId, msg.lastChunk);
          break;

        case 'transfer-resumed':
          await handleRemoteResume(msg.transferId, msg.resumeFromChunk);
          break;

        case 'transfer-cancelled':
          handleRemoteCancel(msg.transferId);
          break;

        default:
          logger.log('[Room] Unknown message:', msg.type);
      }
    } catch (err) {
      logger.error('[Room] Message error:', err);
    }
  }, [
    isHost,
    tofuVerifiedRef,
    chunkMetaQueueRef,
    pendingBinaryQueueRef,
    handleHandshake,
    handleTOFUChallenge,
    handleTOFUResponse,
    handleTOFUVerified,
    sendFileChunks,
    initializeReceive,
    handleChunkData,
    completeReceive,
    handleRetransmitRequest,
    handleRemotePause,
    handleRemoteResume,
    handleRemoteCancel,
    setPendingFileData,
    setDownloadResultData,
    processPendingData,
    processPendingControl,
    addLog,
  ]);

  /**
   * Setup message listener on data channel
   */
  useEffect(() => {
    const channel = dataChannelRef.current;
    if (!channel || !dataChannelReady) return;

    // Set up message handler
    channel.onmessage = handleMessage;

    // Send handshake when channel is ready
    if (channel.readyState === 'open') {
      sendHandshake(channel);
    }

    return () => {
      // Cleanup is handled by channel.onclose in useRoomConnection
    };
  }, [dataChannelRef, dataChannelReady, handleMessage, sendHandshake]);

  return {
    handleMessage,
  };
}
