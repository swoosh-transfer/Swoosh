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
import { getLocalTransferConfig, negotiateTransferConfig } from '../../../constants/transfer.constants.js';
import {
  deserializeBitmap,
  getFirstMissingChunk,
  createBitmap,
  markChunk,
  serializeBitmap,
  getMissingChunks,
} from '../../../infrastructure/database/chunkBitmap.js';
import { updateTransfer } from '../../../infrastructure/database/transfers.repository.js';
import logger from '../../../utils/logger.js';
import { heartbeatMonitor } from '../../../utils/heartbeatMonitor.js';
import { 
  notifyPeerJoined, 
  notifyPeerDisconnected,
  notifyPeerReconnected,
  notifyResumeSuccess,
  notifyResumeFailed,
  notifySessionMismatch,
} from '../../../utils/transferNotifications.js';
import { verifyPeer, getPeerSessionMetadata, isNewSession } from '../../../utils/identityManager.js';
import { resumeEventBus } from './resumeEventBus.js';

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
 * @param {Function} sendJSON - JSON message sender
 * @param {string} roomId - Room identifier
 * @param {string} localUuid - Local UUID
 * @param {Object} sessionToken - Ref to local session token
 * @param {Object} peerSessionToken - Ref to peer's session token
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
  addLog,
  sendJSON,
  roomId,
  localUuid,
  sessionToken,
  peerSessionToken
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
    applyNegotiatedConfig,
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
  /** Track file indices that have errored, to stop processing further chunks */
  const failedFilesRef = useRef(new Set());
  // Negotiated transfer config between peers
  const negotiatedConfigRef = useRef(null);
  /** Per-channel metadata queues for correct binary↔metadata matching in multi-channel mode */
  const perChannelMetaRef = useRef(new Map());
  /** Per-channel pending binary queues (for chunks arriving before metadata) */
  const perChannelPendingBinaryRef = useRef(new Map());
  /** Message processing serialization */
  const messageQueueRef = useRef([]);
  const isProcessingRef = useRef(false);
  const pendingResumeRequestRef = useRef(null);
  const resumeWaitLoggedRef = useRef(false);
  
  /** Sender-side chunk tracking: transferId → bitmap of chunks receiver has acknowledged */
  const senderChunkBitmapsRef = useRef(new Map());
  const lastSenderFlushRef = useRef(new Map()); // transferId → last chunk count when flushed
  const SENDER_BITMAP_FLUSH_INTERVAL = 50; // Flush sender bitmap every 50 ACKs

  /**
   * Dispatch a resume request immediately, or queue it until peer handshake/session token exists.
   * @param {Object} transferInfo
   * @param {{ fromQueue?: boolean }} [options]
   * @returns {boolean}
   */
  const dispatchResumeRequest = useCallback((transferInfo, options = {}) => {
    const { fromQueue = false } = options;

    if (!sendJSON) {
      logger.warn('[Room] Cannot send resume request — sendJSON not available');
      return false;
    }

    if (!peerSessionToken?.current) {
      pendingResumeRequestRef.current = transferInfo;
      if (!resumeWaitLoggedRef.current) {
        addLog('Resume waiting for peer handshake...', 'warning');
        resumeWaitLoggedRef.current = true;
      }
      return false;
    }

    sendJSON({
      type: MESSAGE_TYPE.RESUME_TRANSFER,
      transferId: transferInfo.transferId,
      fileName: transferInfo.fileName,
      fileSize: transferInfo.fileSize,
      fileHash: transferInfo.fileHash || null,
      totalChunks: transferInfo.totalChunks,
      chunkBitmap: transferInfo.chunkBitmap || null,
      requesterUuid: localUuid || null,
      sessionToken: peerSessionToken.current,
    });

    pendingResumeRequestRef.current = null;
    if (resumeWaitLoggedRef.current || fromQueue) {
      addLog('Resume request sent after peer handshake', 'info');
    } else {
      addLog(`Sent resume request for: ${transferInfo.fileName}`, 'info');
    }
    resumeWaitLoggedRef.current = false;
    return true;
  }, [sendJSON, addLog, localUuid, peerSessionToken]);

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
        // Skip chunks for files that already have a write error
        if (failedFilesRef.current.has(meta.fileIndex)) {
          return;
        }
        // Fire-and-forget: DON'T await the disk write.
        // WriteQueue handles ordering and sequential writes internally.
        // Awaiting here serialized ALL chunk processing across ALL channels,
        // which was the #1 receiver-side throughput bottleneck.
        handleMultiBinaryChunk(data, meta.fileIndex, meta).catch(err => {
          logger.error(`[Room] Chunk write error file=${meta.fileIndex} chunk=${meta.chunkIndex}:`, err);
          // Mark this file as failed to stop processing more chunks for it
          failedFilesRef.current.add(meta.fileIndex);
        });
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
          // Send local transfer config for negotiation
          sendJSON({ type: MESSAGE_TYPE.CONFIG_EXCHANGE, config: getLocalTransferConfig() });
          if (pendingResumeRequestRef.current && peerSessionToken?.current) {
            const pendingRequest = pendingResumeRequestRef.current;
            dispatchResumeRequest(pendingRequest, { fromQueue: true });
          }
          break;

        // ─── Multi-file messages ──────────────────────────────
        case MESSAGE_TYPE.MULTI_FILE_MANIFEST:
          isMultiFileRef.current = true;
          // Clear per-channel metadata & pending binary queues for new transfer
          perChannelMetaRef.current.clear();
          perChannelPendingBinaryRef.current.clear();
          failedFilesRef.current.clear();
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
            // Apply negotiated transfer config before starting
            if (applyNegotiatedConfig && negotiatedConfigRef.current) {
              applyNegotiatedConfig(negotiatedConfigRef.current);
            }
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

        // ─── Chunk Acknowledgment (Sender-side tracking) ──────
        case MESSAGE_TYPE.CHUNK_RECEIVED_ACK: {
          // Receiver acknowledges received chunks so sender can track resume state
          const { transferId, chunkIndices } = msg;
          if (!transferId || !Array.isArray(chunkIndices)) {
            logger.warn('[Room] Invalid CHUNK_RECEIVED_ACK:', msg);
            break;
          }

          // Get or create sender bitmap for this transfer
          let senderBitmap = senderChunkBitmapsRef.current.get(transferId);
          if (!senderBitmap && msg.totalChunks) {
            senderBitmap = createBitmap(msg.totalChunks);
            senderChunkBitmapsRef.current.set(transferId, senderBitmap);
          }

          if (senderBitmap) {
            // Mark chunks as acknowledged by receiver
            chunkIndices.forEach(idx => markChunk(senderBitmap, idx));

            // Periodically flush sender bitmap to IndexedDB
            const lastFlush = lastSenderFlushRef.current.get(transferId) || 0;
            const currentCount = chunkIndices.length;
            
            if (currentCount - lastFlush >= SENDER_BITMAP_FLUSH_INTERVAL) {
              try {
                const serialized = serializeBitmap(senderBitmap);
                await updateTransfer(transferId, {
                  senderChunkBitmap: serialized,
                  updatedAt: Date.now(),
                });
                lastSenderFlushRef.current.set(transferId, currentCount);
                logger.log(`[Room] Sender bitmap flushed for ${transferId}: ${currentCount} ACKs`);
              } catch (error) {
                logger.warn('[Room] Failed to flush sender bitmap:', error);
              }
            }
          }
          break;
        }

        // ─── Heartbeat ────────────────────────────────────────
        case MESSAGE_TYPE.HEARTBEAT:
          // Respond with ACK that echoes the original timestamp for RTT measurement
          sendJSON({ type: MESSAGE_TYPE.HEARTBEAT_ACK, timestamp: Date.now(), originalTimestamp: msg.timestamp });
          // Record that we received a heartbeat from peer
          if (roomId) {
            heartbeatMonitor.recordHeartbeat(roomId);
          }
          break;

        case MESSAGE_TYPE.HEARTBEAT_ACK:
          // Heartbeat acknowledged - pass original timestamp for RTT calculation
          if (roomId) {
            heartbeatMonitor.recordHeartbeat(roomId, msg.originalTimestamp);
          }
          break;

        // ─── Config negotiation ──────────────────────────────
        case MESSAGE_TYPE.CONFIG_EXCHANGE: {
          const localConfig = getLocalTransferConfig();
          const agreed = negotiateTransferConfig(localConfig, msg.config);
          negotiatedConfigRef.current = agreed;
          sendJSON({ type: MESSAGE_TYPE.CONFIG_ACK, config: agreed });
          logger.log(`[Room] Config negotiated: chunk=${agreed.chunkSize / 1024}KB, channels=${agreed.maxChannels}, constrained=${agreed.constrained}`);
          addLog(`Synced config: ${agreed.chunkSize / 1024}KB chunks, ${agreed.maxChannels} channels`, 'success');
          break;
        }

        case MESSAGE_TYPE.CONFIG_ACK: {
          negotiatedConfigRef.current = msg.config;
          logger.log(`[Room] Config acknowledged: chunk=${msg.config.chunkSize / 1024}KB, channels=${msg.config.maxChannels}`);
          break;
        }

        // ─── Resume protocol ─────────────────────────────────
        case MESSAGE_TYPE.RESUME_TRANSFER: {
          addLog(`Peer requests resume: ${msg.fileName || msg.transferId}`, 'info');
          logger.log('[Room] Resume request received:', msg);

          // ★ CRITICAL: Verify session token FIRST for replay protection
          if (!msg.sessionToken || msg.sessionToken !== sessionToken?.current) {
            sendJSON({
              type: MESSAGE_TYPE.RESUME_REJECTED,
              transferId: msg.transferId,
              reason: 'Invalid or missing session token (replay protection)',
            });
            addLog('Resume rejected: invalid session token', 'warning');
            logger.warn('[Room] Resume rejected: session token mismatch');
            break;
          }

          // ★ CRITICAL: Verify peer identity BEFORE accepting resume
          // This prevents a different peer from hijacking the transfer
          if (!roomId || !msg.requesterUuid) {
            sendJSON({
              type: MESSAGE_TYPE.RESUME_REJECTED,
              transferId: msg.transferId,
              reason: 'Peer identity not provided for resume verification',
            });
            addLog('Resume rejected: missing peer identity for verification', 'warning');
            break;
          }

          let isPeerVerified = true;
          let verificationReason = '';
          
          // Check if this is the same peer from the original transfer
          const isKnownPeer = await verifyPeer(msg.requesterUuid, roomId);
          if (!isKnownPeer) {
            isPeerVerified = false;
            const peerSession = await getPeerSessionMetadata(roomId);
            const expectedPeer = peerSession?.peerUuid || 'unknown';
            verificationReason = `Different peer detected - expected ${expectedPeer}, got ${msg.requesterUuid}`;
            if (peerSession?.peerUuid) {
              notifySessionMismatch(peerSession.peerUuid, msg.requesterUuid);
            }
            logger.warn(`[Room] Session mismatch: ${verificationReason}`);
          } else {
            notifyPeerReconnected(msg.requesterUuid, true);
          }

          // Reject immediately if peer verification fails
          if (!isPeerVerified) {
            sendJSON({
              type: MESSAGE_TYPE.RESUME_REJECTED,
              transferId: msg.transferId,
              reason: verificationReason,
            });
            addLog(`Resume rejected: ${verificationReason}`, 'warning');
            notifyResumeFailed(msg.fileName, verificationReason);
            break;
          }

          // Sender-side: validate the file the receiver wants to resume
          const currentFile = transfer.currentFile || (transfer.selectedFile);
          let accepted = false;
          let reason = '';

          if (!currentFile) {
            reason = 'No file currently selected to resume';
          } else if (msg.fileSize !== undefined && currentFile.size !== msg.fileSize) {
            reason = `File size mismatch: expected ${msg.fileSize}, got ${currentFile.size}`;
          } else if (!msg.fileHash) {
            reason = 'Resume rejected: missing file hash in resume request';
          } else {
            const localHash = transfer.fileHash || await transfer.ensureFileHash?.(currentFile);
            if (!localHash) {
              reason = 'Resume rejected: unable to verify file hash';
            } else if (msg.fileHash !== localHash) {
              reason = 'File hash mismatch — file may have changed';
            } else {
              accepted = true;
            }
          }

          if (accepted) {
            // Determine where to resume from using the receiver's bitmap
            let startFromChunk = 0;
            let missingChunks = [];
            
            if (msg.chunkBitmap && msg.totalChunks) {
              const receiverBitmap = deserializeBitmap(msg.chunkBitmap);
              startFromChunk = getFirstMissingChunk(receiverBitmap, msg.totalChunks);
              missingChunks = getMissingChunks(receiverBitmap, msg.totalChunks);
              
              if (startFromChunk === -1) {
                startFromChunk = msg.totalChunks; // All complete
                missingChunks = [];
              }
            }

            // Get sender bitmap if available (tracks which chunks were already sent)
            let senderBitmapSerialized = null;
            try {
              const transferRecord = await transfer.getTransferRecord?.(msg.transferId);
              if (transferRecord?.chunkBitmap) {
                senderBitmapSerialized = transferRecord.chunkBitmap;
              }
            } catch (error) {
              logger.warn('[Room] Failed to load sender bitmap:', error);
            }

            sendJSON({
              type: MESSAGE_TYPE.RESUME_ACCEPTED,
              transferId: msg.transferId,
              startFromChunk,
              totalChunks: msg.totalChunks,
              missingChunks: missingChunks.length > 100 ? [] : missingChunks, // Send list if reasonable size
              senderBitmap: senderBitmapSerialized,
            });
            
            const chunkCount = missingChunks.length || (msg.totalChunks - startFromChunk);
            addLog(`Resume accepted — ${chunkCount} chunks to send from ${startFromChunk}`, 'success');
            notifyResumeSuccess(msg.fileName, chunkCount);
          } else {
            sendJSON({
              type: MESSAGE_TYPE.RESUME_REJECTED,
              transferId: msg.transferId,
              reason,
            });
            addLog(`Resume rejected: ${reason}`, 'warning');
            notifyResumeFailed(msg.fileName, reason);
          }
          break;
        }

        case MESSAGE_TYPE.RESUME_ACCEPTED: {
          addLog(`Resume accepted, starting from chunk ${msg.startFromChunk}`, 'success');
          logger.log('[Room] Resume accepted:', msg);

          // Store sender's bitmap if provided — helps sender track which chunks we already have
          if (msg.senderBitmap && msg.transferId) {
            try {
              await updateTransfer(msg.transferId, {
                senderChunkBitmap: msg.senderBitmap,
              });
              logger.log('[Room] Stored sender bitmap for transfer:', msg.transferId);
            } catch (error) {
              logger.warn('[Room] Failed to store sender bitmap:', error);
            }
          }

          // Extract missing chunks list if provided
          let missingChunksList = msg.missingChunks || [];
          
          // Emit resume accepted event (consumed by useResumeTransfer)
          resumeEventBus.emit('resumeAccepted', {
            transferId: msg.transferId,
            startFromChunk: msg.startFromChunk,
            totalChunks: msg.totalChunks,
            missingChunks: missingChunksList,
            senderBitmap: msg.senderBitmap,
          });
          break;
        }

        case MESSAGE_TYPE.RESUME_REJECTED: {
          addLog(`Resume rejected: ${msg.reason || 'file mismatch'}`, 'warning');
          logger.log('[Room] Resume rejected:', msg);

          // Emit resume rejected event (consumed by useResumeTransfer)
          resumeEventBus.emit('resumeRejected', {
            transferId: msg.transferId,
            reason: msg.reason,
          });
          break;
        }

        default:
          logger.log('[Room] Unknown message:', msg.type);
      }
    } catch (err) {
      logger.error('[Room] Message error:', err);
    }
  }, [
    handleHandshake,
    sendFileChunks,
    applyNegotiatedConfig,
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
    sendJSON,
    roomId,
    peerSessionToken,
    dispatchResumeRequest,
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

  /**
   * Send a resume request to the peer.
   * Called when entering a room with resume context.
   * Includes session token for replay protection.
   * 
   * @param {Object} transferInfo - Resume context
   * @param {string} transferInfo.transferId - Original transfer ID
   * @param {string} transferInfo.fileName - File name
   * @param {number} transferInfo.fileSize - File size in bytes
   * @param {string} [transferInfo.fileHash] - SHA-256 hash of first N bytes
   * @param {number} transferInfo.totalChunks - Total chunk count
   * @param {string} [transferInfo.chunkBitmap] - Base64 bitmap of completed chunks
   */
  const sendResumeRequest = useCallback((transferInfo) => {
    dispatchResumeRequest(transferInfo);
  }, [dispatchResumeRequest]);

  /**
   * Subscribe to resume request events from useResumeTransfer.
   * When resume hook emits 'resumeRequest', send the actual RESUME_TRANSFER message.
   */
  useEffect(() => {
    const unsubscribe = resumeEventBus.on('resumeRequest', (transferInfo) => {
      sendResumeRequest(transferInfo);
    });

    return unsubscribe;
  }, [sendResumeRequest]);

  return {
    handleMessage,
    setMultiFileMode,
    negotiatedConfigRef,
  };
}
