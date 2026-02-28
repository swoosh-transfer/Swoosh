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
 *   - Optional identity handshake for session resumption
 */
import { useState, useRef, useCallback } from 'react';
import { getLocalUUID, savePeerSession, verifyPeer } from '../../../utils/identityManager.js';
import { useRoomStore } from '../../../stores/roomStore.js';

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

  // ── Optional identity handshake (session resumption) ──────────────────────

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
   * Handle received identity handshake from peer
   * @param {Object} msg - Handshake message
   */
  const handleHandshake = useCallback(async (msg) => {
    const peerUuidShort = msg.uuid?.slice(0, 8) || 'unknown';
    addLog(`Received identity: ${peerUuidShort}...`, 'info');

    try {
      const isKnownPeer = await verifyPeer(msg.uuid, roomId);
      if (isKnownPeer) {
        addLog('Session resumed with known peer', 'success');
      } else {
        addLog('New session established', 'info');
      }
      await savePeerSession(msg.uuid, roomId);
    } catch (err) {
      console.warn('[Security] Identity storage error:', err);
    }

    setIdentityVerified(true);
  }, [roomId, addLog]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const resetSecurityState = useCallback(() => {
    tofuVerifiedRef.current = false;
    setTofuVerified(false);
    setIdentityVerified(false);
    setVerificationStatus('pending');
  }, []);

  return {
    // State
    verificationStatus,
    identityVerified,
    tofuVerified,
    tofuVerifiedRef,

    // Identity
    myUUID,
    sendHandshake,
    handleHandshake,

    // Encrypted-signaling verification
    markVerified,
    resetSecurityState,
  };
}
