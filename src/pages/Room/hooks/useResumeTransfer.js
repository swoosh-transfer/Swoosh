/**
 * useResumeTransfer Hook
 * 
 * Encapsulates the resume handshake coordination when entering a room
 * with resume context from the Home page.
 * 
 * Responsibilities:
 * - Load resume context from roomStore on mount
 * - Initiate resume handshake when peer connects
 *   - Sender: send RESUME_TRANSFER proposal with saved bitmap
 *   - Receiver: wait for RESUME_TRANSFER from sender, validate, respond
 * - Handle RESUME_ACCEPTED / RESUME_REJECTED callbacks
 * - Fall back to fresh transfer if resume fails
 * - Clear resume context after handshake completes
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { useRoomStore } from '../../../stores/roomStore.js';
import logger from '../../../utils/logger.js';

/**
 * @param {Object} params
 * @param {boolean} params.dataChannelReady - Whether the data channel is open
 * @param {Function} params.sendResumeRequest - From useMessages — sends RESUME_TRANSFER
 * @param {Function} params.addLog - UI log helper
 * @returns {Object} Resume transfer state and handlers
 */
export function useResumeTransfer({
  dataChannelReady,
  sendResumeRequest,
  addLog,
}) {
  const { resumeContext, clearResumeContext } = useRoomStore();
  const hasInitiatedRef = useRef(false);
  const [resumeState, setResumeState] = useState('idle'); // idle | proposing | accepted | rejected | failed
  const [resumeInfo, setResumeInfo] = useState(null); // { startFromChunk, ... }

  /**
   * Initiate resume handshake when data channel opens and we have resume context.
   */
  useEffect(() => {
    if (!dataChannelReady || !resumeContext || hasInitiatedRef.current) return;
    if (!sendResumeRequest) return;

    hasInitiatedRef.current = true;

    if (resumeContext.direction === 'sending') {
      // Sender side: propose resume with saved bitmap
      setResumeState('proposing');
      addLog('Proposing transfer resume to peer...', 'info');
      sendResumeRequest({
        transferId: resumeContext.transferId,
        fileName: resumeContext.fileName,
        fileSize: resumeContext.fileSize,
        fileHash: resumeContext.fileHash,
        totalChunks: resumeContext.totalChunks,
        chunkBitmap: resumeContext.chunkBitmap,
      });
    } else if (resumeContext.direction === 'receiving') {
      // Receiver side: propose resume (receiver proposes, sender validates)
      setResumeState('proposing');
      addLog('Requesting transfer resume from peer...', 'info');
      sendResumeRequest({
        transferId: resumeContext.transferId,
        fileName: resumeContext.fileName,
        fileSize: resumeContext.fileSize,
        fileHash: resumeContext.fileHash,
        totalChunks: resumeContext.totalChunks,
        chunkBitmap: resumeContext.chunkBitmap,
      });
    }
  }, [dataChannelReady, resumeContext, sendResumeRequest, addLog]);

  /**
   * Callback when resume is accepted by the peer.
   * Called from useMessages RESUME_ACCEPTED handler.
   */
  const onResumeAccepted = useCallback(({ transferId, startFromChunk, totalChunks }) => {
    logger.log(`[ResumeTransfer] Resume accepted — start from chunk ${startFromChunk}`);
    setResumeState('accepted');
    setResumeInfo({ transferId, startFromChunk, totalChunks });
    addLog(`Resume accepted! Continuing from chunk ${startFromChunk}/${totalChunks}`, 'success');
  }, [addLog]);

  /**
   * Callback when resume is rejected by the peer.
   * Called from useMessages RESUME_REJECTED handler.
   */
  const onResumeRejected = useCallback(({ transferId, reason }) => {
    logger.log(`[ResumeTransfer] Resume rejected: ${reason}`);
    setResumeState('rejected');
    addLog(`Resume rejected: ${reason}. Starting fresh transfer instead.`, 'warning');
    // Clear resume context so room falls back to normal flow
    clearResumeContext();
  }, [addLog, clearResumeContext]);

  /**
   * Clear resume state after the transfer completes or is abandoned.
   */
  const clearResume = useCallback(() => {
    setResumeState('idle');
    setResumeInfo(null);
    hasInitiatedRef.current = false;
    clearResumeContext();
  }, [clearResumeContext]);

  return {
    resumeContext,
    resumeState,
    resumeInfo,
    isResuming: resumeState === 'proposing' || resumeState === 'accepted',
    onResumeAccepted,
    onResumeRejected,
    clearResume,
  };
}
