/**
 * useSecurity Hook
 * Manages TOFU (Trust On First Use) verification workflow
 * - Identity handshake
 * - Challenge/response protocol
 * - TOFU verification state
 * - Pending data queue (chunks received before verification)
 */
import { useState, useRef, useCallback } from 'react';
import {
  deriveHMACKey,
  generateChallenge,
  signChallenge,
  verifyChallenge
} from '../../../utils/tofuSecurity.js';
import { getLocalUUID, savePeerSession, verifyPeer } from '../../../utils/identityManager.js';
import { useRoomStore } from '../../../stores/roomStore.js';

/**
 * Hook for managing security and TOFU verification
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
  const challengeRef = useRef(null);
  const hmacKeyRef = useRef(null);
  const tofuStartedRef = useRef(false); // Prevent double TOFU verification
  const tofuVerifiedRef = useRef(false); // Track for message handler (avoids stale closure)
  
  // Queue for chunks received before TOFU verification
  const chunkMetaQueueRef = useRef([]);
  const pendingBinaryQueueRef = useRef([]);

  /**
   * Send identity handshake to peer
   * @param {RTCDataChannel} channel - Data channel to send through
   */
  const sendHandshake = useCallback((channel) => {
    if (channel.readyState === 'open') {
      const handshakeMsg = {
        type: 'handshake',
        uuid: myUUID.current
      };
      channel.send(JSON.stringify(handshakeMsg));
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
      // Verify against DB (scoped by Room)
      const isKnownPeer = await verifyPeer(msg.uuid, roomId);
      if (isKnownPeer) {
        addLog('Session resumed with known peer', 'success');
      } else {
        addLog('New session established', 'info');
      }
      // Save this session for next time
      await savePeerSession(msg.uuid, roomId);
    } catch (err) {
      // Continue anyway - identity storage is not critical
      console.warn('[Security] Identity storage error:', err);
    }
    
    setIdentityVerified(true);
    
    // Start TOFU after identity is verified
    setTimeout(() => {
      if (securityPayload?.secret && !tofuStartedRef.current) {
        startTOFUVerification();
      }
    }, 50);
  }, [roomId, securityPayload, addLog]);

  /**
   * Start TOFU verification process
   */
  const startTOFUVerification = useCallback(async () => {
    // Prevent double TOFU verification
    if (tofuStartedRef.current) {
      addLog('TOFU already started, skipping...', 'info');
      return;
    }
    if (!securityPayload?.secret) {
      addLog('No security payload, skipping TOFU', 'warning');
      return;
    }
    
    tofuStartedRef.current = true;
    setVerificationStatus('verifying');
    addLog('Starting TOFU verification...', 'info');

    try {
      const hmacKey = await deriveHMACKey(securityPayload.secret);
      hmacKeyRef.current = hmacKey;

      const challenge = generateChallenge();
      challengeRef.current = challenge;

      const signature = await signChallenge(challenge, hmacKey);

      sendJSON({
        type: 'tofu-challenge',
        challenge,
        signature,
        peerID: securityPayload.peerID,
      });

      addLog('Sent TOFU challenge', 'info');
    } catch (err) {
      tofuStartedRef.current = false; // Allow retry on error
      setVerificationStatus('failed');
      addLog(`TOFU failed: ${err.message}`, 'error');
    }
  }, [securityPayload, sendJSON, addLog]);

  /**
   * Handle received TOFU challenge
   * @param {Object} msg - Challenge message
   * @param {Function} onVerified - Callback when verification succeeds
   */
  const handleTOFUChallenge = useCallback(async (msg, onVerified) => {
    addLog('Received TOFU challenge', 'info');

    try {
      const hmacKey = await deriveHMACKey(securityPayload.secret);
      hmacKeyRef.current = hmacKey;

      const isValid = await verifyChallenge(msg.challenge, msg.signature, hmacKey);

      if (isValid) {
        addLog('Challenge valid', 'success');
        const response = await signChallenge(msg.challenge, hmacKey);
        sendJSON({ type: 'tofu-response', signature: response, challenge: msg.challenge });
        setTofuVerified(true);
        tofuVerifiedRef.current = true;
        setVerificationStatus('verified');
        
        // Notify parent that verification complete
        if (onVerified) onVerified();
      } else {
        setVerificationStatus('failed');
        addLog('Challenge invalid!', 'error');
      }
    } catch (err) {
      setVerificationStatus('failed');
      addLog(`Challenge error: ${err.message}`, 'error');
    }
  }, [securityPayload, sendJSON, setTofuVerified, addLog]);

  /**
   * Handle received TOFU response
   * @param {Object} msg - Response message
   * @param {Function} onVerified - Callback when verification succeeds
   */
  const handleTOFUResponse = useCallback(async (msg, onVerified) => {
    addLog('Received TOFU response', 'info');

    try {
      const isValid = await verifyChallenge(challengeRef.current, msg.signature, hmacKeyRef.current);

      if (isValid) {
        addLog('Peer verified!', 'success');
        sendJSON({ type: 'tofu-verified' });
        setTofuVerified(true);
        tofuVerifiedRef.current = true;
        setVerificationStatus('verified');
        
        // Notify parent that verification complete
        if (onVerified) onVerified();
      } else {
        setVerificationStatus('failed');
        addLog('Peer verification failed!', 'error');
      }
    } catch (err) {
      setVerificationStatus('failed');
      addLog(`TOFU response error: ${err.message}`, 'error');
    }
  }, [sendJSON, setTofuVerified, addLog]);

  /**
   * Handle received TOFU verified message
   * @param {Function} onVerified - Callback when verification succeeds
   */
  const handleTOFUVerified = useCallback((onVerified) => {
    setTofuVerified(true);
    tofuVerifiedRef.current = true;
    setVerificationStatus('verified');
    addLog('TOFU verified!', 'success');
    
    // Notify parent that verification complete
    if (onVerified) onVerified();
  }, [setTofuVerified, addLog]);

  /**
   * Reset security state for reconnection
   */
  const resetSecurityState = useCallback(() => {
    tofuStartedRef.current = false;
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
    tofuVerifiedRef, // Ref for message handler (avoids stale closure)
    
    // Identity
    myUUID,
    sendHandshake,
    handleHandshake,
    
    // TOFU verification
    startTOFUVerification,
    handleTOFUChallenge,
    handleTOFUResponse,
    handleTOFUVerified,
    resetSecurityState,
    
    // Queues for data received before verification
    chunkMetaQueueRef,
    pendingBinaryQueueRef,
  };
}
