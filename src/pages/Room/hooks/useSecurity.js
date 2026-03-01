/**
 * useSecurity Hook
 * Manages encrypted-signaling verification.
 *
 * With encrypted signaling the shared secret (URL fragment) is used to
 * encrypt/decrypt every SDP offer, answer, and ICE candidate.  If the
 * WebRTC data-channel opens successfully it proves both peers share the
 * secret — no additional TOFU challenge-response is needed.
 *
 * This hook still provides:
 *   - `tofuVerified` / `tofuVerifiedRef` (true once data-channel opens)
 *   - `verificationStatus` ('pending' → 'verified')
 *   - Identity handshake for session resumption + in-room reconnection
 *   - `isReturningPeer` — true when the reconnecting peer is the same UUID
 *   - `interruptedTransfer` — IndexedDB record for the room if peer is returning
 */
import { useState, useRef, useCallback } from 'react';
import { getLocalUUID, savePeerSession, verifyPeer } from '../../../utils/identityManager.js';
import { useRoomStore } from '../../../stores/roomStore.js';
import { listTransfers } from '../../../infrastructure/database/transfers.repository.js';
import logger from '../../../utils/logger.js';

/**
 * Hook for managing security verification
 * @param {string} roomId - Room identifier
 * @param {Function} sendJSON - Function to send JSON messages
 * @param {Function} addLog - Logging function
 * @returns {Object} Security state and methods
 */
export function useSecurity(roomId, sendJSON, addLog) {
  const { securityPayload } = useRoomStore();

  const [verificationStatus, setVerificationStatus] = useState('pending');
  const [identityVerified, setIdentityVerified] = useState(false);
  const [tofuVerified, setTofuVerified] = useState(false);
  const [isReturningPeer, setIsReturningPeer] = useState(false);
  const [interruptedTransfer, setInterruptedTransfer] = useState(null);

  const myUUID = useRef(getLocalUUID());
  const tofuVerifiedRef = useRef(false);

  // ── Data-channel open = verified ──────────────────────────────────────────

  /**
   * Mark the connection as verified.
   * Called by the parent when the data channel opens — if we got here the
   * encrypted signaling round-trip succeeded, proving both sides hold the
   * shared secret.
   */
  const markVerified = useCallback(() => {
    if (tofuVerifiedRef.current) return; // idempotent
    tofuVerifiedRef.current = true;
    setTofuVerified(true);
    setVerificationStatus('verified');
    addLog('Peer verified (encrypted signaling succeeded)', 'success');
  }, [addLog]);

  // ── Identity handshake (session resumption + reconnection) ────────────────

  /**
   * Send identity handshake to peer
   * @param {RTCDataChannel} channel - Data channel to send through
   */
  const sendHandshake = useCallback((channel) => {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'handshake', uuid: myUUID.current }));
      addLog('Sent identity handshake', 'info');
    }
  }, [addLog]);

  /**
   * Handle received identity handshake from peer.
   * If the peer is recognized (same UUID for this room), query IndexedDB
   * for an interrupted transfer. This enables in-room resume: instead of
   * resetting transfer state, the Room component can trigger the resume flow.
   * 
   * @param {Object} msg - Handshake message { type: 'handshake', uuid: string }
   */
  const handleHandshake = useCallback(async (msg) => {
    const peerUuidShort = msg.uuid?.slice(0, 8) || 'unknown';
    addLog(`Received identity: ${peerUuidShort}...`, 'info');

    let returning = false;
    let interrupted = null;

    try {
      const isKnownPeer = await verifyPeer(msg.uuid, roomId);
      if (isKnownPeer) {
        returning = true;
        addLog('Session resumed with known peer', 'success');

        // Query IndexedDB for interrupted/paused/active transfer in this room
        try {
          const allTransfers = await listTransfers();
          interrupted = allTransfers.find(
            (t) => t.roomId === roomId &&
              (t.status === 'interrupted' || t.status === 'paused' || t.status === 'active')
          ) || null;
          if (interrupted) {
            logger.log('[Security] Found interrupted transfer for room:', interrupted.transferId);
          }
        } catch (e) {
          logger.warn('[Security] Failed to query interrupted transfers:', e);
        }
      } else {
        addLog('New session established', 'info');
      }
      await savePeerSession(msg.uuid, roomId);
    } catch (err) {
      console.warn('[Security] Identity storage error:', err);
    }

    setIsReturningPeer(returning);
    setInterruptedTransfer(interrupted);
    setIdentityVerified(true);
  }, [roomId, addLog]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const resetSecurityState = useCallback(() => {
    tofuVerifiedRef.current = false;
    setTofuVerified(false);
    setIdentityVerified(false);
    setIsReturningPeer(false);
    setInterruptedTransfer(null);
    setVerificationStatus('pending');
  }, []);

  return {
    // State
    verificationStatus,
    identityVerified,
    tofuVerified,
    tofuVerifiedRef,
    isReturningPeer,
    interruptedTransfer,

    // Identity
    myUUID,
    sendHandshake,
    handleHandshake,

    // Encrypted-signaling verification
    markVerified,
    resetSecurityState,
  };
}
