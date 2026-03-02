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
 *   - Emit resume request event (consumed by useMessages)
 * - Handle RESUME_ACCEPTED / RESUME_REJECTED events from useMessages
 * - Fall back to fresh transfer if resume fails
 * - Clear resume context after handshake completes
 * 
 * Uses event bus pattern to eliminate circular dependency with useMessages.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { useRoomStore } from '../../../stores/roomStore.js';
import logger from '../../../utils/logger.js';
import { resumeEventBus } from './resumeEventBus.js';

/**
 * @param {Object} params
 * @param {boolean} params.dataChannelReady - Whether the data channel is open
 * @param {Function} params.addLog - UI log helper
 * @returns {Object} Resume transfer state and handlers
 */
export function useResumeTransfer({
  dataChannelReady,
  addLog,
}) {
  const RESUME_TIMEOUT_MS = 15000;
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
   * Timeout for resume handshake proposal.
   * If peer doesn't respond (RESUME_ACCEPTED or RESUME_REJECTED) in time,
   * auto-reject and start fresh transfer instead.
   */
  useEffect(() => {
    if (resumeState !== 'proposing') return;

    // Set resume timeout
    timeoutRefRef.current = setTimeout(() => {
      logger.warn(`[ResumeTransfer] Resume handshake timeout (${RESUME_TIMEOUT_MS}ms) — falling back to fresh transfer`);
      setResumeState('timeout');
      addLog('Resume negotiation timed out. Starting a fresh transfer instead...', 'warning');
      // Clear resume context to trigger fresh start flow
      clearResumeContext();
    }, RESUME_TIMEOUT_MS);

    return () => {
      if (timeoutRefRef.current) {
        clearTimeout(timeoutRefRef.current);
        timeoutRefRef.current = null;
      }
    };
  }, [resumeState, addLog, clearResumeContext, RESUME_TIMEOUT_MS]);

  /**
   * Initiate resume handshake when data channel opens and we have resume context.
   * Works for both cross-session (Home→Room) and in-room reconnection.
   * Emits 'resumeRequest' event consumed by useMessages.
   */
  useEffect(() => {
    if (!dataChannelReady || !resumeContext || hasInitiatedRef.current) return;

    hasInitiatedRef.current = true;

    const label = resumeContext.inRoom ? 'In-room' : 'Cross-session';

    if (resumeContext.direction === 'sending' || resumeContext.direction === 'receiving') {
      setResumeState('proposing');
      const action = resumeContext.direction === 'sending' ? 'proposing to peer' : 'requesting from peer';
      addLog(`${label} resume: ${action}...`, 'info');
      
      // Emit resume request event (consumed by useMessages)
      resumeEventBus.emit('resumeRequest', {
        transferId: resumeContext.transferId,
        fileName: resumeContext.fileName,
        fileSize: resumeContext.fileSize,
        fileHash: resumeContext.fileHash,
        totalChunks: resumeContext.totalChunks,
        chunkBitmap: resumeContext.chunkBitmap,
        inRoom: !!resumeContext.inRoom,
      });
    }
  }, [dataChannelReady, resumeContext, addLog]);

  /**
   * Subscribe to resume response events from useMessages.
   * Handles both RESUME_ACCEPTED and RESUME_REJECTED.
   */
  useEffect(() => {
    const unsubAccepted = resumeEventBus.on('resumeAccepted', ({ transferId, startFromChunk, totalChunks }) => {
      logger.log(`[ResumeTransfer] Resume accepted — start from chunk ${startFromChunk}`);
      // Clear timeout since we got a response
      if (timeoutRefRef.current) {
        clearTimeout(timeoutRefRef.current);
        timeoutRefRef.current = null;
      }
      setResumeState('accepted');
      setResumeInfo({ transferId, startFromChunk, totalChunks });
      addLog(`Resume accepted! Continuing from chunk ${startFromChunk}/${totalChunks}`, 'success');
    });

    const unsubRejected = resumeEventBus.on('resumeRejected', ({ transferId, reason }) => {
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
    });

    return () => {
      unsubAccepted();
      unsubRejected();
    };
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
    clearResume,
  };
}
