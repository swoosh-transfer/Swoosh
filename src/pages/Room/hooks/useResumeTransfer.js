/**
 * useResumeTransfer Hook
 * 
 * Encapsulates the resume handshake coordination.
 * 
 * Supports two entry points:
 *   1. Cross-session resume: user clicks "Resume" on Home → new room created
 *      with resumeContext → this hook sends RESUME_TRANSFER when data channel opens.
 *   2. In-room resume: peer reconnects in the same room → Room component sets
 *      resumeContext with `inRoom: true` after identity verification → this hook
 *      sends RESUME_TRANSFER over the new data channel.
 * 
 * Responsibilities:
 * - Load resume context from roomStore on mount / when set
 * - Initiate resume handshake when peer connects
 *   - Send RESUME_TRANSFER proposal with saved bitmap
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
  const timeoutRefRef = useRef(null);
  const [resumeState, setResumeState] = useState('idle'); // idle | proposing | accepted | rejected | failed | timeout
  const [resumeInfo, setResumeInfo] = useState(null); // { startFromChunk, ... }

  /**
   * Reset initiation guard when resumeContext changes
   * (allows re-firing for in-room reconnection where context is set after mount)
   */
  useEffect(() => {
    if (resumeContext) {
      hasInitiatedRef.current = false;
    }
  }, [resumeContext]);

  /**
   * 5-second timeout for resume handshake proposal.
   * If peer doesn't respond (RESUME_ACCEPTED or RESUME_REJECTED) within 5 seconds,
   * auto-reject and start fresh transfer instead.
   */
  useEffect(() => {
    if (resumeState !== 'proposing') return;

    // Set 5-second timeout
    timeoutRefRef.current = setTimeout(() => {
      logger.warn('[ResumeTransfer] Resume handshake timeout (5s) — falling back to fresh transfer');
      setResumeState('timeout');
      addLog('Resume timeout. Starting fresh transfer instead...', 'warning');
      // Clear resume context to trigger fresh start flow
      clearResumeContext();
    }, 5000);

    return () => {
      if (timeoutRefRef.current) {
        clearTimeout(timeoutRefRef.current);
        timeoutRefRef.current = null;
      }
    };
  }, [resumeState, addLog, clearResumeContext]);

  /**
   * Initiate resume handshake when data channel opens and we have resume context.
   * Works for both cross-session (Home→Room) and in-room reconnection.
   */
  useEffect(() => {
    if (!dataChannelReady || !resumeContext || hasInitiatedRef.current) return;
    if (!sendResumeRequest) return;

    hasInitiatedRef.current = true;

    const label = resumeContext.inRoom ? 'In-room' : 'Cross-session';

    if (resumeContext.direction === 'sending') {
      // Sender side: propose resume with saved bitmap
      setResumeState('proposing');
      addLog(`${label} resume: proposing to peer...`, 'info');
      sendResumeRequest({
        transferId: resumeContext.transferId,
        fileName: resumeContext.fileName,
        fileSize: resumeContext.fileSize,
        fileHash: resumeContext.fileHash,
        totalChunks: resumeContext.totalChunks,
        chunkBitmap: resumeContext.chunkBitmap,
        inRoom: !!resumeContext.inRoom,
      });
    } else if (resumeContext.direction === 'receiving') {
      // Receiver side: propose resume (receiver proposes, sender validates)
      setResumeState('proposing');
      addLog(`${label} resume: requesting from peer...`, 'info');
      sendResumeRequest({
        transferId: resumeContext.transferId,
        fileName: resumeContext.fileName,
        fileSize: resumeContext.fileSize,
        fileHash: resumeContext.fileHash,
        totalChunks: resumeContext.totalChunks,
        chunkBitmap: resumeContext.chunkBitmap,
        inRoom: !!resumeContext.inRoom,
      });
    }
  }, [dataChannelReady, resumeContext, sendResumeRequest, addLog]);

  /**
   * Callback when resume is accepted by the peer.
   * Called from useMessages RESUME_ACCEPTED handler.
   */
  const onResumeAccepted = useCallback(({ transferId, startFromChunk, totalChunks }) => {
    logger.log(`[ResumeTransfer] Resume accepted — start from chunk ${startFromChunk}`);
    // Clear timeout since we got a response
    if (timeoutRefRef.current) {
      clearTimeout(timeoutRefRef.current);
      timeoutRefRef.current = null;
    }
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
    // Clear timeout since we got a response
    if (timeoutRefRef.current) {
      clearTimeout(timeoutRefRef.current);
      timeoutRefRef.current = null;
    }
    setResumeState('rejected');
    addLog(`Resume rejected: ${reason}. Starting fresh transfer instead.`, 'warning');
    // Clear resume context so room falls back to normal flow (triggers fresh start)
    clearResumeContext();
  }, [addLog, clearResumeContext]);

  /**
   * Clear resume state after the transfer completes or is abandoned.
   */
  const clearResume = useCallback(() => {
    if (timeoutRefRef.current) {
      clearTimeout(timeoutRefRef.current);
      timeoutRefRef.current = null;
    }
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
