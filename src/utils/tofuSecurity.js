/**
 * Signaling Security Implementation
 * Provides:
 *   - Shared secret generation and URL-fragment embedding
 *   - AES-GCM-256 encryption/decryption for signaling messages (SDP, ICE)
 *
 * The shared secret in the URL fragment is used to derive an AES-GCM key.
 * All signaling traffic (offer, answer, ICE candidates) is encrypted before
 * passing through the signaling server. If the WebRTC data channel establishes
 * successfully, both peers provably hold the same secret — no separate TOFU
 * challenge-response is needed.
 */

import logger from './logger.js';

/**
 * Generate a cryptographically secure 8-byte random secret (11 chars when base64 encoded)
 * @returns {Promise<string>} Base64-encoded secret
 */
export async function generateSharedSecret() {
  const secretBytes = new Uint8Array(8);
  crypto.getRandomValues(secretBytes);
  
  // Convert to base64 for safe transmission
  return btoa(String.fromCharCode(...secretBytes));
}

/**
 * Generate a unique peer ID (6-byte = 8 chars when base64 encoded)
 * @returns {Promise<string>} Base64-encoded peer ID
 */
export async function generatePeerID() {
  const idBytes = new Uint8Array(6);
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

// ── AES-GCM Signaling Encryption ──────────────────────────────────────────────

/**
 * Derive an AES-GCM-256 encryption key from the shared secret using PBKDF2.
 * Uses a dedicated salt ("signaling-encryption") so the key is distinct from
 * any other derivation of the same secret.
 *
 * @param {string} sharedSecret - Base64-encoded shared secret
 * @returns {Promise<CryptoKey>} AES-GCM CryptoKey
 */
export async function deriveEncryptionKey(sharedSecret) {
  const secretBytes = new Uint8Array(
    atob(sharedSecret).split('').map(c => c.charCodeAt(0))
  );

  const baseKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const salt = new TextEncoder().encode('signaling-encryption');

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a signaling payload (object) with AES-GCM.
 * Returns a JSON-safe envelope { iv, ciphertext } with base64-encoded fields.
 *
 * @param {Object} plainObject - The signaling data to encrypt (offer / answer / candidate)
 * @param {CryptoKey} aesKey   - AES-GCM key from deriveEncryptionKey()
 * @returns {Promise<{iv: string, ciphertext: string}>}
 */
export async function encryptSignaling(plainObject, aesKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const plainBytes = new TextEncoder().encode(JSON.stringify(plainObject));

  const cipherBytes = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plainBytes
  );

  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBytes))),
  };
}

/**
 * Decrypt a signaling envelope back to the original object.
 * Throws if the key is wrong or the ciphertext has been tampered with
 * (AES-GCM provides authentication).
 *
 * @param {{iv: string, ciphertext: string}} envelope - Encrypted envelope
 * @param {CryptoKey} aesKey - AES-GCM key from deriveEncryptionKey()
 * @returns {Promise<Object>} Decrypted signaling data
 */
export async function decryptSignaling(envelope, aesKey) {
  const iv = new Uint8Array(
    atob(envelope.iv).split('').map(c => c.charCodeAt(0))
  );
  const cipherBytes = new Uint8Array(
    atob(envelope.ciphertext).split('').map(c => c.charCodeAt(0))
  );

  const plainBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    cipherBytes
  );

  return JSON.parse(new TextDecoder().decode(plainBytes));
}

// ── Setup Helper ──────────────────────────────────────────────────────────────

/**
 * Create a complete security setup (secret, peerID, URL helpers).
 * @returns {Promise<Object>} { secret, peerID, createURL(baseURL, metadata) }
 */
export async function createSecuritySetup() {
  const secret = await generateSharedSecret();
  const peerID = await generatePeerID();

  return {
    secret,
    peerID,
    createURL(baseURL, metadata = {}) {
      return createSecurityURL(baseURL, secret, peerID, metadata);
    },
  };
}

// Backward-compatible alias
export const createTOFUSetup = createSecuritySetup;