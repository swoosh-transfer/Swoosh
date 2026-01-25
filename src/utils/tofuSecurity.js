/**
 * TOFU (Trust On First Use) Security Implementation
 * Provides cryptographically secure peer-to-peer authentication and verification
 */

import logger from './logger.js';

/**
 * Generate a cryptographically secure 32-byte random secret
 * @returns {Promise<string>} Base64-encoded secret
 */
export async function generateSharedSecret() {
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  
  // Convert to base64 for safe transmission
  return btoa(String.fromCharCode(...secretBytes));
}

/**
 * Generate a unique peer ID
 * @returns {Promise<string>} Base64-encoded peer ID
 */
export async function generatePeerID() {
  const idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  
  return btoa(String.fromCharCode(...idBytes));
}

/**
 * Create security payload for URL fragment transmission
 * @param {string} secret - Base64-encoded shared secret
 * @param {string} peerID - Base64-encoded peer ID
 * @param {Object} metadata - Additional metadata (optional)
 * @returns {string} Base64-encoded JSON payload
 */
export function createSecurityPayload(secret, peerID, metadata = {}) {
  const payload = {
    secret,
    peerID,
    timestamp: Date.now(),
    ...metadata
  };
  
  const jsonString = JSON.stringify(payload);
  return btoa(jsonString);
}

/**
 * Parse security payload from URL fragment
 * @param {string} encodedPayload - Base64-encoded JSON payload
 * @returns {Object|null} Parsed payload or null if invalid
 */
export function parseSecurityPayload(encodedPayload) {
  try {
    const jsonString = atob(encodedPayload);
    const payload = JSON.parse(jsonString);
    
    // Validate required fields
    if (!payload.secret || !payload.peerID || !payload.timestamp) {
      throw new Error('Invalid payload structure');
    }
    
    return payload;
  } catch (error) {
    logger.error('Failed to parse security payload:', error);
    return null;
  }
}

/**
 * Create a connection URL with security information in fragment
 * @param {string} baseURL - Base application URL
 * @param {string} secret - Shared secret
 * @param {string} peerID - Peer ID
 * @param {Object} metadata - Additional metadata
 * @returns {string} Complete URL with security fragment
 */
export function createSecurityURL(baseURL, secret, peerID, metadata = {}) {
  const payload = createSecurityPayload(secret, peerID, metadata);
  return `${baseURL}#${payload}`;
}

/**
 * Extract security information from URL fragment
 * @param {string} url - Full URL or just the fragment
 * @returns {Object|null} Security payload or null if not found
 */
export function extractSecurityFromURL(url) {
  try {
    // Extract fragment from URL
    let fragment;
    if (url.includes('#')) {
      fragment = url.split('#')[1];
    } else {
      fragment = url;
    }
    
    if (!fragment) {
      return null;
    }
    
    return parseSecurityPayload(fragment);
  } catch (error) {
    logger.error('Failed to extract security from URL:', error);
    return null;
  }
}

/**
 * Derive HMAC key from shared secret using PBKDF2
 * @param {string} sharedSecret - Base64-encoded shared secret
 * @param {string} salt - Salt for key derivation (optional)
 * @returns {Promise<CryptoKey>} Derived HMAC key
 */
export async function deriveHMACKey(sharedSecret, salt = 'p2p-verification') {
  // Convert base64 secret to ArrayBuffer
  const secretBytes = new Uint8Array(
    atob(sharedSecret).split('').map(char => char.charCodeAt(0))
  );
  
  // Import the secret as a key
  const baseKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  // Convert salt to ArrayBuffer
  const saltBytes = new TextEncoder().encode(salt);
  
  // Derive HMAC key
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign', 'verify']
  );
}

/**
 * Generate a random challenge for peer verification
 * @returns {string} Base64-encoded challenge
 */
export function generateChallenge() {
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  
  return btoa(String.fromCharCode(...challengeBytes));
}

/**
 * Sign a challenge using HMAC with the shared secret
 * @param {string} challenge - Base64-encoded challenge
 * @param {CryptoKey} hmacKey - HMAC key derived from shared secret
 * @returns {Promise<string>} Base64-encoded signature
 */
export async function signChallenge(challenge, hmacKey) {
  const challengeBytes = new TextEncoder().encode(challenge);
  const signatureBytes = await crypto.subtle.sign('HMAC', hmacKey, challengeBytes);
  
  return btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
}

/**
 * Verify a challenge signature
 * @param {string} challenge - Original challenge
 * @param {string} signature - Base64-encoded signature to verify
 * @param {CryptoKey} hmacKey - HMAC key for verification
 * @returns {Promise<boolean>} True if signature is valid
 */
