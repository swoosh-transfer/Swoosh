# Transfer Flow Documentation

This document provides a detailed walkthrough of the file transfer lifecycle, from connection establishment to completion.

## Table of Contents

- [Overview](#overview)
- [Phase 1: Connection Establishment](#phase-1-connection-establishment)
- [Phase 2: Security Verification (TOFU)](#phase-2-security-verification-tofu)
- [Phase 3: File Transfer Initiation](#phase-3-file-transfer-initiation)
- [Phase 4: Chunking & Sending](#phase-4-chunking--sending)
- [Phase 5: Receiving & Assembly](#phase-5-receiving--assembly)
- [Phase 6: Completion & Verification](#phase-6-completion--verification)
- [Special Cases](#special-cases)

---

## Overview

The P2P file transfer follows a multi-phase process:

```
┌──────────────┐         ┌──────────────┐
│   Host       │         │   Peer       │
│ (Sender)     │         │ (Receiver)   │
└──────┬───────┘         └──────┬───────┘
       │                        │
       │  1. WebRTC Connection  │
       │◄──────────────────────►│
       │                        │
       │  2. TOFU Verification  │
       │◄──────────────────────►│
       │                        │
       │  3. File Metadata      │
       ├───────────────────────►│
       │                        │
       │  4. Chunked Transfer   │
       ├───────────────────────►│
       ├───────────────────────►│
       ├───────────────────────►│
       │                        │
       │  5. Completion Ack     │
       │◄───────────────────────┤
       │                        │
```

### Key Principles

- **WebRTC DataChannel:** Enables P2P communication without server intermediary
- **Chunking:** Files split into 16KB network chunks, assembled into 64KB storage chunks
- **TOFU Security:** Trust On First Use prevents MITM attacks
- **Progress Tracking:** Single source of truth via `ProgressTracker`
- **Crash Recovery:** Transfer state persisted to IndexedDB
- **Pause/Resume:** Transfers can be paused and resumed without data loss

---

## Phase 1: Connection Establishment

### Sequence Diagram

```
Host                ConnectionService       SignalingServer        Peer
 │                         │                      │                 │
 │ 1. createRoom()         │                      │                 │
 ├────────────────────────►│                      │                 │
 │                         │ 2. Register room     │                 │
 │                         ├─────────────────────►│                 │
 │                         │                      │                 │
 │ 3. Generate QR/URL      │                      │                 │
 │◄────────────────────────┤                      │                 │
 │                         │                      │                 │
 │                         │                      │ 4. joinRoom()   │
 │                         │                      │◄────────────────┤
 │                         │                      │                 │
 │                         │ 5. Peer joined event │                 │
 │                         │◄─────────────────────┤                 │
 │                         │                      │                 │
 │                         │ 6. Exchange ICE      │                 │
 │                         │◄────────────────────►│                 │
 │                         │                      │                 │
 │ 7. onConnected event    │                      │ 8. onConnected  │
 │◄────────────────────────┤                      ├────────────────►│
```

### Detailed Steps

#### Step 1: Host Creates Room

**File:** [services/ConnectionService.js](../src/services/ConnectionService.js)

```javascript
async createRoom() {
  // 1. Generate unique room ID
  const roomId = identityManager.generateRoomId();
  
  // 2. Initialize WebRTC peer connection
  const peerConnection = new RTCPeerConnection(ICE_SERVERS_CONFIG);
  
  // 3. Create data channel for file transfer
  const dataChannel = peerConnection.createDataChannel('fileTransfer', {
    ordered: true,
    maxRetransmits: 3,
  });
  
  // 4. Register with signaling server
  await signaling.registerRoom(roomId);
  
  // 5. Store in room store
  roomStore.setRoom({ roomId, isHost: true });
  
  return { roomId, qrCodeUrl, shareableUrl };
}
```

#### Step 2: Peer Joins Room

**File:** [services/ConnectionService.js](../src/services/ConnectionService.js)

```javascript
async joinRoom(roomId) {
  // 1. Validate room exists
  const roomExists = await signaling.checkRoom(roomId);
  if (!roomExists) throw new ConnectionError('Room not found');
  
  // 2. Initialize peer connection
  const peerConnection = new RTCPeerConnection(ICE_SERVERS_CONFIG);
  
  // 3. Listen for data channel from host
  peerConnection.ondatachannel = (event) => {
    this.dataChannel = event.channel;
    this.setupDataChannelHandlers();
  };
  
  // 4. Join signaling room
  await signaling.joinRoom(roomId);
  
  // 5. Store in room store
  roomStore.setRoom({ roomId, isHost: false });
}
```

#### Step 3: ICE Candidate Exchange

**File:** [utils/signaling.js](../src/utils/signaling.js)

```javascript
// Host side
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    signaling.sendIceCandidate(roomId, event.candidate);
  }
};

// Receive peer's ICE candidates
signaling.on('iceCandidate', (candidate) => {
  peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
});
```

#### Step 4: Data Channel Ready

```javascript
dataChannel.onopen = () => {
  logger.log('[ConnectionService] Data channel open');
  this.emit('dataChannelReady');
  
  // Enable file transfer UI
  this.connectionReady = true;
};
```

**Result:** WebRTC connection established, data channel ready for transfer

---

## Phase 2: Security Verification (TOFU)

### Sequence Diagram

```
Host                SecurityService         MessageService         Peer
 │                         │                      │                 │
 │ 1. Connection ready     │                      │                 │
 ├────────────────────────►│                      │                 │
 │                         │ 2. Generate fingerprint                │
 │                         │      (SHA-256 hash)   │                 │
 │                         │                      │                 │
 │                         │ 3. Send fingerprint  │                 │
 │                         ├─────────────────────►│                 │
 │                         │                      ├────────────────►│
 │                         │                      │                 │
 │                         │                      │ 4. Display verification UI
 │                         │                      │◄────────────────┤
 │                         │                      │                 │
 │                         │ 5. User verifies both sides            │
 │                         │◄────────────────────────────────────────┤
 │                         │                      │                 │
 │ 6. onVerified event     │                      │ 7. onVerified   │
 │◄────────────────────────┤                      ├────────────────►│
```

### Detailed Steps

#### Step 1: Generate Security Payload

**File:** [services/SecurityService.js](../src/services/SecurityService.js)

```javascript
async generateSecurityPayload() {
  // 1. Get or create identity fingerprint
  const fingerprint = await identityManager.getFingerprint();
  
  // 2. Create verification payload
  const payload = {
    fingerprint,
    timestamp: Date.now(),
    deviceId: identityManager.getDeviceId(),
    version: APP_VERSION,
  };
  
  // 3. Store in room store
  roomStore.setSecurityPayload(payload);
  
  return payload;
}
```

#### Step 2: Exchange Fingerprints

**File:** [services/MessageService.js](../src/services/MessageService.js)

```javascript
// Host sends fingerprint
const message = {
  type: MESSAGE_TYPE_SECURITY_PAYLOAD,
  payload: securityPayload,
};
dataChannel.send(JSON.stringify(message));

// Peer receives and stores
handleSecurityPayload(payload) {
  this.peerFingerprint = payload.fingerprint;
  this.emit('fingerprintReceived', payload);
}
```

#### Step 3: Display Verification UI

**File:** [pages/Room/components/SecuritySection.jsx](../src/pages/Room/components/SecuritySection.jsx)

```jsx
export function SecuritySection({ myFingerprint, peerFingerprint }) {
  return (
    <div className="security-verification">
      <h3>Verify Connection Security</h3>
      
      <div className="fingerprint-comparison">
        <div>
          <label>Your Code:</label>
          <code>{formatFingerprint(myFingerprint)}</code>
        </div>
        
        <div>
          <label>Peer Code:</label>
          <code>{formatFingerprint(peerFingerprint)}</code>
        </div>
      </div>
      
      <p>Both users should verbally confirm these codes match</p>
      <button onClick={handleVerify}>Codes Match - Verify</button>
    </div>
  );
}
```

#### Step 4: User Verification

```javascript
handleVerify() {
  // User confirms codes match
  securityService.verifyPeer(peerFingerprint);
  
  // Store in TOFU database
  tofuSecurity.trustPeer(peerFingerprint);
  
  // Enable file transfer
  this.emit('verified');
}
```

**Result:** Secure connection established, ready for file transfer

---

## Phase 3: File Transfer Initiation

### Sequence Diagram

```
Sender              TransferOrchestrator    MessageService       Receiver
  │                         │                      │                 │
  │ 1. Select file          │                      │                 │
  ├────────────────────────►│                      │                 │
  │                         │ 2. Generate metadata │                 │
  │                         │    (hash, size, etc) │                 │
  │                         │                      │                 │
  │                         │ 3. Send metadata     │                 │
  │                         ├─────────────────────►│                 │
  │                         │                      ├────────────────►│
  │                         │                      │                 │
  │                         │                      │ 4. Show accept/reject UI
  │                         │                      │◄────────────────┤
  │                         │                      │                 │
  │                         │ 5. Accept response   │                 │
  │                         │◄─────────────────────┤                 │
  │                         │                      │                 │
  │ 6. Start chunking       │                      │ 7. Prepare receiver
  │◄────────────────────────┤                      ├────────────────►│
```

### Detailed Steps

#### Step 1: File Selection

**File:** [pages/Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js)

```javascript
const handleSendFile = async () => {
  // 1. Open File System API picker
  const [fileHandle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: 'All Files',
        accept: { '*/*': [] },
      },
    ],
  });
  
  // 2. Get file object
  const file = await fileHandle.getFile();
  
  // 3. Start transfer
  await transferOrchestrator.startSending(file, dataChannel);
};
```

#### Step 2: Generate File Metadata

**File:** [services/TransferOrchestrator.js](../src/services/TransferOrchestrator.js)

```javascript
async startSending(file, dataChannel) {
  // 1. Generate unique transfer ID
  const transferId = crypto.randomUUID();
  
  // 2. Calculate file hash
  const fileHash = await this.calculateFileHash(file);
  
  // 3. Create metadata
  const metadata = {
    transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    fileHash,
    totalChunks: Math.ceil(file.size / NETWORK_CHUNK_SIZE),
    timestamp: Date.now(),
  };
  
  // 4. Save to IndexedDB
  await transfersRepository.saveTransfer({
    ...metadata,
    status: 'pending',
    type: 'upload',
  });
  
  return metadata;
}
```

#### Step 3: Send Metadata to Peer

**File:** [services/MessageService.js](../src/services/MessageService.js)

```javascript
sendFileMetadata(metadata) {
  const message = {
    type: MESSAGE_TYPE_FILE_METADATA,
    payload: metadata,
  };
  
  this.dataChannel.send(JSON.stringify(message));
  logger.log('[MessageService] Sent file metadata:', metadata.fileName);
}
```

#### Step 4: Receiver Accepts/Rejects

**File:** [pages/Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js)

```javascript
const handleAcceptFile = async (transferId) => {
  // 1. Show save file picker
  const fileHandle = await window.showSaveFilePicker({
    suggestedName: metadata.fileName,
  });
  
  // 2. Send acceptance
  messageService.send({
    type: MESSAGE_TYPE_TRANSFER_ACCEPT,
    payload: { transferId },
  });
  
  // 3. Start receiver
  await transferOrchestrator.startReceiving(metadata, fileHandle, dataChannel);
};
```

**Result:** Both sides ready to transfer, engines initialized

---

## Phase 4: Chunking & Sending

### Sequence Diagram

```
File          ChunkingEngine      BufferManager     ProgressTracker    DataChannel
 │                  │                    │                  │                │
 │ 1. Read 16KB     │                    │                  │                │
 ├─────────────────►│                    │                  │                │
 │                  │ 2. Add to buffer   │                  │                │
 │                  ├───────────────────►│                  │                │
 │                  │                    │                  │                │
 │ 3. Read 16KB     │                    │                  │                │
 ├─────────────────►│                    │                  │                │
 │                  │ 4. Add to buffer   │                  │                │
 │                  ├───────────────────►│                  │                │
 │                  │                    │ 5. Buffer full (64KB)            │
 │                  │                    │    Calculate hash│                │
 │                  │                    ├─────────────────►│                │
 │                  │                    │                  │                │
 │                  │                    │ 6. Update progress                │
 │                  │                    ├─────────────────►│                │
 │                  │                    │                  │                │
 │                  │                    │ 7. Send chunk    │                │
 │                  │                    ├─────────────────────────────────►│
 │                  │                    │                  │                │
 │ 8. Continue...   │                    │                  │                │
```

### Detailed Steps

#### Step 1: Initialize Chunking Engine

**File:** [transfer/sending/ChunkingEngine.js](../src/transfer/sending/ChunkingEngine.js)

```javascript
async sendFile(file, dataChannel) {
  // 1. Create progress tracker
  this.progressTracker = new ProgressTracker(file.size);
  
  // 2. Create buffer manager
  this.bufferManager = new BufferManager(STORAGE_CHUNK_SIZE);
  
  // 3. Start file stream
  const stream = file.stream();
  const reader = stream.getReader();
  
  // 4. Begin chunking loop
  await this.chunkingLoop(reader, dataChannel);
}
```

#### Step 2: Chunking Loop

**File:** [transfer/sending/ChunkingEngine.js](../src/transfer/sending/ChunkingEngine.js)

```javascript
async chunkingLoop(reader, dataChannel) {
  let chunkIndex = 0;
  
  while (true) {
    // 1. Read 16KB from file
    const { done, value } = await reader.read();
    if (done) break;
    
    // 2. Add to buffer
    this.bufferManager.addChunk(value);
    
    // 3. Check if buffer full (64KB)
    if (this.bufferManager.isFull()) {
      // 4. Get complete buffer
      const storageChunk = this.bufferManager.getBuffer();
      
      // 5. Calculate checksum
      const checksum = await this.calculateChecksum(storageChunk);
      
      // 6. Create chunk metadata
      const chunkMetadata = {
        index: chunkIndex++,
        size: storageChunk.byteLength,
        checksum,
        transferId: this.transferId,
      };
      
      // 7. Send metadata
      this.sendChunkMetadata(dataChannel, chunkMetadata);
      
      // 8. Send chunk data
      this.sendChunkData(dataChannel, storageChunk);
      
      // 9. Update progress
      this.progressTracker.updateProgress(storageChunk.byteLength);
      
      // 10. Reset buffer
      this.bufferManager.reset();
      
      // 11. Add pause check
      await this.checkPauseState();
    }
  }
  
  // Handle final partial buffer
  await this.sendFinalChunk();
}
```

#### Step 3: Progress Updates

**File:** [transfer/shared/ProgressTracker.js](../src/transfer/shared/ProgressTracker.js)

```javascript
updateProgress(bytesTransferred) {
  this.currentBytes += bytesTransferred;
  
  // Calculate metrics
  const percentage = (this.currentBytes / this.totalBytes) * 100;
  const elapsed = (Date.now() - this.startTime) / 1000;
  const speed = this.currentBytes / elapsed; // bytes per second
  const remaining = this.totalBytes - this.currentBytes;
  const eta = remaining / speed; // seconds
  
  // Emit progress event
  this.callbacks.onProgress.forEach(cb => cb({
    percentage: parseFloat(percentage.toFixed(2)),
    currentBytes: this.currentBytes,
    totalBytes: this.totalBytes,
    speed: parseFloat(speed.toFixed(2)),
    eta: parseFloat(eta.toFixed(2)),
  }));
}
```

**Result:** File chunks sent over DataChannel with real-time progress

---

## Phase 5: Receiving & Assembly

### Sequence Diagram

```
DataChannel      AssemblyEngine     ChunkValidator    FileWriter      ProgressTracker
     │                  │                  │               │                │
     │ 1. Chunk data    │                  │               │                │
     ├─────────────────►│                  │               │                │
     │                  │ 2. Validate checksum             │                │
     │                  ├─────────────────►│               │                │
     │                  │                  │               │                │
     │                  │ 3. Valid ✓       │               │                │
     │                  │◄─────────────────┤               │                │
     │                  │                  │               │                │
     │                  │ 4. Add to assembly buffer        │                │
     │                  │                  │               │                │
     │                  │ 5. Buffer full (64KB)            │                │
     │                  │    Write to disk │               │                │
     │                  ├─────────────────────────────────►│                │
     │                  │                  │               │                │
     │                  │ 6. Update progress                               │
     │                  ├─────────────────────────────────────────────────►│
     │                  │                  │               │                │
     │ 7. Continue...   │                  │               │                │
```

### Detailed Steps

#### Step 1: Initialize Assembly Engine

**File:** [transfer/receiving/AssemblyEngine.js](../src/transfer/receiving/AssemblyEngine.js)

```javascript
async receiveFile(metadata, fileHandle, dataChannel) {
  // 1. Create progress tracker
  this.progressTracker = new ProgressTracker(metadata.fileSize);
  
  // 2. Create file writer
  this.fileWriter = new FileWriter(fileHandle);
  
  // 3. Create chunk validator
  this.chunkValidator = new ChunkValidator();
  
  // 4. Initialize assembly buffer
  this.assemblyBuffer = [];
  this.expectedChunks = metadata.totalChunks;
  this.receivedChunks = 0;
  
  // 5. Listen for chunks
  dataChannel.onmessage = (event) => this.handleChunk(event.data);
}
```

#### Step 2: Receive and Validate Chunks

**File:** [transfer/receiving/AssemblyEngine.js](../src/transfer/receiving/AssemblyEngine.js)

```javascript
async handleChunk(data) {
  // 1. Parse message
  const message = JSON.parse(data);
  
  if (message.type === 'chunk-metadata') {
    // Store metadata for validation
    this.chunkMetadata[message.payload.index] = message.payload;
  } else if (message.type === 'chunk-data') {
    // 2. Get metadata for this chunk
    const metadata = this.chunkMetadata[message.payload.index];
    
    // 3. Validate checksum
    const isValid = await this.chunkValidator.validate(
      message.payload.data,
      metadata.checksum
    );
    
    if (!isValid) {
      // Request re-send
      this.requestChunkResend(message.payload.index);
      return;
    }
    
    // 4. Add to assembly buffer
    this.assemblyBuffer.push({
      index: message.payload.index,
      data: message.payload.data,
    });
    
    this.receivedChunks++;
    
    // 5. Check if buffer should be written
    if (this.shouldWriteBuffer()) {
      await this.flushBuffer();
    }
    
    // 6. Update progress
    this.progressTracker.updateProgress(message.payload.data.byteLength);
    
    // 7. Check if complete
    if (this.receivedChunks === this.expectedChunks) {
      await this.completeTransfer();
    }
  }
}
```

#### Step 3: Write to File System

**File:** [infrastructure/storage/FileWriter.js](../src/infrastructure/storage/FileWriter.js)

```javascript
async writeChunk(chunk) {
  // 1. Get writable stream
  const writable = await this.fileHandle.createWritable();
  
  // 2. Write chunk
  await writable.write({
    type: 'write',
    position: this.currentPosition,
    data: chunk,
  });
  
  // 3. Update position
  this.currentPosition += chunk.byteLength;
  
  // 4. Close stream
  await writable.close();
  
  logger.log(`[FileWriter] Wrote chunk at position ${this.currentPosition}`);
}
```

**Result:** Chunks validated, assembled, and written to file

---

## Phase 6: Completion & Verification

### Sequence Diagram

```
Receiver          AssemblyEngine      FileWriter      MessageService      Sender
   │                     │                 │                 │                │
   │ 1. All chunks received                │                 │                │
   ├────────────────────►│                 │                 │                │
   │                     │ 2. Calculate file hash           │                │
   │                     │                 │                 │                │
   │                     │ 3. Verify against metadata       │                │
   │                     │                 │                 │                │
   │                     │ 4. Hash valid ✓ │                 │                │
   │                     │                 │                 │                │
   │                     │ 5. Flush to disk│                 │                │
   │                     ├────────────────►│                 │                │
   │                     │                 │                 │                │
   │                     │ 6. Send completion                                │
   │                     ├────────────────────────────────────────────────────►│
   │                     │                 │                 │                │
   │ 7. Show success     │                 │                 │ 8. Mark complete
   │◄────────────────────┤                 │                 │◄───────────────┤
```

### Detailed Steps

#### Step 1: Verify Complete File

**File:** [transfer/receiving/AssemblyEngine.js](../src/transfer/receiving/AssemblyEngine.js)

```javascript
async completeTransfer() {
  // 1. Flush any remaining buffer
  if (this.assemblyBuffer.length > 0) {
    await this.flushBuffer();
  }
  
  // 2. Close file writer
  await this.fileWriter.close();
  
  // 3. Calculate final hash
  const fileHash = await this.calculateFinalHash();
  
  // 4. Verify against metadata
  if (fileHash !== this.metadata.fileHash) {
    throw new TransferError('File hash mismatch - transfer corrupted');
  }
  
  logger.log('[AssemblyEngine] Transfer complete, hash verified ✓');
  
  // 5. Send completion message
  this.messageService.send({
    type: MESSAGE_TYPE_TRANSFER_COMPLETE,
    payload: {
      transferId: this.metadata.transferId,
      success: true,
      fileHash,
    },
  });
  
  // 6. Update database
  await transfersRepository.updateTransfer(this.metadata.transferId, {
    status: 'completed',
    completedAt: Date.now(),
  });
  
  // 7. Emit completion event
  this.emit('transferComplete', {
    transferId: this.metadata.transferId,
    fileName: this.metadata.fileName,
    fileSize: this.metadata.fileSize,
  });
}
```

#### Step 2: Update UI

**File:** [pages/Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js)

```javascript
useEffect(() => {
  const handleComplete = ({ fileName, fileSize }) => {
    // Update state
    setTransferStatus('completed');
    
    // Show notification
    showNotification(`✓ ${fileName} received (${formatBytes(fileSize)})`);
    
    // Add to history
    transferStore.completeTransfer(transferId, {
      fileName,
      fileSize,
      completedAt: Date.now(),
    });
  };
  
  transferOrchestrator.on('transferComplete', handleComplete);
  
  return () => {
    transferOrchestrator.off('transferComplete', handleComplete);
  };
}, []);
```

**Result:** Transfer complete, file saved, both sides notified

---

## Special Cases

### Pause/Resume

**Pause:**
```javascript
async pauseTransfer(transferId) {
  // 1. Set pause flag
  this.pausedTransfers.add(transferId);
  
  // 2. Save state to IndexedDB
  await resumableTransferManager.saveState(transferId, {
    currentBytes: progressTracker.getCurrentBytes(),
    chunksCompleted: this.receivedChunks,
  });
  
  // 3. Notify peer
  messageService.send({
    type: MESSAGE_TYPE_TRANSFER_PAUSE,
    payload: { transferId },
  });
}
```

**Resume:**
```javascript
async resumeTransfer(transferId) {
  // 1. Load saved state
  const state = await resumableTransferManager.loadState(transferId);
  
  // 2. Resume from saved position
  this.progressTracker.setProgress(state.currentBytes);
  this.receivedChunks = state.chunksCompleted;
  
  // 3. Clear pause flag
  this.pausedTransfers.delete(transferId);
  
  // 4. Notify peer
  messageService.send({
    type: MESSAGE_TYPE_TRANSFER_RESUME,
    payload: { transferId, resumeFrom: state.chunksCompleted },
  });
}
```

### Crash Recovery

On page reload:

```javascript
async recoverTransfers() {
  // 1. Load active transfers from IndexedDB
  const activeTransfers = await transfersRepository.getActiveTransfers();
  
  // 2. For each active transfer
  for (const transfer of activeTransfers) {
    // 3. Check if peer still connected
    if (!connectionService.isConnected()) {
      // Mark as failed
      await transfersRepository.updateTransfer(transfer.id, {
        status: 'failed',
        error: 'Connection lost',
      });
      continue;
    }
    
    // 4. Resume transfer
    await resumableTransferManager.resume(transfer);
  }
}
```

### Error Handling

```javascript
try {
  await transferOrchestrator.startSending(file, dataChannel);
} catch (error) {
  if (error instanceof ConnectionError) {
    // Peer disconnected
    showError('Connection lost. Please reconnect.');
  } else if (error instanceof TransferError) {
    // Transfer-specific error
    showError(`Transfer failed: ${error.message}`);
  } else {
    // Unknown error
    logger.error('[Transfer] Unknown error', error);
    showError('An unexpected error occurred');
  }
  
  // Mark transfer as failed
  await transfersRepository.updateTransfer(transferId, {
    status: 'failed',
    error: error.message,
  });
}
```

---

## Performance Optimizations

### Adaptive Chunk Sizing

```javascript
// Monitor transfer speed and adjust chunk size
if (speed > 10 * 1024 * 1024) { // > 10 MB/s
  NETWORK_CHUNK_SIZE = 32 * 1024; // Use 32KB chunks
} else if (speed < 1 * 1024 * 1024) { // < 1 MB/s
  NETWORK_CHUNK_SIZE = 8 * 1024; // Use 8KB chunks
}
```

### Buffer Management

```javascript
// Use typed arrays for efficiency
const buffer = new Uint8Array(STORAGE_CHUNK_SIZE);

// Reuse buffers instead of allocating new ones
this.bufferPool = [];
```

### IndexedDB Batching

```javascript
// Batch database writes
const batchSize = 10;
if (this.pendingWrites.length >= batchSize) {
  await this.flushPendingWrites();
}
```

---

## Debugging Tips

See [DEBUGGING.md](DEBUGGING.md) for detailed debugging strategies for each phase.

## Next Steps

- **Understand Architecture:** [NEW_DEVELOPER_GUIDE.md](NEW_DEVELOPER_GUIDE.md)
- **Add Features:** [ADDING_FEATURES.md](ADDING_FEATURES.md)
- **Debug Issues:** [DEBUGGING.md](DEBUGGING.md)
