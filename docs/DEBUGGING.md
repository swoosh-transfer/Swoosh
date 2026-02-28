# Debugging Guide

This guide helps you troubleshoot common issues in the P2P file transfer application.

## Table of Contents

- [Quick Diagnostics](#quick-diagnostics)
- [Connection Issues](#connection-issues)
- [Transfer Problems](#transfer-problems)
- [Security/TOFU Issues](#securitytofu-issues)
- [Performance Degradation](#performance-degradation)
- [IndexedDB/Persistence Issues](#indexeddbpersistence-issues)
- [Browser Compatibility](#browser-compatibility)
- [Debugging Tools](#debugging-tools)

---

## Quick Diagnostics

### Enable Debug Logging

```javascript
// In browser console
localStorage.setItem('DEBUG', 'true');
localStorage.setItem('LOG_LEVEL', 'verbose'); // 'error' | 'warn' | 'log' | 'verbose'

// Reload page to see verbose logs
location.reload();
```

### Check Application State

```javascript
// In browser console
import { useRoomStore } from '@/stores/roomStore';
import { useTransferStore } from '@/stores/transferStore';

// Check room state
console.log('Room State:', useRoomStore.getState());

// Check transfer state
console.log('Transfer State:', useTransferStore.getState());

// Check IndexedDB
// Chrome DevTools → Application → IndexedDB → p2p-file-transfer
```

### Verify WebRTC Connection

```
Chrome: chrome://webrtc-internals/
Firefox: about:webrtc
Edge: edge://webrtc-internals/
```

This shows real-time WebRTC stats, ICE candidates, connection state, and data channel status.

---

## Connection Issues

### Problem: "Room Not Found"

**Symptoms:**
- Peer cannot join room
- Error message: "Room not found"
- Signaling server returns 404

**Possible Causes:**
1. Room ID typed incorrectly
2. Host left before peer joined
3. Signaling server connection lost
4. Room expired (timeout)

**Debugging Steps:**

```javascript
// Check room exists on signaling server
const roomId = 'your-room-id';
const exists = await signaling.checkRoom(roomId);
console.log('Room exists:', exists);

// Check signaling connection
console.log('Signaling connected:', signaling.isConnected());

// Enable signaling debug logs
localStorage.setItem('DEBUG_SIGNALING', 'true');
```

**Solutions:**
- Verify room ID matches exactly (case-sensitive)
- Host should stay on page while peer joins
- Check network connectivity (firewall/proxy)
- Try recreating the room

---

### Problem: "ICE Connection Failed"

**Symptoms:**
- Connection stuck at "Connecting..."
- WebRTC state: "failed" or "disconnected"
- No data channel established

**Possible Causes:**
1. Strict NAT/firewall blocking UDP
2. Corporate network blocking WebRTC
3. No valid ICE candidates
4. STUN servers unreachable

**Debugging Steps:**

```javascript
// Check ICE connection state
peerConnection.oniceconnectionstatechange = () => {
  console.log('ICE state:', peerConnection.iceConnectionState);
  console.log('Connection state:', peerConnection.connectionState);
};

// Check ICE candidates gathered
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    console.log('ICE candidate:', event.candidate.type, event.candidate.protocol);
  } else {
    console.log('ICE gathering complete');
  }
};
```

**Chrome WebRTC Internals:**
1. Go to `chrome://webrtc-internals/`
2. Find your peer connection
3. Check:
   - **ICE candidate pairs:** Should see "succeeded" pairs
   - **Selected candidate pair:** Should have local and remote addresses
   - **Connection state:** Should be "connected"

**Solutions:**

1. **Try different network:**
   - Switch from WiFi to mobile hotspot
   - Try on different network (home vs office)

2. **Check STUN configuration:**
   ```javascript
   // In constants/network.constants.js
   export const ICE_SERVERS = [
     { urls: 'stun:stun.l.google.com:19302' },
     { urls: 'stun:stun1.l.google.com:19302' },
     // Add backup STUN servers
     { urls: 'stun:stun.relay.metered.ca:80' },
   ];
   ```

3. **Add TURN server** (for restrictive networks):
   ```javascript
   export const ICE_SERVERS = [
     { urls: 'stun:stun.l.google.com:19302' },
     {
       urls: 'turn:your-turn-server.com:3478',
       username: 'username',
       credential: 'password',
     },
   ];
   ```

---

### Problem: "Data Channel Not Opening"

**Symptoms:**
- WebRTC connected but file transfer buttons disabled
- Data channel state: "connecting" or "closed"
- Console shows "Data channel not ready"

**Debugging Steps:**

```javascript
// Check data channel state
dataChannel.onopen = () => {
  console.log('Data channel opened ✓');
};

dataChannel.onerror = (error) => {
  console.error('Data channel error:', error);
};

dataChannel.onclose = () => {
  console.log('Data channel closed');
};

// Current state
console.log('Data channel state:', dataChannel.readyState);
// Should be: 'open'
```

**Solutions:**
- Ensure both peers have compatible DataChannel configuration
- Check WebRTC connection is fully established first
- Try recreating the peer connection
- Verify no browser extensions blocking WebRTC

---

## Transfer Problems

### Problem: Transfer Stalls at X%

**Symptoms:**
- Progress bar stops updating
- Percentage stuck (e.g., 47%)
- No errors shown
- Network activity stops

**Debugging Steps:**

```javascript
// Check current transfer state
const state = await transfersRepository.getTransfer(transferId);
console.log('Transfer state:', state);

// Check progress tracker
console.log('Progress:', progressTracker.getProgress());

// Check data channel buffered amount
console.log('Buffered bytes:', dataChannel.bufferedAmount);
// Should be 0 or small number when idle

// Check for paused state
console.log('Is paused:', resumableTransferManager.isPaused(transferId));
```

**Possible Causes:**

1. **Buffer Overflow:**
   ```javascript
   // Check if sender is overwhelming receiver
   dataChannel.onbufferedamountlow = () => {
     console.log('Buffer cleared, resuming send');
   };
   
   // In ChunkingEngine, add backpressure handling:
   if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
     await this.waitForBufferDrain();
   }
   ```

2. **Chunk Validation Failure:**
   ```javascript
   // Check for failed validations
   const failedChunks = assemblyEngine.getFailedChunks();
   console.log('Failed chunks:', failedChunks);
   
   // These should be retried automatically
   ```

3. **File System API Issue:**
   ```javascript
   // Check file write errors
   try {
     await fileWriter.writeChunk(chunk);
   } catch (error) {
     console.error('File write error:', error);
     // Could be: quota exceeded, permission denied, disk full
   }
   ```

**Solutions:**
- Refresh page and resume transfer (crash recovery should work)
- Check available disk space
- Try with smaller file first
- Enable verbose logging to find exact stall point

---

### Problem: "Hash Mismatch" Error

**Symptoms:**
- Transfer completes but shows error
- Message: "File hash mismatch - transfer corrupted"
- File saved but verification fails

**Debugging Steps:**

```javascript
// Compare hashes
console.log('Expected hash:', metadata.fileHash);
console.log('Actual hash:', calculatedHash);

// Check chunk validation stats
const stats = assemblyEngine.getValidationStats();
console.log('Chunks received:', stats.received);
console.log('Chunks valid:', stats.valid);
console.log('Chunks failed:', stats.failed);
console.log('Chunks retried:', stats.retried);
```

**Possible Causes:**
1. Corrupted chunk during transfer
2. Chunk order mismatch (out-of-order assembly)
3. File modified during sending
4. Memory corruption (rare)

**Solutions:**

1. **Enable strict chunk ordering:**
   ```javascript
   // In AssemblyEngine
   this.strictOrdering = true; // Ensure chunks assembled in order
   ```

2. **Retry transfer:**
   - Close and reopen connection
   - Transfer file again
   - If consistent, file may be corrupted at source

3. **Verify file before sending:**
   ```javascript
   // Calculate hash before and after transfer
   const hashBefore = await calculateFileHash(file);
   // ... transfer ...
   const hashAfter = await calculateFileHash(receivedFile);
   console.log('Hashes match:', hashBefore === hashAfter);
   ```

---

### Problem: Transfer Speed Very Slow

**Symptoms:**
- Transfer shows < 100 KB/s
- Expected speed much higher based on connection
- ETA shows hours for small file

**Debugging Steps:**

```javascript
// Check current speed
const progress = progressTracker.getProgress();
console.log('Current speed:', formatBytes(progress.speed), '/s');

// Check network bandwidth
// Use: https://www.speedtest.net/

// Check data channel stats
const stats = await peerConnection.getStats();
stats.forEach(stat => {
  if (stat.type === 'data-channel') {
    console.log('Bytes sent:', stat.bytesSent);
    console.log('Messages sent:', stat.messagesSent);
  }
});
```

**Possible Causes:**

1. **Chunk size too small:**
   ```javascript
   // In constants/transfer.constants.js
   export const NETWORK_CHUNK_SIZE = 16 * 1024; // Try increasing to 32KB
   export const STORAGE_CHUNK_SIZE = 64 * 1024; // Try increasing to 128KB
   ```

2. **Too much processing per chunk:**
   ```javascript
   // Profile chunk processing
   console.time('chunk-process');
   await processChunk(chunk);
   console.timeEnd('chunk-process');
   // Should be < 10ms per chunk
   ```

3. **Network congestion:**
   - Other apps using bandwidth
   - WiFi interference
   - ISP throttling

**Solutions:**
- Close other bandwidth-heavy apps
- Use wired connection instead of WiFi
- Try different time of day
- Enable adaptive chunk sizing (may already be enabled)

---

## Security/TOFU Issues

### Problem: "TOFU Verification Never Completes"

**Symptoms:**
- Verification UI appears but clicking verify does nothing
- Fingerprints not matching
- Stuck on verification screen

**Debugging Steps:**

```javascript
// Check fingerprints
const myFingerprint = await identityManager.getFingerprint();
const peerFingerprint = securityService.getPeerFingerprint();

console.log('My fingerprint:', myFingerprint);
console.log('Peer fingerprint:', peerFingerprint);

// Check TOFU database
const trusted = await tofuSecurity.isTrusted(peerFingerprint);
console.log('Peer trusted:', trusted);
```

**Solutions:**

1. **Reset identity:**
   ```javascript
   // Clears existing fingerprint, generates new one
   await identityManager.resetIdentity();
   // Both peers must reconnect
   ```

2. **Clear TOFU database:**
   ```javascript
   // In browser console
   await tofuSecurity.clearAllTrustedPeers();
   // Requires re-verification for all peers
   ```

3. **Manual verification:**
   ```javascript
   // Bypass verification (DEVELOPMENT ONLY!)
   securityService.bypassVerification = true;
   ```

---

### Problem: "Previously Trusted Peer Now Untrusted"

**Symptoms:**
- Reconnecting to known peer requires re-verification
- TOFU database forgot the peer

**Debugging Steps:**

```javascript
// Check TOFU database
const allTrusted = await tofuSecurity.getAllTrustedPeers();
console.log('Trusted peers:', allTrusted);

// Check if fingerprint changed
const storedFingerprint = await tofuSecurity.getStoredFingerprint(peerDeviceId);
const currentFingerprint = peerSecurityPayload.fingerprint;
console.log('Stored:', storedFingerprint);
console.log('Current:', currentFingerprint);
console.log('Match:', storedFingerprint === currentFingerprint);
```

**Possible Causes:**
1. Peer reset their identity
2. IndexedDB was cleared
3. Browser private/incognito mode
4. Different device/browser

**Solutions:**
- Accept that re-verification is needed
- Use persistent browser profile (not incognito)
- Don't clear browser data between sessions

---

## Performance Degradation

### Problem: Browser Becomes Unresponsive

**Symptoms:**
- UI freezes during transfer
- Browser "Not Responding" warning
- Page crashes

**Possible Causes:**

1. **Synchronous file operations:**
   ```javascript
   // BAD: Synchronous read blocks UI
   const data = fileReader.readAsArrayBuffer(file); // Blocks!
   
   // GOOD: Use streams (already implemented)
   const stream = file.stream();
   const reader = stream.getReader();
   while (true) {
     const { done, value } = await reader.read(); // Non-blocking
     if (done) break;
     // Process chunk
   }
   ```

2. **Too much memory usage:**
   ```javascript
   // Check memory usage
   if (performance.memory) {
     console.log('Used heap:', performance.memory.usedJSHeapSize);
     console.log('Total heap:', performance.memory.totalJSHeapSize);
     console.log('Limit:', performance.memory.jsHeapSizeLimit);
   }
   ```

3. **Not using Web Workers:**
   - Hash calculation should be in worker
   - Large file processing should be offloaded

**Solutions:**

1. **Reduce chunk size if memory constrained:**
   ```javascript
   export const STORAGE_CHUNK_SIZE = 32 * 1024; // Use 32KB instead of 64KB
   ```

2. **Add artificial delays:**
   ```javascript
   // In chunking loop, yield to browser
   if (chunkIndex % 100 === 0) {
     await new Promise(resolve => setTimeout(resolve, 0)); // Yield
   }
   ```

3. **Profile with Chrome DevTools:**
   - Performance tab → Record
   - Identify long tasks (> 50ms)
   - Optimize or move to worker

---

## IndexedDB/Persistence Issues

### Problem: "Quota Exceeded" Error

**Symptoms:**
- Error: "QuotaExceededError"
- Transfer fails mid-way
- Can't save to IndexedDB

**Debugging Steps:**

```javascript
// Check storage quota
if (navigator.storage && navigator.storage.estimate) {
  const estimate = await navigator.storage.estimate();
  console.log('Quota:', estimate.quota);
  console.log('Usage:', estimate.usage);
  console.log('Available:', estimate.quota - estimate.usage);
  console.log('Percentage:', (estimate.usage / estimate.quota * 100).toFixed(2) + '%');
}
```

**Solutions:**

1. **Request persistent storage:**
   ```javascript
   if (navigator.storage && navigator.storage.persist) {
     const isPersisted = await navigator.storage.persist();
     console.log('Persistent storage granted:', isPersisted);
   }
   ```

2. **Clean up old transfers:**
   ```javascript
   // Delete completed transfers older than 7 days
   await transfersRepository.cleanupOldTransfers(7 * 24 * 60 * 60 * 1000);
   ```

3. **Don't store actual chunk data:**
   - Only store metadata (already implemented)
   - Chunks stream directly, not saved to IndexedDB

---

### Problem: IndexedDB Upgrade Failed

**Symptoms:**
- Error: "VersionError" or "AbortError"
- Database won't open
- Schema changes not applied

**Debugging Steps:**

```javascript
// Check current DB version
const db = await dbClient.getDatabase();
console.log('DB version:', db.version);

// Check for open connections
// Close all tabs with the app, then try again
```

**Solutions:**

1. **Close all tabs:**
   - IndexedDB upgrade requires closing all connections
   - Close all app tabs, reopen one tab

2. **Manual database deletion:**
   ```javascript
   // IN BROWSER CONSOLE - DELETES ALL DATA!
   indexedDB.deleteDatabase('p2p-file-transfer');
   // Then reload page
   ```

3. **Check schema migration:**
   ```javascript
   // In infrastructure/database/client.js
   upgrade(db, oldVersion, newVersion, transaction) {
     console.log(`Upgrading DB from ${oldVersion} to ${newVersion}`);
     // Ensure all migrations handled
   }
   ```

---

## Browser Compatibility

### Problem: Features Not Available

**Required APIs:**
- WebRTC DataChannels
- File System Access API
- IndexedDB
- SubtleCrypto (for hashing)
- Web Streams API

**Debugging Steps:**

```javascript
// Check API support
const support = {
  webrtc: 'RTCPeerConnection' in window,
  fileSystem: 'showOpenFilePicker' in window,
  indexedDB: 'indexedDB' in window,
  crypto: 'crypto' in window && 'subtle' in crypto,
  streams: 'ReadableStream' in window,
};

console.log('Browser support:', support);

// Show user-friendly error
const unsupported = Object.keys(support).filter(key => !support[key]);
if (unsupported.length > 0) {
  console.error('Unsupported features:', unsupported);
  alert(`Your browser doesn't support: ${unsupported.join(', ')}`);
}
```

**Browser Compatibility:**

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebRTC DataChannel | ✅ 56+ | ✅ 22+ | ✅ 11+ | ✅ 79+ |
| File System Access API | ✅ 86+ | ❌ No | ❌ No | ✅ 86+ |
| IndexedDB | ✅ All | ✅ All | ✅ All | ✅ All |
| SubtleCrypto | ✅ 37+ | ✅ 34+ | ✅ 11+ | ✅ 79+ |

**Fallbacks:**

1. **No File System Access API (Firefox, Safari):**
   ```javascript
   // Use traditional file input + download
   const input = document.createElement('input');
   input.type = 'file';
   input.onchange = (e) => {
     const file = e.target.files[0];
     // ... handle file
   };
   ```

2. **Save with download link:**
   ```javascript
   // Create blob URL and trigger download
   const blob = new Blob([fileData], { type: fileType });
   const url = URL.createObjectURL(blob);
   const a = document.createElement('a');
   a.href = url;
   a.download = fileName;
   a.click();
   ```

---

## Debugging Tools

### Logger Utility

```javascript
// In utils/logger.js
import { logger } from '@/utils/logger';

// Different log levels
logger.error('Critical error', error);
logger.warn('Warning message');
logger.log('Info message');
logger.debug('Debug details');

// Categorized logging
logger.log('[Transfer] Chunk sent:', chunkIndex);
logger.log('[Connection] Peer connected');
```

### React DevTools

- Install [React DevTools](https://react.dev/learn/react-developer-tools)
- Inspect component state and props
- View hook values
- Track state changes

### Redux DevTools (for Zustand)

```javascript
// Already configured in stores
// Can use Redux DevTools to inspect Zustand state
```

### Network Tab

Monitor signaling messages:
1. Open DevTools → Network tab
2. Filter by WS (WebSocket)
3. See signaling messages in real-time

### Performance Profiling

```javascript
// Profile transfer performance
console.time('transfer');
await transferOrchestrator.startSending(file, dataChannel);
console.timeEnd('transfer');

// Profile specific operations
console.time('hash-calculation');
const hash = await calculateFileHash(file);
console.timeEnd('hash-calculation');
```

---

## Common Error Messages

### "DataChannel is not open"

**Cause:** Trying to send data before channel ready  
**Solution:** Wait for `onDataChannelReady` event

```javascript
connectionService.on('dataChannelReady', () => {
  // Now safe to send data
});
```

---

### "Cannot read property 'send' of undefined"

**Cause:** DataChannel not initialized  
**Solution:** Check connection state first

```javascript
if (dataChannel && dataChannel.readyState === 'open') {
  dataChannel.send(data);
} else {
  logger.error('DataChannel not ready');
}
```

---

### "Failed to execute 'transaction' on 'IDBDatabase'"

**Cause:** IndexedDB transaction error  
**Solution:** Check object store exists

```javascript
const db = await dbClient.getDatabase();
if (!db.objectStoreNames.contains('transfers')) {
  logger.error('Object store not found - DB upgrade needed');
}
```

---

## Getting Help

If you're still stuck:

1. **Check documentation:**
   - [NEW_DEVELOPER_GUIDE.md](NEW_DEVELOPER_GUIDE.md)
   - [TRANSFER_FLOW.md](TRANSFER_FLOW.md)
   - [ARCHITECTURE.md](../ARCHITECTURE.md)

2. **Search closed issues:**
   - GitHub Issues → Closed tab
   - Your issue may already be solved

3. **Create detailed bug report:**
   - Browser version, OS
   - Steps to reproduce
   - Console logs (with DEBUG=true)
   - WebRTC internals dump (if connection issue)

4. **Join community:**
   - Discord/Slack (if available)
   - Stack Overflow with tag

Happy debugging! 🐛🔍
