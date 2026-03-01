/**
 * Identity Manager
 * Handles ephemeral identity (sessionStorage) and room-scoped session persistence (IndexedDB).
 * Uses the shared infrastructure database client to avoid version conflicts.
 */

import { getDatabase, STORE_NAMES } from '../infrastructure/database/client.js';
import logger from './logger.js';

const STORE_NAME = STORE_NAMES.SESSIONS;

// 1. Get Local UUID (Ephemeral - dies on tab close)
export function getLocalUUID() {
  let uuid = sessionStorage.getItem('device_session_uuid');
  
  if (!uuid) {
    // Fresh tab detected: Clear old session data from IndexedDB
    // This ensures we don't accidentally resume a session from a closed tab
    clearOldSessions(); 
    
    // Generate new UUID
    uuid = crypto.randomUUID();
    sessionStorage.setItem('device_session_uuid', uuid);
  }
  return uuid;
}

// 2. Clear old session data (Housekeeping)
async function clearOldSessions() {
  try {
    const db = await getDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear(); 
    logger.log('[Identity] Cleared stale session data');
  } catch (e) {
    logger.error('[Identity] Error clearing sessions:', e);
    // Ignore error if store doesn't exist yet
  }
}

// 3. Save Peer Session (Scoped by Room ID)
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
      
      // We use RoomID as the primary key to allow "Scoped" history
      // If I join Room B, I shouldn't resume Room A's transfer
      store.put({ 
        roomId: roomId,
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

// 4. Verify Peer
export async function verifyPeer(peerUuid, currentRoomId) {
  if (!peerUuid || !currentRoomId) {
    return false;
  }
  
  try {
    const db = await getDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      
      // Look up by RoomID (Current Context)
      const request = store.get(currentRoomId);

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