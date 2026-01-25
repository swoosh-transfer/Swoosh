/**
 * Identity Manager
 * Handles ephemeral identity (sessionStorage) and room-scoped session persistence (IndexedDB).
 */

const DB_NAME = 'P2PFileTransfer'; // Matches your existing DB name
const DB_VERSION = 3; // Incrementing version to add 'sessions' store
const STORE_NAME = 'sessions';

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
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear(); 
    console.log('[Identity] Cleared stale session data');
  } catch (e) {
    console.error(e);
    // Ignore error if store doesn't exist yet
  }
}

// 3. Save Peer Session (Scoped by Room ID)
export async function savePeerSession(peerUuid, roomId) {
  const db = await openDB();
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
}

// 4. Verify Peer
export async function verifyPeer(peerUuid, currentRoomId) {
  const db = await openDB();
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
}

// Helper to open DB (Reusing your existing pattern logic)
function openDB() {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Create sessions store if missing
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'roomId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}