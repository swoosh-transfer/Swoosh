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
import { useState, useRef, useCallback, useEffect } from 'react';
import { getLocalUUID, restoreUuidIfExists, savePeerSession, verifyPeer } from '../../../utils/identityManager.js';
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
  const [uuidInitialized, setUuidInitialized] = useState(false);

  const myUUID = useRef(null);
  const tofuVerifiedRef = useRef(false);
  const pendingHandshakeChannelRef = useRef(null);
  const hasSentHandshakeRef = useRef(false);
  
  // Session-specific token for resume replay protection
  const sessionToken = useRef(null);
  const peerSessionToken = useRef(null);

  // Initialize room-scoped UUID synchronously, then restore from IndexedDB in background
  useEffect(() => {
    let mounted = true;
    hasSentHandshakeRef.current = false;

    try {
      const uuid = getLocalUUID(roomId);
      if (mounted) {
        myUUID.current = uuid;
        setUuidInitialized(true);
        logger.log(`[Security] UUID initialized: ${uuid.slice(0, 8)}...`);
      }
    } catch (err) {
      logger.error('[Security] Failed to initialize UUID:', err);
    }

    restoreUuidIfExists(roomId, myUUID.current)
      .then((restoredUuid) => {
        if (mounted && restoredUuid) {
          myUUID.current = restoredUuid;
        }
      })
      .catch((err) => {
        logger.warn('[Security] Background UUID restore failed:', err);
      });
    
    return () => {
      mounted = false;
      pendingHandshakeChannelRef.current = null;
    };
  }, [roomId]);

  useEffect(() => {
    if (!uuidInitialized || !myUUID.current || hasSentHandshakeRef.current || !sessionToken.current) {
      return;
    }

    const channel = pendingHandshakeChannelRef.current;
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify({ 
        type: 'handshake', 
        uuid: myUUID.current,
        sessionToken: sessionToken.current,
      }));
      hasSentHandshakeRef.current = true;
      addLog('Sent identity handshake', 'info');
      pendingHandshakeChannelRef.current = null;
    }
  }, [addLog, uuidInitialized]);

  // ── Data-channel open = verified ──────────────────────────────────────────

  /**
   * Mark the connection as verified.
   * Called by the parent when the data channel opens — if we got here the
   * encrypted signaling round-trip succeeded, proving both sides hold the
   * shared secret.
   * Also generates a fresh session token for resume replay protection.
   */
  const markVerified = useCallback(() => {
    if (tofuVerifiedRef.current) return; // idempotent
    
    // Generate fresh session token (cryptographic random)
    const tokenArray = new Uint8Array(16);
    crypto.getRandomValues(tokenArray);
    sessionToken.current = Array.from(tokenArray, b => b.toString(16).padStart(2, '0')).join('');
    
    tofuVerifiedRef.current = true;
    setTofuVerified(true);
    setVerificationStatus('verified');
    addLog('Peer verified (encrypted signaling succeeded)', 'success');
    logger.log(`[Security] Session token generated: ${sessionToken.current.slice(0, 16)}...`);
  }, [addLog]);

  // ── Identity handshake (session resumption + reconnection) ────────────────

  /**
   * Send identity handshake to peer
   * Includes UUID and session token for resume replay protection.
   * @param {RTCDataChannel} channel - Data channel to send through
   */
  const sendHandshake = useCallback((channel) => {
    pendingHandshakeChannelRef.current = channel;

    if (!uuidInitialized || !myUUID.current) {
      logger.warn('[Security] Cannot send handshake - UUID not initialized yet');
      return;
    }
    
    if (channel.readyState === 'open' && !hasSentHandshakeRef.current && sessionToken.current) {
      channel.send(JSON.stringify({ 
        type: 'handshake', 
        uuid: myUUID.current,
        sessionToken: sessionToken.current,
      }));
      hasSentHandshakeRef.current = true;
      addLog('Sent identity handshake', 'info');
      pendingHandshakeChannelRef.current = null;
    }
  }, [addLog, uuidInitialized]);

  /**
   * Handle received identity handshake from peer.
   * Stores peer's session token for resume request validation.
   * If the peer is recognized (same UUID for this room), query IndexedDB
   * for an interrupted transfer. This enables in-room resume: instead of
   * resetting transfer state, the Room component can trigger the resume flow.
   * 
   * @param {Object} msg - Handshake message { type: 'handshake', uuid: string, sessionToken: string }
   */
  const handleHandshake = useCallback(async (msg) => {
    const peerUuidShort = msg.uuid?.slice(0, 8) || 'unknown';
    addLog(`Received identity: ${peerUuidShort}...`, 'info');
    
    // Store peer's session token for resume validation
    if (msg.sessionToken) {
      peerSessionToken.current = msg.sessionToken;
      logger.log(`[Security] Peer session token received: ${msg.sessionToken.slice(0, 16)}...`);
    }

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
          // Prefer sender-side transfers (actionable) over receiver-side
          interrupted = allTransfers.find(
            (t) => t.roomId === roomId &&
              t.direction === 'sending' &&
              (t.status === 'interrupted' || t.status === 'paused' || t.status === 'active')
          ) || allTransfers.find(
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
    hasSentHandshakeRef.current = false;
    pendingHandshakeChannelRef.current = null;
    sessionToken.current = null;
    peerSessionToken.current = null;
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
    uuidInitialized,

    // Identity
    myUUID,
    sendHandshake,
    handleHandshake,

    // Session tokens (for resume replay protection)
    sessionToken,
    peerSessionToken,

    // Encrypted-signaling verification
    markVerified,
    resetSecurityState,
  };
}
