/**
 * Security Service
 * 
 * Manages TOFU (Trust On First Use) peer verification and authentication.
 * Provides high-level API for secure P2P connection establishment.
 * 
 * TOFU Security Flow:
 * 1. Host creates security credentials (secret + peer ID)
 * 2. Host shares secure URL with guest (contains encrypted credentials)
 * 3. Guest extracts credentials from URL
 * 4. Both peers perform mutual challenge-response verification
 * 5. Connection is verified and trusted
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
 * await securityService.verifyPeer(extracted.secret, extracted.peerID);
 */

import {
  generateSharedSecret,
  generatePeerID,
  createSecurityURL,
  extractSecurityFromURL,
  SecuritySession,
  initiatePeerVerification,
  generateChallenge,
  signChallenge,
  verifyChallenge,
  deriveHMACKey
} from '../../utils/tofuSecurity.js';
import logger from '../../utils/logger.js';
import { SecurityError } from '../../lib/errors.js';

/**
 * Verification states
 */
export const VerificationState = {
  UNVERIFIED: 'unverified',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  FAILED: 'failed',
  EXPIRED: 'expired'
};

/**
 * Trust levels
 */
export const TrustLevel = {
  NONE: 'none',           // No verification attempted
  PENDING: 'pending',     // Verification in progress
  VERIFIED: 'verified',   // Successfully verified
  EXPIRED: 'expired'      // Verification expired
};

/**
 * Security Service
 * Orchestrates TOFU security verification workflow
 */
export class SecurityService {
  constructor() {
    this.credentials = null;        // { secret, peerID }
    this.session = null;            // SecuritySession instance
    this.verificationState = VerificationState.UNVERIFIED;
    this.peerInfo = null;          // Information about verified peer
    this.lastVerification = null;  // Timestamp of last successful verification
    
    // Event listeners
    this.eventListeners = new Map();
    
    // Verification timeout (5 minutes)
    this.verificationMaxAge = 5 * 60 * 1000;
  }

  /**
   * Subscribe to security events
   * 
   * Events:
   * - 'stateChange': (state) => {}
   * - 'verified': (peerInfo) => {}
   * - 'verificationFailed': (error) => {}
   * - 'expired': () => {}
   * 
   * @param {string} event - Event name
   * @param {Function} callback - Event handler
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    
    this.eventListeners.get(event).add(callback);
    
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(callback);
      }
    };
  }

  /**
   * Emit event to all subscribers
   * @private
   */
  _emit(event, ...args) {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    
    listeners.forEach(callback => {
      try {
        callback(...args);
      } catch (err) {
        logger.error(`[SecurityService] Event handler error (${event}):`, err);
      }
    });
  }

  /**
   * Create new security credentials (host side)
   * 
   * @returns {Promise<Object>} Credentials { secret, peerID }
   */
  async createCredentials() {
    try {
      const secret = await generateSharedSecret();
      const peerID = await generatePeerID();
      
      this.credentials = { secret, peerID };
      
      // Create security session
      this.session = new SecuritySession(secret, peerID);
      await this.session.initialize();
      
      logger.log('[SecurityService] Created credentials');
      
      return {
        secret,
        peerID
      };
      
    } catch (err) {
      logger.error('[SecurityService] Failed to create credentials:', err);
      throw new SecurityError('Failed to create security credentials', { cause: err });
    }
  }

  /**
   * Create secure URL with embedded credentials
   * 
   * @param {string} baseURL - Base application URL
   * @param {string} roomId - Room ID to join
   * @param {Object} metadata - Additional metadata (optional)
   * @returns {string} Secure URL with credentials in fragment
   */
  createSecureURL(baseURL, roomId, metadata = {}) {
    if (!this.credentials) {
      throw new SecurityError('No credentials available. Call createCredentials() first.');
    }
    
    const { secret, peerID } = this.credentials;
    const urlMetadata = {
      ...metadata,
      roomId
    };
    
    const secureUrl = createSecurityURL(baseURL, secret, peerID, urlMetadata);
    logger.log('[SecurityService] Created secure URL');
    
    return secureUrl;
  }

  /**
   * Extract security credentials from URL (guest side)
   * 
   * @param {string} url - URL containing security fragment
   * @returns {Object|null} Extracted credentials { secret, peerID, roomId, ... }
   */
  extractFromURL(url) {
    try {
      const extracted = extractSecurityFromURL(url);
      
      if (!extracted) {
        throw new SecurityError('No security information found in URL');
      }
      
      // Validate timestamp (reject if older than 1 hour)
      const age = Date.now() - extracted.timestamp;
      const maxAge = 60 * 60 * 1000; // 1 hour
      
      if (age > maxAge) {
        throw new SecurityError('Security credentials expired', { age, maxAge });
      }
      
      // Store credentials
      this.credentials = {
        secret: extracted.secret,
        peerID: extracted.peerID
      };
      
      logger.log('[SecurityService] Extracted credentials from URL');
      
      return extracted;
      
    } catch (err) {
      logger.error('[SecurityService] Failed to extract from URL:', err);
      if (err instanceof SecurityError) throw err;
      throw new SecurityError('Invalid security URL', { cause: err });
    }
  }

