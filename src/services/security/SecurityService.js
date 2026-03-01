/**
 * Security Service
 *
 * Manages encrypted-signaling peer verification.
 *
 * Security flow (encrypted signaling):
 * 1. Host creates security credentials (secret + peer ID)
 * 2. Host shares secure URL with guest (secret in URL fragment — never sent to server)
 * 3. Guest extracts credentials from URL and derives AES-GCM key
 * 4. Both peers encrypt/decrypt all signaling messages (SDP + ICE) with the key
 * 5. If data channel opens → both peers provably hold the secret → verified
 *
 * @example
 * const securityService = new SecurityService();
 *
 * // Host side
 * const credentials = await securityService.createCredentials();
 * const secureUrl = securityService.createSecureURL(baseUrl, roomId);
 *
 * // Guest side
 * const extracted = securityService.extractFromURL(window.location.href);
 * // Key derivation + signaling encryption happen at the signaling layer
 */

import {
  generateSharedSecret,
  generatePeerID,
  createSecurityURL,
  extractSecurityFromURL,
  deriveEncryptionKey,
} from '../../utils/tofuSecurity.js';
import logger from '../../utils/logger.js';
import { SecurityError } from '../../lib/errors.js';

/**
 * Verification states
 */
export const VerificationState = {
  UNVERIFIED: 'unverified',
  VERIFIED: 'verified',
  FAILED: 'failed',
  EXPIRED: 'expired'
};

/**
 * Trust levels
 */
export const TrustLevel = {
  NONE: 'none',
  VERIFIED: 'verified',
  EXPIRED: 'expired'
};

/**
 * Security Service
 * Orchestrates encrypted-signaling security workflow
 */
export class SecurityService {
  constructor() {
    this.credentials = null;        // { secret, peerID }
    this.encryptionKey = null;      // AES-GCM CryptoKey
    this.verificationState = VerificationState.UNVERIFIED;
    this.peerInfo = null;
    this.lastVerification = null;

    this.eventListeners = new Map();
    this.verificationMaxAge = 5 * 60 * 1000; // 5 minutes
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event).add(callback);
    return () => this.eventListeners.get(event)?.delete(callback);
  }

  /** @private */
  _emit(event, ...args) {
    this.eventListeners.get(event)?.forEach(cb => {
      try { cb(...args); } catch (err) {
        logger.error(`[SecurityService] Event handler error (${event}):`, err);
      }
    });
  }

  // ── Credentials ─────────────────────────────────────────────────────────────

  /**
   * Create new security credentials (host side)
   * @returns {Promise<{secret: string, peerID: string}>}
   */
  async createCredentials() {
    try {
      const secret = await generateSharedSecret();
      const peerID = await generatePeerID();
      this.credentials = { secret, peerID };

      // Pre-derive encryption key
      this.encryptionKey = await deriveEncryptionKey(secret);

      logger.log('[SecurityService] Created credentials + encryption key');
      return { secret, peerID };
    } catch (err) {
      logger.error('[SecurityService] Failed to create credentials:', err);
      throw new SecurityError('Failed to create security credentials', { cause: err });
    }
  }

  /**
   * Create secure URL with embedded credentials
   */
  createSecureURL(baseURL, roomId, metadata = {}) {
    if (!this.credentials) {
      throw new SecurityError('No credentials. Call createCredentials() first.');
    }
    const { secret, peerID } = this.credentials;
    return createSecurityURL(baseURL, secret, peerID, { ...metadata, roomId });
  }

  /**
   * Extract security credentials from URL (guest side)
   * @param {string} url
   * @returns {Object|null}
   */
  extractFromURL(url) {
    try {
      const extracted = extractSecurityFromURL(url);
      if (!extracted) throw new SecurityError('No security information found in URL');

      const age = Date.now() - extracted.timestamp;
      if (age > 60 * 60 * 1000) {
        throw new SecurityError('Security credentials expired', { age });
      }

      this.credentials = { secret: extracted.secret, peerID: extracted.peerID };
      logger.log('[SecurityService] Extracted credentials from URL');
      return extracted;
    } catch (err) {
      logger.error('[SecurityService] Failed to extract from URL:', err);
      if (err instanceof SecurityError) throw err;
      throw new SecurityError('Invalid security URL', { cause: err });
    }
  }

  // ── Verification ────────────────────────────────────────────────────────────

  /**
   * Mark as verified — called when data channel opens (encrypted signaling
   * round-trip succeeded, proving both peers hold the secret).
   */
  markVerified() {
    this.lastVerification = Date.now();
    this.peerInfo = { peerID: this.credentials?.peerID, verifiedAt: this.lastVerification };
    this._setState(VerificationState.VERIFIED);
    this._emit('verified', this.peerInfo);
    logger.log('[SecurityService] Peer verified (encrypted signaling)');
  }

  getPeerStatus() {
    return {
      state: this.verificationState,
      verified: this._isValid(),
      trustLevel: this._getTrustLevel(),
      peerID: this.credentials?.peerID || null,
      verifiedAt: this.lastVerification,
      expiresAt: this.lastVerification ? this.lastVerification + this.verificationMaxAge : null,
    };
  }

  getTrustLevel() { return this._getTrustLevel(); }
  isVerified() { return this._isValid(); }

  /**
   * Get the derived encryption key (for bridging to signaling layer)
   * @returns {CryptoKey|null}
   */
  getEncryptionKey() { return this.encryptionKey; }

  invalidate() {
    this.verificationState = VerificationState.UNVERIFIED;
    this.lastVerification = null;
    this.peerInfo = null;
    this._emit('expired');
    logger.log('[SecurityService] Verification invalidated');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** @private */
  _isValid() {
    if (this.verificationState !== VerificationState.VERIFIED) return false;
    if (!this.lastVerification) return false;
    if (Date.now() - this.lastVerification > this.verificationMaxAge) {
      this._setState(VerificationState.EXPIRED);
      this._emit('expired');
      return false;
    }
    return true;
  }

  /** @private */
  _getTrustLevel() {
    if (this._isValid()) return TrustLevel.VERIFIED;
    if (this.verificationState === VerificationState.EXPIRED) return TrustLevel.EXPIRED;
    return TrustLevel.NONE;
  }

  /** @private */
  _setState(newState) {
    if (this.verificationState !== newState) {
      const old = this.verificationState;
      this.verificationState = newState;
      logger.log(`[SecurityService] State: ${old} → ${newState}`);
      this._emit('stateChange', newState, old);
    }
  }

  destroy() {
    this.credentials = null;
    this.encryptionKey = null;
    this.peerInfo = null;
    this.lastVerification = null;
    this.eventListeners.clear();
    logger.log('[SecurityService] Destroyed');
  }
}
