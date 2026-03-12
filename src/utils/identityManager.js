/**
 * Identity Manager
 * Handles ephemeral identity (sessionStorage) and room-scoped session persistence (IndexedDB).
 * Uses the shared infrastructure database client to avoid version conflicts.
 */

import { getDatabase, STORE_NAMES } from '../infrastructure/database/client.js';
import logger from './logger.js';

const STORE_NAME = STORE_NAMES.SESSIONS;

/** Maximum session age before cleanup (24 hours) */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

// 1. Get Local UUID (Room-scoped, synchronous)
export function getLocalUUID(roomId) {
  if (!roomId) {
    throw new Error('[Identity] roomId is required for getLocalUUID');
  }

  // Check sessionStorage first (ephemeral cache for this tab)
  const sessionKey = `device_session_uuid_${roomId}`;
  let uuid = sessionStorage.getItem(sessionKey);
  
  if (uuid) {
    return uuid; // Already initialized in this tab for this room
  }

  // New user in this room for this tab - generate fresh UUID immediately
  uuid = crypto.randomUUID();
  sessionStorage.setItem(sessionKey, uuid);
  
  // Save to IndexedDB for future page refreshes (background)
  saveOwnSession(uuid, roomId).catch((err) => {
    logger.warn('[Identity] Failed to persist UUID in background:', err);
  });
  
  // Fresh tab detected: Clear stale sessions (older than 24h)
  clearStaleSessions(MAX_SESSION_AGE_MS).catch((err) => {
    logger.warn('[Identity] Failed to clear stale sessions:', err);
  });
  
  logger.log(`[Identity] Generated new UUID for room ${roomId.slice(0, 8)}...`);
  return uuid;
}

// 1b. Restore UUID from IndexedDB after sync initialization (background helper)
export async function restoreUuidIfExists(roomId, currentUuid) {
  if (!roomId) {
    return currentUuid || null;
  }

  try {
    const stored = await getOwnSession(roomId);
    if (stored && stored.ownUuid && stored.ownUuid !== currentUuid) {
      const sessionKey = `device_session_uuid_${roomId}`;
      sessionStorage.setItem(sessionKey, stored.ownUuid);
      logger.log(`[Identity] Restored UUID for room ${roomId.slice(0, 8)}... from IndexedDB`);
      return stored.ownUuid;
    }
  } catch (err) {
    logger.warn('[Identity] Failed to restore UUID from IndexedDB:', err);
  }

  return currentUuid || null;
}

// 2. Clear stale sessions (selective — only removes sessions older than maxAge)
async function clearStaleSessions(maxAgeMs = MAX_SESSION_AGE_MS) {
  try {
    const db = await getDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    const cutoff = Date.now() - maxAgeMs;
    let deletedCount = 0;

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const record = cursor.value;
        // Delete if no timestamp or older than cutoff
        if (!record.lastConnected || record.lastConnected < cutoff) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      if (deletedCount > 0) {
        logger.log(`[Identity] Cleaned ${deletedCount} stale session(s)`);
      }
    };
  } catch (e) {
    logger.error('[Identity] Error clearing stale sessions:', e);
    // Ignore error if store doesn't exist yet
  }
}

// 3. Save Our Own Session (for reconnection after page refresh)
export async function saveOwnSession(ownUuid, roomId) {
  if (!ownUuid || !roomId) {
    logger.warn('[Identity] Invalid ownUuid or roomId');
    return;
  }
  
  try {
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      
      // Use prefixed key to avoid collision with peer sessions
      const key = `own_${roomId}`;
      store.put({ 
        roomId: key,
        ownUuid: ownUuid, 
        lastConnected: Date.now() 
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    logger.error('[Identity] Failed to save own session:', err);
  }
}

// 4. Get Our Own Session (restore after page refresh)
export async function getOwnSession(roomId) {
  if (!roomId) {
    return null;
  }
  
  try {
    const db = await getDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      
      const key = `own_${roomId}`;
      const request = store.get(key);
      
      request.onsuccess = () => {
        const record = request.result;
        resolve(record || null);
      };
      request.onerror = () => resolve(null);
    });
  } catch (err) {
    logger.error('[Identity] Failed to get own session:', err);
    return null;
  }
}

// 5. Save Peer Session (Scoped by Room ID)
export async function savePeerSession(peerUuid, roomId) {
  if (!peerUuid || !roomId) {
    logger.warn('[Identity] Invalid peerUuid or roomId');
    return;
  }
  
  try {
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      
      // Use prefixed key to avoid collision with own sessions
      // We use RoomID as the primary key to allow "Scoped" history
      // If I join Room B, I shouldn't resume Room A's transfer
      const key = `peer_${roomId}`;
      store.put({ 
        roomId: key,
        peerUuid: peerUuid, 
        lastConnected: Date.now() 
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    logger.error('[Identity] Failed to save peer session:', err);
    // Don't throw - this is not critical functionality
  }
}

// 6. Verify Peer
export async function verifyPeer(peerUuid, currentRoomId) {
  if (!peerUuid || !currentRoomId) {
    return false;
  }
  
  try {
    const db = await getDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      
      // Look up by prefixed key
      const key = `peer_${currentRoomId}`;
      const request = store.get(key);

      request.onsuccess = () => {
        const record = request.result;
        
        // Verification:
        // 1. Do we have a record for this ROOM?
        // 2. Is the user the SAME as before?
        if (record && record.peerUuid === peerUuid) {
          resolve(true); // Verified: Resume allowed
        } else {
          resolve(false); // New session or different user
        }
      };
      request.onerror = () => resolve(false);
    });
  } catch (err) {
    logger.error('[Identity] Failed to verify peer:', err);
    return false;
  }
}

// 7. Get Peer Session Metadata
export async function getPeerSessionMetadata(roomId) {
  if (!roomId) {
    return null;
  }
  
  try {
    const db = await getDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      
      const key = `peer_${roomId}`;
      const request = store.get(key);
      
      request.onsuccess = () => {
        const record = request.result;
        resolve(record || null);
      };
      request.onerror = () => resolve(null);
    });
  } catch (err) {
    logger.error('[Identity] Failed to get peer session metadata:', err);
    return null;
  }
}

// 8. Check if session is stale (>5 minutes since last connection)
export function isSessionStale(lastConnected, maxAgeMinutes = 5) {
  if (!lastConnected) return true;
  const maxAgeMs = maxAgeMinutes * 60 * 1000;
  return (Date.now() - lastConnected) > maxAgeMs;
}

// 9. Check if this is a new session (different UUID)
export function isNewSession(currentUuid, storedUuid) {
  if (!currentUuid || !storedUuid) return true;
  return currentUuid !== storedUuid;
}