  /**
   * Verify peer using challenge-response protocol
   * 
   * @param {Function} sendChallenge - Function to send challenge to peer
   * @param {Function} receiveChallenge - Function to receive peer's challenge
   * @returns {Promise<Object>} Verification result
   */
  async verifyPeer(sendChallenge, receiveChallenge) {
    if (!this.credentials) {
      throw new SecurityError('No credentials available. Extract from URL or create credentials first.');
    }
    
    try {
      this._setState(VerificationState.VERIFYING);
      
      const { secret, peerID } = this.credentials;
      
      // Create session if not exists
      if (!this.session) {
        this.session = new SecuritySession(secret, peerID);
        await this.session.initialize();
      }
      
      // Initiate verification
      const verification = await initiatePeerVerification(secret, peerID);
      
      // Send our challenge to peer
      await sendChallenge({
        challenge: verification.challenge,
        peerID: peerID
      });
      
      // Receive peer's challenge
      const peerChallenge = await receiveChallenge();
      
      // Respond to peer's challenge
      const ourResponse = await verification.respondToChallenge();
      await sendChallenge({
        response: ourResponse,
        challenge: peerChallenge.challenge
      });
      
      // Verify peer's response to our challenge
      const isValid = await verification.verifyResponse(peerChallenge.response);
      
      if (isValid) {
        this.session.verified = true;
        this.session.lastVerification = Date.now();
        this.lastVerification = Date.now();
        this.peerInfo = {
          peerID: peerID,
          verifiedAt: Date.now()
        };
        
        this._setState(VerificationState.VERIFIED);
        this._emit('verified', this.peerInfo);
        
        logger.log('[SecurityService] Peer verified successfully');
        
        return {
          verified: true,
          peerID: peerID,
          timestamp: Date.now()
        };
      } else {
        this._setState(VerificationState.FAILED);
        this._emit('verificationFailed', new SecurityError('Challenge verification failed'));
        
        throw new SecurityError('Peer verification failed');
      }
      
    } catch (err) {
      this._setState(VerificationState.FAILED);
      logger.error('[SecurityService] Verification error:', err);
      
      if (err instanceof SecurityError) throw err;
      throw new SecurityError('Verification process failed', { cause: err });
    }
  }

  /**
   * Verify a single challenge-response (simplified API)
   * 
   * @param {string} challenge - Challenge from peer
   * @returns {Promise<string>} Signed response
   */
  async respondToChallenge(challenge) {
    if (!this.session || !this.session.hmacKey) {
      throw new SecurityError('Security session not initialized');
    }
    
    try {
      return await signChallenge(challenge, this.session.hmacKey);
    } catch (err) {
      throw new SecurityError('Failed to respond to challenge', { cause: err });
    }
  }

  /**
   * Verify a response to our challenge
   * 
   * @param {string} challenge - Our original challenge
   * @param {string} response - Peer's signed response
   * @returns {Promise<boolean>} True if valid
   */
  async verifyResponse(challenge, response) {
    if (!this.session || !this.session.hmacKey) {
      throw new SecurityError('Security session not initialized');
    }
    
    try {
      const isValid = await verifyChallenge(challenge, response, this.session.hmacKey);
      
      if (isValid && this.verificationState !== VerificationState.VERIFIED) {
        this._setState(VerificationState.VERIFIED);
        this.lastVerification = Date.now();
        this._emit('verified', { peerID: this.credentials.peerID });
      }
      
      return isValid;
    } catch (err) {
      throw new SecurityError('Failed to verify response', { cause: err });
    }
  }

  /**
   * Generate a new challenge for verification
   * 
   * @returns {string} Challenge string
   */
  generateChallenge() {
    return generateChallenge();
  }

  /**
   * Get current peer verification status
   * 
   * @returns {Object} Status information
   */
  getPeerStatus() {
    const isVerified = this._isVerificationValid();
    
    return {
      state: this.verificationState,
      verified: isVerified,
      trustLevel: this._getTrustLevel(),
      peerID: this.credentials?.peerID || null,
      verifiedAt: this.lastVerification,
      expiresAt: this.lastVerification ? this.lastVerification + this.verificationMaxAge : null
    };
  }

  /**
   * Get current trust level
   * 
   * @returns {string} Trust level
   */
  getTrustLevel() {
    return this._getTrustLevel();
  }

  /**
   * Check if verification is still valid (not expired)
   * 
   * @returns {boolean} True if valid
   */
  isVerified() {
    return this._isVerificationValid();
  }

  /**
   * Invalidate current verification (force re-verification)
   */
  invalidate() {
    this.verificationState = VerificationState.UNVERIFIED;
    this.lastVerification = null;
    this.peerInfo = null;
    
    if (this.session) {
      this.session.verified = false;
    }
    
    this._emit('expired');
    logger.log('[SecurityService] Verification invalidated');
  }

  /**
   * Check if verification is valid and not expired
   * @private
   */
  _isVerificationValid() {
    if (this.verificationState !== VerificationState.VERIFIED) {
      return false;
    }
    
    if (!this.lastVerification) {
      return false;
    }
    
    const age = Date.now() - this.lastVerification;
    if (age > this.verificationMaxAge) {
      this._setState(VerificationState.EXPIRED);
      this._emit('expired');
      return false;
    }
    
    return true;
  }

  /**
   * Get trust level based on verification state
   * @private
   */
  _getTrustLevel() {
    if (this._isVerificationValid()) {
      return TrustLevel.VERIFIED;
    }
    
    if (this.verificationState === VerificationState.VERIFYING) {
      return TrustLevel.PENDING;
    }
    
    if (this.verificationState === VerificationState.EXPIRED) {
      return TrustLevel.EXPIRED;
    }
    
    return TrustLevel.NONE;
  }

  /**
   * Update verification state
   * @private
   */
  _setState(newState) {
    if (this.verificationState !== newState) {
      const oldState = this.verificationState;
      this.verificationState = newState;
      logger.log(`[SecurityService] State: ${oldState} → ${newState}`);
      this._emit('stateChange', newState, oldState);
    }
  }

  /**
   * Destroy service and cleanup resources
   */
  destroy() {
    this.credentials = null;
    this.session = null;
    this.peerInfo = null;
    this.lastVerification = null;
    this.eventListeners.clear();
    logger.log('[SecurityService] Destroyed');
  }
}