export async function verifyChallenge(challenge, signature, hmacKey) {
  try {
    const challengeBytes = new TextEncoder().encode(challenge);
    const signatureBytes = new Uint8Array(
      atob(signature).split('').map(char => char.charCodeAt(0))
    );
    
    return await crypto.subtle.verify('HMAC', hmacKey, signatureBytes, challengeBytes);
  } catch (error) {
    logger.error('Challenge verification failed:', error);
    return false;
  }
}

/**
 * Complete peer verification flow
 * @param {string} sharedSecret - Shared secret between peers
 * @param {string} peerID - ID of the peer being verified
 * @returns {Promise<Object>} Verification session object
 */
export async function initiatePeerVerification(sharedSecret, peerID) {
  const hmacKey = await deriveHMACKey(sharedSecret);
  const challenge = generateChallenge();
  
  return {
    challenge,
    hmacKey,
    peerID,
    timestamp: Date.now(),
    
    // Method to sign the challenge (for responding peer)
    async respondToChallenge() {
      return await signChallenge(challenge, hmacKey);
    },
    
    // Method to verify a response (for challenging peer)
    async verifyResponse(signature) {
      return await verifyChallenge(challenge, signature, hmacKey);
    }
  };
}

/**
 * Security session manager for ongoing peer verification
 */
export class SecuritySession {
  constructor(sharedSecret, peerID) {
    this.sharedSecret = sharedSecret;
    this.peerID = peerID;
    this.hmacKey = null;
    this.verified = false;
    this.lastVerification = null;
  }
  
  async initialize() {
    this.hmacKey = await deriveHMACKey(this.sharedSecret);
  }
  
  async performMutualVerification(peerVerificationMethod) {
    if (!this.hmacKey) {
      await this.initialize();
    }
    
    try {
      // Generate our challenge
      const ourChallenge = generateChallenge();
      const ourSignature = await signChallenge(ourChallenge, this.hmacKey);
      
      // Send challenge and receive peer's challenge and signature
      const { peerChallenge, peerSignature, responseSignature } = await peerVerificationMethod({
        challenge: ourChallenge,
        signature: ourSignature,
        peerID: this.peerID
      });
      
      // Verify peer's signature of our challenge
      const peerValid = await verifyChallenge(ourChallenge, peerSignature, this.hmacKey);
      
      // Sign peer's challenge
      const ourResponse = await signChallenge(peerChallenge, this.hmacKey);
      
      // Send our response and get verification result
      const mutuallyVerified = peerValid && responseSignature && 
        await verifyChallenge(peerChallenge, responseSignature, this.hmacKey);
      
      this.verified = mutuallyVerified;
      this.lastVerification = Date.now();
      
      return {
        verified: mutuallyVerified,
        response: ourResponse
      };
      
    } catch (error) {
      logger.error('Mutual verification failed:', error);
      this.verified = false;
      return { verified: false, error: error.message };
    }
  }
  
  isVerified(maxAge = 300000) { // 5 minutes default
    return this.verified && 
           this.lastVerification && 
           (Date.now() - this.lastVerification) < maxAge;
  }
  
  async generateSecureToken() {
    if (!this.isVerified()) {
      throw new Error('Peer not verified');
    }
    
    const tokenData = {
      peerID: this.peerID,
      timestamp: Date.now(),
      nonce: generateChallenge()
    };
    
    const signature = await signChallenge(JSON.stringify(tokenData), this.hmacKey);
    
    return {
      ...tokenData,
      signature
    };
  }
  
  async verifySecureToken(token) {
    if (!this.hmacKey) {
      await this.initialize();
    }
    
    const { signature, ...tokenData } = token;
    return await verifyChallenge(JSON.stringify(tokenData), signature, this.hmacKey);
  }
}

/**
 * Utility function to create a complete TOFU security setup
 * @returns {Promise<Object>} Complete security setup
 */
export async function createTOFUSetup() {
  const secret = await generateSharedSecret();
  const peerID = await generatePeerID();
  
  return {
    secret,
    peerID,
    
    // Create shareable URL
    createURL(baseURL, metadata = {}) {
      return createSecurityURL(baseURL, secret, peerID, metadata);
    },
    
    // Create security session
    async createSession() {
      const session = new SecuritySession(secret, peerID);
      await session.initialize();
      return session;
    },
    
    // Initialize verification with another peer
    async initVerification() {
      return await initiatePeerVerification(secret, peerID);
    }
  };
}