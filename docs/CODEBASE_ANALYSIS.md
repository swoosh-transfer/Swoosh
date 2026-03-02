# Codebase Analysis: How Everything Works

**Last Updated:** March 2, 2026  
**Purpose:** Complete runtime behavior analysis documenting how the codebase actually works today  
**Audience:** New developers, debugging, architecture reviews, refactoring planning

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Runtime Walkthrough](#runtime-walkthrough)
3. [Architecture by Layer](#architecture-by-layer)
4. [Protocol & Data Flow](#protocol--data-flow)
5. [State Ownership Model](#state-ownership-model)
6. [Recovery & Reliability](#recovery--reliability)
7. [Security Model](#security-model)
8. [Testing Reality](#testing-reality)
9. [Known Inconsistencies & Issues](#known-inconsistencies--issues)

---

## Executive Summary

This application is a browser-based peer-to-peer file transfer system using WebRTC data channels, supporting:

- **Large file transfers** (50GB+) with multi-file/folder support
- **Multi-channel transfers** (up to 8 parallel data channels for bandwidth optimization)
- **Resume capability** (pause, reconnect, crash recovery via IndexedDB bitmaps)
- **Direct disk writing** (File System Access API for memory efficiency)
- **Encrypted signaling** (AES-GCM-256 encryption for all SDP/ICE messages)
- **Peer identity verification** (UUID-based session tracking for auto-resume on reconnect)

### Key Architectural Patterns

- **Hooks-as-orchestration:** Business logic lives in React hooks ([src/pages/Room/hooks](../src/pages/Room/hooks)), NOT in a service layer
- **Event-driven transfer engines:** Stateful transfer modules ([src/transfer](../src/transfer)) with callback-based APIs
- **Repository pattern:** Infrastructure layer ([src/infrastructure](../src/infrastructure)) encapsulates IndexedDB and File System API
- **Zustand stores:** Minimal global state for navigation/file selection ([src/stores](../src/stores))
- **Single source of truth:** [ProgressTracker](../src/transfer/shared/ProgressTracker.js) for all transfer progress

### Current State vs Documentation

**⚠️ Important:** Existing documentation ([ARCHITECTURE.md](../ARCHITECTURE.md), [flow.md](../flow.md), [implementation.md](../implementation.md)) describes the **intended** design. This document describes **runtime reality**. See [Known Inconsistencies](#known-inconsistencies--issues) for gaps.

---

## Runtime Walkthrough

### 1. Application Startup

**Entry Point:** [src/main.jsx](../src/main.jsx)

```javascript
// 1. Initialize IndexedDB at app startup (before React mounts)
initializeDatabase().then((result) => {
  if (result.success) {
    logger.log('[App] IndexedDB ready with stores:', result.stores);
    // Stores: transfers, files, chunks, sessions
  }
});

// 2. Mount React app
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

**Database Schema:** [src/infrastructure/database/client.js](../src/infrastructure/database/client.js)
- `transfers` - Transfer metadata (status, progress, bitmaps)
- `files` - File metadata (NOT binary data)
- `chunks` - Chunk metadata (checksums, NOT binary data)
- `sessions` - Peer UUID sessions (for returning-peer detection)

**Router Setup:** [src/App.jsx](../src/App.jsx)
```javascript
<BrowserRouter>
  <Routes>
    <Route path="/" element={<Home />} />
    <Route path="/:roomId" element={<Room />} />
  </Routes>
</BrowserRouter>
```

---

### 2. Home Page Flow

**Component:** [src/pages/Home.jsx](../src/pages/Home.jsx)

#### a) Resume Detection

On mount, Home queries IndexedDB for incomplete transfers:

```javascript
useEffect(() => {
  async function loadIncomplete() {
    await cleanupOldTransfers(); // Auto-discard >7 days old
    
    const transfers = await listTransfers();
    const incomplete = transfers.filter(
      (t) => (t.status === 'interrupted' || t.status === 'paused') &&
        t.direction !== 'receiving' // Only sender can resume from Home
    );
    
    // Build UI list with progress from bitmaps
    // De-duplicate by fileName
    setIncompleteTransfers(items);
  }
  loadIncomplete();
}, []);
```

**Resume Flow:**
1. User clicks "Resume" on an interrupted transfer
2. Home loads file metadata and bitmap from IndexedDB
3. Sets `resumeContext` in [roomStore](../src/stores/roomStore.js)
4. Creates a new room and navigates to Room page
5. Room page detects `resumeContext` and initiates resume handshake

#### b) File Selection & Room Creation

```javascript
const handleStartTransfer = async () => {
  // 1. Initialize socket
  const socket = initSocket();
  await waitForConnection();
  
  // 2. Create room via signaling server
  const { roomId } = await createRoom();
  
  // 3. Generate security payload
  const secret = await generateSharedSecret();
  const peerID = await generatePeerID();
  const payload = createSecurityPayload(secret, peerID);
  
  // 4. Derive AES key and set in signaling module
  const aesKey = await deriveEncryptionKey(secret);
  setEncryptionKey(aesKey);
  
  // 5. Store in roomStore and navigate
  setRoomId(roomId);
  setIsHost(true);
  setSecurityPayload(payload);
  
  // 6. Navigate to room with secret in URL fragment
  navigate(`/${roomId}#${btoa(JSON.stringify(payload))}`);
};
```

**Share URL Format:**
```
https://example.com/{roomId}#{base64(JSON.stringify({secret, peerID, timestamp}))}
```

The secret in the URL fragment is **server-blind** (servers don't log fragments).

---

### 3. Room Page Initialization

**Component:** [src/pages/Room/index.jsx](../src/pages/Room/index.jsx)

Room is a **composition of 8 custom hooks** (~851 lines total, NOT the claimed ~200):

#### Hook Initialization Order

```javascript
const roomId = useParams().roomId;
const { isHost, securityPayload, selectedFiles, resumeContext } = useRoomStore();

// 1. UI state (logs, pending files, download results)
const uiState = useRoomState();
const { addLog, logs, pendingFile, clearPendingFile } = uiState;

// 2. WebRTC connection (socket, peer connection, data channel)
const connection = useRoomConnection(roomId, isHost, (channel) => {
  security.markVerified(); // Data channel open = verified
  security.sendHandshake(channel); // Send UUID for session tracking
}, addLog);
const { dataChannelReady, sendJSON, sendBinary } = connection;

// 3. Security (encrypted signaling verification)
const security = useSecurity(roomId, sendJSON, addLog);
const { tofuVerified, identityVerified, isReturningPeer, interruptedTransfer } = security;

// 4. Transfer tracking (IndexedDB persistence)
const tracking = useTransferTracking({ roomId, peerDisconnected, addLog });

// 5. Single-file transfer (chunking/assembly engines)
const transfer = useFileTransfer(roomId, isHost, selectedFile, securityPayload, 
  tofuVerified, sendJSON, sendBinary, waitForDrain, addLog, tracking.trackChunkProgress);

// 6. Multi-file transfer (manager/receiver)
const multiTransfer = useMultiFileTransfer({ roomId, isHost, selectedFiles, tofuVerified,
  sendJSON, sendBinary, waitForDrain, addLog, trackChunkProgress: tracking.trackChunkProgress });

// 7. Message router (dispatches protocol messages to handlers)
const { setMultiFileMode, sendResumeRequest } = useMessages(
  dataChannelRef, dataChannelReady, isHost, security, transfer, multiTransfer, 
  uiState, addLog, sendJSON, resumeCallbacksRef.current);

// 8. Resume handshake (cross-session and in-room resume)
const resumeFlow = useResumeTransfer({ dataChannelReady, sendResumeRequest, addLog });
```

**Note:** Despite comments claiming ~200 lines, the Room component is **851 lines** due to complex resume/reconnection logic and UI orchestration.

---

### 4. Connection Establishment

**Hook:** [useRoomConnection](../src/pages/Room/hooks/useRoomConnection.js)

#### Guest (Joiner) Flow

```javascript
// 1. Parse security payload from URL fragment
const hash = window.location.hash.slice(1);
const decoded = JSON.parse(atob(hash));
setSecurityPayload(decoded);

// 2. Derive AES key BEFORE joining room
const aesKey = await deriveEncryptionKey(decoded.secret);
setEncryptionKey(aesKey);

// 3. Initialize socket
const socket = initSocket();
await waitForConnection();

// 4. Set up WebRTC BEFORE joining (critical for race condition fix)
setPolite(true); // Guest is polite in perfect negotiation
initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats);
setupSignalingListeners(socket, roomId);

// 5. Join room (triggers host's offer)
await joinRoom(roomId);
```

#### Host Flow

```javascript
// Host already initialized socket from Home page
// WebRTC setup happens when peer joins

socket.on('peer-joined', async () => {
  initializePeerConnection(socket, roomId, onChannelReady, onStateChange, onStats);
  setupSignalingListeners(socket, roomId);
  setPolite(false); // Host is impolite
  
  // Create offer
  await createOffer(socket, roomId, onChannelReady);
});
```

#### Encrypted Signaling

**Module:** [src/utils/signaling.js](../src/utils/signaling.js)

All SDP (offer/answer) and ICE candidates are encrypted before transmission:

```javascript
// Sender
export async function sendOffer(offer, roomId) {
  const encrypted = await encryptSignaling(offer, encryptionKey);
  socket.emit('offer', { roomId, offer: encrypted });
}

// Receiver
socket.on('offer', async (data) => {
  const decrypted = await decryptSignaling(data.offer, encryptionKey);
  await handleOffer(decrypted, socket, roomId);
});
```

**Security:** Only peers with the correct shared secret can decrypt signaling messages. If decryption fails, the connection cannot be established.

---

### 5. Security Verification

**Hook:** [useSecurity](../src/pages/Room/hooks/useSecurity.js)

#### Two-Phase Verification

**Phase 1: Encrypted Signaling (Implicit)**
- If data channel opens successfully, encrypted signaling succeeded
- Proves both peers hold the same shared secret
- **No explicit challenge-response needed** (unlike older implementations)

**Phase 2: Identity Handshake (Explicit for Resume)**
- Peers exchange UUIDs over the open data channel
- Used to detect returning peers for auto-resume

```javascript
// When data channel opens
const markVerified = () => {
  tofuVerifiedRef.current = true;
  setTofuVerified(true);
  setVerificationStatus('verified');
  addLog('Peer verified (encrypted signaling succeeded)', 'success');
};

// Send UUID for identity tracking
const sendHandshake = (channel) => {
  channel.send(JSON.stringify({ 
    type: 'handshake', 
    uuid: myUUID.current 
  }));
};

// Receive peer UUID
const handleHandshake = async (msg) => {
  const isKnownPeer = await verifyPeer(msg.uuid, roomId);
  
  if (isKnownPeer) {
    setIsReturningPeer(true);
    
    // Query IndexedDB for interrupted transfers in this room
    const interrupted = (await listTransfers()).find(
      t => t.roomId === roomId && 
           (t.status === 'interrupted' || t.status === 'paused')
    );
    
    setInterruptedTransfer(interrupted);
  }
  
  await savePeerSession(msg.uuid, roomId);
  setIdentityVerified(true);
};
```

**Identity Storage:** [src/utils/identityManager.js](../src/utils/identityManager.js)
- Local UUID stored in sessionStorage (per-tab)
- Peer sessions stored in IndexedDB sessions store (persistent)
- Stale sessions auto-cleaned after 24 hours

---

### 6. Message Protocol

**Hook:** [useMessages](../src/pages/Room/hooks/useMessages.js)

All messages arrive on the data channel after verification. The message router dispatches to appropriate handlers:

```javascript
const processMessage = async (event) => {
  // Binary data = file chunk
  if (event.data instanceof ArrayBuffer) {
    await handleChunkData(new Uint8Array(event.data), channelIndex);
    return;
  }

  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'handshake':
      await handleHandshake(msg);
      break;

    // Single-file protocol
    case 'file-metadata':
      await transfer.initializeReceive(msg, setPendingFileData);
      break;
    case 'chunk-metadata':
      chunkMetaQueueRef.current.push(msg);
      // Process queued binary chunk if available
      break;
    case 'receiver-ready':
      await transfer.sendFileChunks();
      break;

    // Multi-file protocol
    case MESSAGE_TYPE.MULTI_FILE_MANIFEST:
      await multiTransfer.handleMultiFileManifest(msg);
      break;
    case MESSAGE_TYPE.FILE_START:
      // File boundary marker
      break;
    case MESSAGE_TYPE.FILE_COMPLETE:
      await multiTransfer.handleFileComplete(msg.fileIndex);
      break;

    // Pause/resume control
    case 'transfer-paused':
      await transfer.handleRemotePause();
      break;
    case 'transfer-resumed':
      await transfer.handleRemoteResume();
      break;

    // Resume handshake
    case MESSAGE_TYPE.RESUME_TRANSFER:
      // Peer proposes resuming from saved bitmap
      await handleResumeRequest(msg);
      break;
    case MESSAGE_TYPE.RESUME_ACCEPTED:
      resumeCallbacks?.onResumeAccepted?.(msg);
      break;
    case MESSAGE_TYPE.RESUME_REJECTED:
      resumeCallbacks?.onResumeRejected?.(msg);
      break;

    // Heartbeat (connection health)
    case 'heartbeat':
      heartbeatMonitor.recordHeartbeat(roomId);
      sendJSON({ type: 'heartbeat-ack' });
      break;
  }
};
```

#### Message/Binary Pairing

Chunks are sent as **metadata (JSON) + binary (ArrayBuffer)**:

```javascript
// Sender (ChunkingEngine)
sendJSON({ 
  type: 'chunk-metadata', 
  chunkIndex: 42, 
  checksum: 'abc123...', 
  size: 16384 
});
await waitForDrain();
sendBinary(chunkBuffer); // ArrayBuffer
```

**Receiver:** Metadata arrives first, binary follows. Binary chunks are matched to metadata from a FIFO queue:

```javascript
if (event.data instanceof ArrayBuffer) {
  const meta = chunkMetaQueueRef.current.shift();
  if (meta) {
    await receiveChunk(meta, new Uint8Array(event.data));
  } else {
    // Binary arrived before metadata (rare) - queue it
    pendingBinaryQueueRef.current.push(data);
  }
}
```

---

### 7. File Transfer

#### Single-File Transfer

**Sender:** [ChunkingEngine](../src/transfer/sending/ChunkingEngine.js)

```javascript
// 1. Send metadata to receiver
sendJSON({
  type: 'file-metadata',
  transferId,
  name: file.name,
  size: file.size,
  totalChunks: Math.ceil(file.size / STORAGE_CHUNK_SIZE)
});

// 2. Wait for receiver-ready
// (receiver prompts user for save location first)

// 3. Read file in 16KB chunks, buffer to 64KB, send
const reader = file.stream().getReader();
let storageBuffer = new Uint8Array(STORAGE_CHUNK_SIZE);
let bufferSize = 0;

while (true) {
  const { value: chunk, done } = await reader.read(); // 16KB
  if (done) break;
  
  storageBuffer.set(chunk, bufferSize);
  bufferSize += chunk.length;
  
  if (bufferSize >= STORAGE_CHUNK_SIZE) {
    const checksum = await calculateChecksum(storageBuffer);
    
    sendJSON({ type: 'chunk-metadata', chunkIndex, checksum, size: bufferSize });
    await waitForDrain();
    sendBinary(storageBuffer.buffer);
    
    // Track in bitmap for resume
    markChunk(chunkBitmap, chunkIndex);
    trackChunkProgress(transferId, chunkIndex);
    
    bufferSize = 0;
    chunkIndex++;
  }
}
```

**Receiver:** [AssemblyEngine](../src/transfer/receiving/AssemblyEngine.js)

```javascript
// 1. Receive metadata, prompt for save location
async initializeReceive({ transferId, name, size }) {
  progressTracker.initialize(transferId, { totalChunks, fileSize: size, fileName: name });
  chunkValidator.initialize(transferId, totalChunks);
  
  const bitmap = createBitmap(totalChunks);
  this.chunkBitmaps.set(transferId, bitmap);
  
  // Wait for user to select save location
  setPendingFileData({ transferId, name, size });
}

// 2. User clicks "Select save location"
async setupFileWriter(transferId, fileName) {
  const writerInfo = await initFileWriter(transferId, fileName, fileSize);
  this.fileWriters.set(transferId, writerInfo);
  
  // Tell sender we're ready
  sendJSON({ type: 'receiver-ready' });
}

// 3. Receive chunks, validate, write directly to disk
async receiveChunk(transferId, chunkData, chunkMetadata) {
  // Validate checksum
  const calculatedChecksum = await calculateChecksum(chunkData);
  if (calculatedChecksum !== chunkMetadata.checksum) {
    throw new ValidationError('Checksum mismatch');
  }
  
  // Write directly to file (no IndexedDB storage)
  await writeFileChunk(transferId, chunkMetadata.chunkIndex, chunkData);
  
  // Update bitmap
  markChunk(bitmap, chunkMetadata.chunkIndex);
  
  // Flush bitmap to IndexedDB periodically
  if (++chunkCount % 50 === 0) {
    await updateTransfer(transferId, { 
      chunkBitmap: serializeBitmap(bitmap) 
    });
  }
}
```

#### Multi-File Transfer

**Manager:** [MultiFileTransferManager](../src/transfer/multifile/MultiFileTransferManager.js)

```javascript
// 1. Send manifest
const manifest = {
  type: MESSAGE_TYPE.MULTI_FILE_MANIFEST,
  totalFiles: files.length,
  totalSize: sum(files.map(f => f.size)),
  files: files.map(f => ({ 
    name: f.name, 
    size: f.size, 
    relativePath: f.relativePath 
  })),
  mode: TRANSFER_MODE.SEQUENTIAL, // or PARALLEL
};
sendJSON(manifest);

// 2. Wait for receiver to accept

// 3. Send files (sequential or parallel)
if (mode === TRANSFER_MODE.SEQUENTIAL) {
  for (let i = 0; i < files.length; i++) {
    await sendFile(i);
  }
} else {
  // Parallel: up to 3 concurrent file workers
  const workers = [];
  for (let w = 0; w < 3; w++) {
    workers.push(sendFilesWorker());
  }
  await Promise.all(workers);
}

// 4. Each file uses ChunkingEngine internally
async sendFile(fileIndex) {
  sendJSON({ type: MESSAGE_TYPE.FILE_START, fileIndex });
  
  const engine = new ChunkingEngine();
  await engine.startChunking(transferId, file, peerId, async ({ metadata, binaryData }) => {
    // Route chunks to appropriate channel (multi-channel support)
    const channelIndex = getOptimalChannel();
    sendJSONOnChannel(channelIndex, { ...metadata, fileIndex });
    await waitForDrainOnChannel(channelIndex);
    sendBinaryOnChannel(channelIndex, binaryData);
  });
  
  sendJSON({ type: MESSAGE_TYPE.FILE_COMPLETE, fileIndex });
}
```

**Receiver:** [MultiFileReceiver](../src/transfer/multifile/MultiFileReceiver.js)

```javascript
// 1. Receive manifest, prompt for directory
async handleManifest(manifest) {
  this.manifest = manifest;
  setAwaitingDirectory(true); // Prompt user
}

// 2. User selects directory
async acceptMultiFileTransfer() {
  if (totalFiles === 1) {
    // Use showSaveFilePicker for single file
    const fileHandle = await window.showSaveFilePicker({ suggestedName: manifest.files[0].name });
    await this.setSingleFileHandle(fileHandle);
  } else {
    // Use showDirectoryPicker for multiple files
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await this.setDirectoryHandle(dirHandle);
  }
  
  sendJSON({ type: MESSAGE_TYPE.RECEIVER_READY });
}

// 3. Receive chunks, route by fileIndex
handleChunkMetadata(metadata) {
  const fileIndex = metadata.fileIndex;
  this.perFileMetaQueues[fileIndex].push(metadata);
}

async handleBinaryChunk(data, fileIndex) {
  const meta = this.perFileMetaQueues[fileIndex].shift();
  
  // Validate and write
  const engine = this.assemblyEngines[fileIndex];
  await engine.receiveChunk(transferId, data, meta);
}
```

---

### 8. Multi-Channel Transfer

**ChannelPool:** [src/transfer/multichannel/ChannelPool.js](../src/transfer/multichannel/ChannelPool.js)

For high-bandwidth transfers, the system can open up to 8 parallel data channels:

```javascript
class ChannelPool {
  constructor(peerConnection) {
    this._pc = peerConnection;
    this._channels = new Map(); // index → RTCDataChannel
  }

  // Sender creates additional channels
  addChannel(index) {
    const label = `${CHANNEL_LABEL_PREFIX}${index}`;
    const channel = this._pc.createDataChannel(label, {
      ordered: true,
      maxRetransmits: 3,
    });
    
    this._channels.set(index, channel);
    this._setupChannelHandlers(channel, index);
    
    return channel;
  }

  // Receiver accepts incoming channels
  acceptChannel(channel) {
    const index = this._parseChannelIndex(channel.label);
    this._channels.set(index, channel);
    this._setupChannelHandlers(channel, index);
    
    return index;
  }

  // Send on optimal channel (load balancing)
  send(data, preferredIndex = null) {
    const channel = preferredIndex !== null 
      ? this._channels.get(preferredIndex)
      : this._getLeastBufferedChannel();
    
    channel.send(data);
  }
}
```

**Auto-Scaling:** [bandwidth monitor](../src/transfer/multichannel/BandwidthMonitor.js) tracks throughput and scales channels:

```javascript
// Every 3 seconds, evaluate scaling
if (avgThroughput > CHANNEL_SCALE_UP_THRESHOLD && openChannels < MAX_CHANNELS) {
  channelPool.addChannel(nextIndex++);
}
if (avgThroughput < CHANNEL_SCALE_DOWN_THRESHOLD && openChannels > MIN_CHANNELS) {
  channelPool.removeChannel(lastIndex--);
}
```

---

## Architecture by Layer

### Layer 1: UI Components

**Pages:**
- [Home.jsx](../src/pages/Home.jsx) (642 lines) - File selection, resume detection, room creation
- [Room/index.jsx](../src/pages/Room/index.jsx) (851 lines) - Transfer orchestration, hook composition

**Components:**
- [FileDropZone.jsx](../src/components/FileDropZone.jsx) - Drag-and-drop file/folder picker
- [RoomUI.jsx](../src/components/RoomUI.jsx) - Reusable UI components (progress bars, status indicators)
- [Room/components/](../src/pages/Room/components/) - Transfer, activity log, connection sections

### Layer 2: Orchestration Hooks

**Purpose:** Business logic and state orchestration (replaces the non-existent "service layer")

**Location:** [src/pages/Room/hooks/](../src/pages/Room/hooks/)

| Hook | Responsibility | State Owned |
|------|----------------|-------------|
| `useRoomState` | UI state (logs, pending files) | Local React state |
| `useRoomConnection` | WebRTC lifecycle, socket management | Connection refs, channel state |
| `useSecurity` | Encrypted signaling verification, UUID handshake | Verification status, returning peer |
| `useFileTransfer` | Single-file transfer orchestration | Transfer state, progress, pause state |
| `useMultiFileTransfer` | Multi-file transfer orchestration | Multi-transfer state, per-file progress |
| `useMessages` | Protocol message routing | Message queues, mode flag |
| `useTransferTracking` | IndexedDB persistence bridge | Bitmap refs, flush timers |
| `useResumeTransfer` | Resume handshake coordination | Resume state, proposal timeout |

**Key Pattern:** Hooks own business logic and delegate to transfer engines/repositories. State flows through props/callbacks, NOT global stores.

### Layer 3: Transfer Domain

**Purpose:** File transfer protocol implementation (stateful, event-driven)

**Location:** [src/transfer/](../src/transfer/)

#### Core Engines

| Module | Responsibility | State |
|--------|----------------|-------|
| `ChunkingEngine` | File reading, buffering, checksumming | Per-transfer chunking state, bitmaps |
| `AssemblyEngine` | Chunk validation, assembly, disk writing | Per-transfer assembly state, receive buffers |
| `ProgressTracker` | **Single source of truth** for progress | Per-transfer progress, speed, ETA |
| `ResumableTransferManager` | Pause/resume coordination | Transfer lifecycle state |
| `ChunkValidator` | Checksum validation, duplicate detection | Per-transfer validation state |

#### Multi-File/Multi-Channel

| Module | Responsibility |
|--------|----------------|
| `MultiFileTransferManager` | Multi-file sender orchestration, channel pool integration |
| `MultiFileReceiver` | Multi-file receiver, directory picker, per-file assembly |
| `FileQueue` | File queue management (sequential/parallel modes) |
| `ChannelPool` | WebRTC data channel lifecycle, load balancing |
| `BandwidthMonitor` | Throughput tracking, auto-scaling logic |

**Pattern:** Transfer modules expose callback-based APIs (not Promises in loops). Hooks subscribe to events and update UI state.

### Layer 4: Infrastructure & Adapters

**Purpose:** Data persistence, I/O, external system integration

#### Database Layer

**Location:** [src/infrastructure/database/](../src/infrastructure/database/)

| Module | Responsibility |
|--------|----------------|
| `client.js` | IndexedDB connection, schema management |
| `transfers.repository.js` | Transfer CRUD operations |
| `chunks.repository.js` | Chunk metadata CRUD (NOT binary data) |
| `metadata.repository.js` | File metadata CRUD |
| `chunkBitmap.js` | Bitmap utilities (create, mark, serialize, deserialize) |

**Pattern:** Repository pattern encapsulates IndexedDB. Returns `{ success, data, error }` objects.

#### Storage Layer

**Location:** [src/infrastructure/storage/](../src/infrastructure/storage/)

| Module | Responsibility |
|--------|----------------|
| `FileWriter.js` | File System Access API wrapper, direct disk writes |
| `WriteQueue.js` | Sequential write queue (ensures chunk ordering) |

**Critical:** Chunks are written **directly to disk**, NOT stored in IndexedDB. Only checksums and metadata are persisted.

#### Network/Security Adapters

**Location:** [src/utils/](../src/utils/)

| Module | Responsibility |
|--------|----------------|
| `signaling.js` | Socket.IO client, room management, encrypted message transport |
| `p2pManager.js` | WebRTC peer connection lifecycle, perfect negotiation pattern |
| `tofuSecurity.js` | AES-GCM encryption/decryption, key derivation (PBKDF2) |
| `identityManager.js` | UUID generation, peer session storage/verification |
| `connectionMonitor.js` | Connection health monitoring (RTT, packet loss) |
| `heartbeatMonitor.js` | Heartbeat protocol to detect stale connections |

### Layer 5: State Stores

**Purpose:** Minimal global state for navigation and file selection

**Location:** [src/stores/](../src/stores/)

#### roomStore.js

**Owns:**
- `roomId`, `isHost` - Navigation state
- `securityPayload` - Shared secret for encrypted signaling
- `selectedFiles` - Files selected on Home, persisted to Room
- `resumeContext` - Resume metadata when resuming from Home
- `error` - Global room-level errors

**Does NOT own:**
- Connection state (in `useRoomConnection`)
- Transfer progress (in `useFileTransfer` + `ProgressTracker`)
- Security verification (in `useSecurity`)

#### transferStore.js

**Owns:**
- `transferHistory` - Completed/failed/cancelled transfers for UI display

**Does NOT own:**
- Active transfer state (in hooks)
- Progress tracking (in `ProgressTracker`)
- Pause/resume state (in `ResumableTransferManager`)

**Note:** The store exposes `initiateUpload`/`initiateDownload` methods, but **these are called by hooks and only update history, not active state**.

---

## Protocol & Data Flow

### Message Types

**Location:** [src/constants/messages.constants.js](../src/constants/messages.constants.js)

#### Single-File Protocol

| Message Type | Direction | Payload |
|-------------|-----------|---------|
| `file-metadata` | Sender → Receiver | `{ transferId, name, size, mimeType, totalChunks }` |
| `receiver-ready` | Receiver → Sender | `{}` |
| `chunk-metadata` | Sender → Receiver | `{ chunkIndex, checksum, size, isFinal }` |
| (binary) | Sender → Receiver | `ArrayBuffer` (chunk data) |
| `transfer-complete` | Sender → Receiver | `{}` |

#### Multi-File Protocol

| Message Type | Direction | Payload |
|-------------|-----------|---------|
| `multi-file-manifest` | Sender → Receiver | `{ totalFiles, totalSize, files: [...], mode }` |
| `receiver-ready` | Receiver → Sender | `{}` |
| `file-start` | Sender → Receiver | `{ fileIndex, name, size, relativePath, totalChunks }` |
| `chunk-metadata` | Sender → Receiver | `{ fileIndex, chunkIndex, checksum, size }` |
| (binary) | Sender → Receiver | `ArrayBuffer` (tagged with channel index) |
| `file-complete` | Sender → Receiver | `{ fileIndex }` |
| `transfer-complete` | Sender → Receiver | `{}` |

#### Control Protocol

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `handshake` | Both | UUID exchange for session tracking |
| `transfer-paused` | Both | Notify peer of pause |
| `transfer-resumed` | Both | Notify peer of resume |
| `transfer-cancelled` | Both | Notify peer of cancellation |
| `heartbeat` | Both | Connection health check |
| `heartbeat-ack` | Both | Heartbeat response |

#### Resume Protocol

| Message Type | Direction | Payload |
|-------------|-----------|---------|
| `resume-transfer` | Sender → Receiver | `{ transferId, fileName, fileSize, totalChunks, chunkBitmap }` |
| `resume-accepted` | Receiver → Sender | `{ transferId, startFromChunk }` |
| `resume-rejected` | Receiver → Sender | `{ transferId, reason }` |

### Chunk Bitmap Protocol

**Purpose:** Track chunk completion for pause/resume

**Sender-Side Bitmap:**
- Sender creates bitmap on transfer start
- Marks chunks as sent (for retransmission)
- Flushes to IndexedDB every 50 chunks
- Used to resume from last sent chunk

**Receiver-Side Bitmap:**
- Receiver creates bitmap on transfer start
- Marks chunks as received and validated
- Flushes to IndexedDB every 50 chunks
- Used to resume from last received chunk

**Resume Handshake:**
1. Sender proposes resume with saved bitmap
2. Receiver validates file hasn't changed (fileHash comparison)
3. Receiver compares bitmaps, finds first missing chunk
4. Receiver responds with `startFromChunk`
5. Sender resumes from that chunk

**Bitmap Format:** [chunkBitmap.js](../src/infrastructure/database/chunkBitmap.js)

```javascript
// Create bitmap for 1000 chunks
const bitmap = createBitmap(1000); // Uint8Array(125) - 1 bit per chunk

// Mark chunk 42 as complete
markChunk(bitmap, 42);

// Check if chunk 42 is complete
const isComplete = isChunkComplete(bitmap, 42);

// Get first missing chunk index
const nextChunk = getFirstMissingChunk(bitmap, totalChunks);

// Serialize for storage
const serialized = serializeBitmap(bitmap); // base64 string

// Deserialize from storage
const bitmap2 = deserializeBitmap(serialized);
```

### Multi-Channel Data Flow

**Channel Assignment:**
- Channel 0: Control messages (metadata, control protocol)
- Channels 1-7: Data channels for binary chunks (multi-file mode)

**Load Balancing:**
```javascript
// Send chunk on least-buffered channel
const channelIndex = getLeastBufferedChannel();
sendJSONOnChannel(channelIndex, { ...metadata, fileIndex });
sendBinaryOnChannel(channelIndex, binaryData);
```

**Channel-to-Metadata Matching:**
```javascript
// Per-channel metadata queues prevent interleaving corruption
const perChannelMetaRef = new Map(); // channelIndex → [metadata, ...]

// When metadata arrives on channel N
perChannelMetaRef.get(channelIndex).push(metadata);

// When binary arrives on channel N
const meta = perChannelMetaRef.get(channelIndex).shift();
await handleBinaryChunk(binaryData, meta.fileIndex);
```

**Critical:** Binary chunks are matched to metadata from the **same channel** to prevent cross-channel corruption in parallel transfers.

---

## State Ownership Model

### State Categories

| Category | Owner | Storage | Lifetime |
|----------|-------|---------|----------|
| **Navigation** | roomStore | Zustand | Page session |
| **File Selection** | roomStore | Zustand | Page session |
| **Security Payload** | roomStore | Zustand | Page session |
| **Connection State** | useRoomConnection hook | React refs/state | Room mount |
| **Verification Status** | useSecurity hook | React state | Room mount |
| **Transfer Progress** | ProgressTracker | In-memory | Transfer duration |
| **Transfer State** | useFileTransfer/useMultiFileTransfer hooks | React state | Room mount |
| **Pause/Resume** | ResumableTransferManager | In-memory | Transfer duration |
| **Transfer Metadata** | IndexedDB (transfers store) | Persistent | Until deletion |
| **Chunk Bitmaps** | IndexedDB (transfers store) | Persistent | Until deletion |
| **File Metadata** | IndexedDB (files store) | Persistent | Until deletion |
| **Peer Sessions** | IndexedDB (sessions store) | Persistent | 24 hours |

### State Flow Diagram

```
┌─────────────┐
│   Home.jsx  │
└──────┬──────┘
       │ setSelectedFiles()
       │ setResumeContext()
       ▼
┌─────────────────┐
│   roomStore     │◄──────── Navigation state, file selection
└─────────────────┘
       │
       │ selectedFiles, resumeContext
       ▼
┌─────────────────────────────────────────┐
│   Room.jsx (Hook Composition)           │
└─────────────────────────────────────────┘
       │
       ├──► useRoomConnection ──► WebRTC refs, channel state
       │
       ├──► useSecurity ──► Verification status, returning peer
       │
       ├──► useFileTransfer ──► Transfer state, progress (delegates to...)
       │      │
       │      ├──► ChunkingEngine ──► Chunking state, bitmaps
       │      │
       │      ├──► AssemblyEngine ──► Assembly state, receive buffers
       │      │
       │      └──► ProgressTracker ──► **CANONICAL PROGRESS** (speed, ETA)
       │
       ├──► useTransferTracking ──► Bitmap refs, flush to IndexedDB
       │      │
       │      └──► transfers.repository ──► IndexedDB persistence
       │
       └──► useMessages ──► Message routing, queues
```

### Anti-Patterns Observed

**❌ Duplicate Progress Tracking:**
- Some hooks track progress locally AND subscribe to ProgressTracker
- **Fix:** Always use ProgressTracker as the single source of truth

**❌ State Drift Between Hooks:**
- `useFileTransfer` and `useMultiFileTransfer` run in parallel but only one is active
- Room component must track `isMultiFile` flag to read from the correct source
- **Fix:** Consider a unified transfer hook

**❌ Circular Dependencies:**
- `useMessages` needs resume callbacks from `useResumeTransfer`
- `useResumeTransfer` needs `sendResumeRequest` from `useMessages`
- **Workaround:** `resumeCallbacksRef` passed from Room to break cycle

---

## Recovery & Reliability

### Pause/Resume

#### User-Initiated Pause

```javascript
// Sender
const pauseTransfer = () => {
  chunkingEngine.pause(transferId); // Stop reading file
  sendJSON({ type: 'transfer-paused' }); // Notify receiver
  
  // Flush bitmap to IndexedDB
  await updateTransfer(transferId, {
    status: 'paused',
    chunkBitmap: serializeBitmap(bitmap),
    pausedAt: Date.now(),
  });
};

// Receiver
const handleRemotePause = () => {
  assemblyEngine.pause(transferId); // Stop writing
  setIsPaused(true);
  setPausedBy('remote');
};
```

#### User-Initiated Resume

```javascript
// Sender
const resumeTransfer = () => {
  chunkingEngine.resume(transferId); // Resume reading
  sendJSON({ type: 'transfer-resumed' }); // Notify receiver
  
  await updateTransfer(transferId, {
    status: 'active',
    resumedAt: Date.now(),
  });
};

// Receiver
const handleRemoteResume = () => {
  assemblyEngine.resume(transferId);
  setIsPaused(false);
  setPausedBy(null);
};
```

### Auto-Pause on Disconnect

**Hook:** [Room/index.jsx](../src/pages/Room/index.jsx) lines 232-276

```javascript
useEffect(() => {
  if (!peerDisconnected) {
    // Peer reconnected - mark for identity verification
    if (wasDisconnectedRef.current) {
      awaitingIdentityRef.current = true;
      addLog('Peer reconnected — verifying identity...', 'info');
    }
    wasDisconnectedRef.current = false;
    return;
  }

  // Peer disconnected - auto-pause active transfers
  wasDisconnectedRef.current = true;
  const isActive = transferState === 'sending' || transferState === 'receiving';

  if (isActive && !isPaused && !autoPausedRef.current) {
    autoPausedRef.current = true;
    addLog('Peer disconnected — auto-pausing transfer', 'warning');
    
    if (isMultiFile) {
      multiTransfer.pauseAll();
    } else {
      pauseTransfer();
    }
    
    // Flush bitmap to IndexedDB
    tracking.trackTransferPause(transferId);
  }
}, [peerDisconnected, transferState]);
```

### In-Room Reconnection Resume

**Hook:** [Room/index.jsx](../src/pages/Room/index.jsx) lines 278-430

When peer reconnects in the same room:

1. Wait for identity handshake to complete
2. Check if `isReturningPeer` (same UUID)
3. If yes, query IndexedDB for `interruptedTransfer`
4. If found, initiate resume handshake:

```javascript
useEffect(() => {
  if (!identityVerified) return;
  if (hasHandledResumeRef.current) return;
  
  if (isReturningPeer && interruptedTransfer) {
    hasHandledResumeRef.current = true;
    
    const resumeCtx = {
      transferId: interruptedTransfer.transferId,
      fileName: interruptedTransfer.fileName,
      fileSize: interruptedTransfer.fileSize,
      totalChunks: interruptedTransfer.totalChunks,
      chunkBitmap: interruptedTransfer.chunkBitmap,
      direction: interruptedTransfer.direction,
      progress: interruptedTransfer.lastProgress,
      inRoom: true,
    };
    
    setResumeContext(resumeCtx);
    
    // useResumeTransfer hook will pick up the context and send resume handshake
  }
}, [identityVerified, isReturningPeer, interruptedTransfer]);
```

### Cross-Session Resume (Home → New Room)

**Flow:**
1. User clicks "Resume" on Home page
2. Home sets `resumeContext` in roomStore
3. Home creates a new room and navigates to Room page
4. Room initializes, picks up `resumeContext`
5. When data channel opens, `useResumeTransfer` sends resume handshake
6. Sender proposes bitmap, receiver validates, responds with `startFromChunk`
7. Transfer resumes from the missing chunk

**Fallback:** If resume times out (5s) or is rejected:
- `useResumeTransfer` sets state to 'timeout' or 'rejected'
- Room's fallback effect clears `resumeContext`
- Room auto-starts a fresh transfer

### Crash Recovery

**Scenario:** Browser crashes mid-transfer

**Recovery:**
1. On restart, user navigates to Home
2. Home queries IndexedDB for `status: 'interrupted'` transfers
3. Home displays resume UI with progress from bitmap
4. User clicks "Resume"
5. Cross-session resume handshake initiated

**Persistence:** Bitmaps are flushed to IndexedDB:
- Every 50 chunks (sender and receiver)
- On pause
- On disconnect
- On page visibility change
- On `beforeunload` event

---

## Security Model

### 1. Shared Secret Generation

**Location:** [Home.jsx](../src/pages/Home.jsx)

```javascript
const secret = await generateSharedSecret(); // 8 bytes, base64 → 11 chars
const peerID = await generatePeerID();       // 6 bytes, base64 → 8 chars

const payload = createSecurityPayload(secret, peerID);
// { secret, peerID, timestamp }

const encodedPayload = btoa(JSON.stringify(payload));
```

### 2. URL Fragment Transmission (Server-Blind)

**Share URL:**
```
https://example.com/{roomId}#{base64(JSON.stringify({secret, peerID, timestamp}))}
```

**Why Fragment?**
- HTTP servers **do not log** URL fragments (the part after `#`)
- Signaling server cannot intercept the secret
- Only the recipient browser can read `window.location.hash`

### 3. AES-GCM Key Derivation

**Location:** [tofuSecurity.js](../src/utils/tofuSecurity.js)

```javascript
async function deriveEncryptionKey(sharedSecret) {
  const secretBytes = new Uint8Array(
    atob(sharedSecret).split('').map(c => c.charCodeAt(0))
  );

  const baseKey = await crypto.subtle.importKey(
    'raw', secretBytes, 'PBKDF2', false, ['deriveKey']
  );

  const salt = new TextEncoder().encode('signaling-encryption');

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
```

**Properties:**
- **PBKDF2** with 100,000 iterations prevents brute-force
- **Dedicated salt** ("signaling-encryption") prevents key reuse
- **AES-GCM-256** provides authenticated encryption

### 4. Encrypted Signaling

**All signaling messages are encrypted:**
- SDP Offer
- SDP Answer
- ICE Candidates

**Encryption:**
```javascript
async function encryptSignaling(plainObject, aesKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce
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
```

**Decryption:**
```javascript
async function decryptSignaling(envelope, aesKey) {
  const iv = new Uint8Array(atob(envelope.iv).split('').map(c => c.charCodeAt(0)));
  const cipherBytes = new Uint8Array(atob(envelope.ciphertext).split('').map(c => c.charCodeAt(0)));

  const plainBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    cipherBytes
  );

  return JSON.parse(new TextDecoder().decode(plainBytes));
}
```

**Security Guarantee:** If decryption fails (wrong key or tampered message), the connection cannot be established. **No explicit TOFU challenge-response is needed** — data channel opening proves shared secret.

### 5. Peer Identity & Session Tracking

**Location:** [identityManager.js](../src/utils/identityManager.js)

**Local UUID:**
- Generated on session start: `crypto.randomUUID()`
- Stored in sessionStorage (cleared on tab close)
- Unique per browser tab

**Peer Session Storage:**
- After successful connection, save peer UUID to IndexedDB:
  ```javascript
  await savePeerSession(peerUUID, roomId);
  // sessions store: { roomId, peerUUID, lastConnected }
  ```
- On reconnection, verify UUID:
  ```javascript
  const isKnownPeer = await verifyPeer(peerUUID, roomId);
  // Returns true if peerUUID matches saved session
  ```

**Auto-Resume Logic:**
```
if (isKnownPeer && interruptedTransfer) {
  // Same peer returned → resume transfer
} else {
  // New peer → reset transfer state
}
```

**Cleanup:** Stale sessions (>24 hours) are auto-deleted on app startup.

---

## Testing Reality

### Current Test Coverage

**Location:** [src/__tests__/](../src/__tests__/)

#### Unit Tests (Actual)

| File | Coverage | Notes |
|------|----------|-------|
| `unit/chunkBitmap.test.js` | Bitmap utilities | ✅ Comprehensive |
| `unit/formatters.test.js` | formatBytes, formatDuration | ✅ Basic coverage |
| `unit/ProgressTracker.test.js` | Progress tracking | ✅ Core scenarios |

**Total:** ~3 unit test files

#### Integration Tests (Actual)

**None.** Despite docs claiming integration tests exist, there are no integration test files in the codebase.

#### E2E Tests (Actual)

**None.**

### Testing Gaps

**Critical Missing Tests:**

| Area | Risk | Impact |
|------|------|--------|
| Transfer engines | High | Core functionality untested |
| Multi-file transfers | High | Complex logic untested |
| Multi-channel transfers | High | Channel pool logic untested |
| Resume handshake | High | Recovery logic untested |
| Encrypted signaling | Critical | Security vulnerability if broken |
| WebRTC connection | High | Connection failures hard to debug |
| IndexedDB repositories | Medium | Data corruption possible |
| File System API | Medium | Disk write failures possible |

**Why No Tests?**
- Transfer engines use callbacks and file streams (hard to mock)
- WebRTC requires real peer connections (no good mocking library)
- IndexedDB tests need browser environment (jsdom insufficient)
- File System API not available in Node.js test environments

**Recommended Test Strategy:**
1. **Unit Tests:** Expand coverage for pure functions (validators, formatters, bitmap utils)
2. **Integration Tests:** Use Playwright/Puppeteer to test WebRTC/IndexedDB in real browser
3. **Manual Testing:** Maintain test scenarios document ([docs/TESTING.md](../docs/TESTING.md))
4. **Smoke Tests:** Automated Playwright tests for critical paths (connect, send file, resume)

---

## Known Inconsistencies & Issues

This section documents discrepancies between documentation and code, likely defects, and architectural debt.

### 1. Documentation Drift

#### Issue: Service Layer Missing

**Docs Say:** [ARCHITECTURE.md](../ARCHITECTURE.md) describes a service layer between UI and transfer engines.

**Reality:** No `/src/services/` directory exists (it's empty). Hooks in [src/pages/Room/hooks/](../src/pages/Room/hooks/) ARE the service layer.

**Impact:** Misleading onboarding. New developers look for services and find nothing.

**Decision Needed:** Update docs to reflect hooks-as-services pattern, or refactor hooks into a dedicated service layer.

---

#### Issue: Room Component Size

**Docs Say:** [flow.md](../flow.md) claims Room is "~200 lines" with "modular components & custom hooks."

**Reality:** [Room/index.jsx](../src/pages/Room/index.jsx) is **851 lines** due to complex resume/reconnection orchestration.

**Impact:** Underestimated complexity. Actual Room is 4x larger than documented.

**Decision Needed:** Either split Room into smaller components or update docs with realistic metrics.

---

#### Issue: Testing Claims

**Docs Say:** [docs/TESTING.md](../docs/TESTING.md) mentions "integration tests" and "hooks coverage."

**Reality:** Only 3 unit test files exist. No integration tests. No hook tests.

**Impact:** False confidence in code quality.

**Decision Needed:** Add tests or remove testing claims from docs.

---

### 2. Likely Defects

#### Issue: Circular Dependency in Resume Flow

**File:** [Room/index.jsx](../src/pages/Room/index.jsx) lines 130-140

**Problem:**
- `useMessages` needs resume callbacks from `useResumeTransfer`
- `useResumeTransfer` needs `sendResumeRequest` from `useMessages`

**Current Workaround:**
```javascript
const resumeCallbacksRef = useRef({ onResumeAccepted: null, onResumeRejected: null });

const { setMultiFileMode, sendResumeRequest } = useMessages(..., resumeCallbacksRef.current);
const resumeFlow = useResumeTransfer({ sendResumeRequest, ... });

// Wire callbacks after both hooks initialized
resumeCallbacksRef.current.onResumeAccepted = resumeFlow.onResumeAccepted;
resumeCallbacksRef.current.onResumeRejected = resumeFlow.onResumeRejected;
```

**Impact:** Fragile initialization order. Easy to break during refactoring.

**Fix:** Extract resume protocol into a dedicated module, inject into both hooks.

---

#### Issue: Duplicate Progress Tracking

**Files:**
- [useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js) lines 38-39
- [ProgressTracker.js](../src/transfer/shared/ProgressTracker.js)

**Problem:** Both `useFileTransfer` local state AND `ProgressTracker` track progress. Room reads from both sources.

**Current Behavior:**
```javascript
// useFileTransfer hook
const [transferProgress, setTransferProgress] = useState(0);
const [transferSpeed, setTransferSpeed] = useState(0);

// Also subscribes to ProgressTracker
progressTracker.subscribe(transferId, (progress) => {
  setTransferProgress(progress.percentage);
  setTransferSpeed(progress.transferSpeed);
});
```

**Impact:** Potential state drift if one source updates without the other.

**Fix:** Remove local state from hook. Always read from ProgressTracker.

---

#### Issue: Message Handler Parameter Mismatch

**File:** [useMessages.js](../src/pages/Room/hooks/useMessages.js) signature

**Expected (from docs):**
```javascript
export function useMessages(dataChannelRef, dataChannelReady, isHost, 
  security, transfer, multiTransfer, uiState, addLog, sendJSON, resumeCallbacks)
```

**Called (from Room):**
```javascript
useMessages(dataChannelRef, dataChannelReady, isHost, security, transfer, 
  multiTransfer, uiState, addLog, sendJSON, resumeCallbacksRef.current, roomId, peerUuid);
// ^^^^ Extra params: roomId, peerUuid
```

**Impact:** Unused parameters pollute the signature. May cause confusion.

**Fix:** Remove `roomId` and `peerUuid` params if unused, or use them for identity verification.

---

#### Issue: transferStore Methods Unused

**File:** [transferStore.js](../src/stores/transferStore.js)

**Methods Defined:**
```javascript
initiateUpload(metadata);
initiateDownload(metadata);
updateProgress(transferId, progress);
completeTransfer(transferId, metadata);
failTransfer(transferId, error);
```

**Reality:** Only `completeTransfer` is called (from `useFileTransfer`). No code calls `initiateUpload`, `initiateDownload`, or `updateProgress`.

**Impact:** Dead code. Store API surface doesn't match usage.

**Fix:** Remove unused methods or add calls from hooks.

---

### 3. Architectural Debt

#### Issue: Multi-File/Single-File Dual Paths

**Files:**
- [useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js)
- [useMultiFileTransfer.js](../src/pages/Room/hooks/useMultiFileTransfer.js)

**Problem:** Two parallel transfer hooks run simultaneously. Room component tracks `isMultiFile` flag and reads from the correct source.

**Impact:**
- Confusing state ownership
- Duplicate code between hooks
- Hard to maintain consistency

**Example:**
```javascript
const transferState = isMultiFile ? multiTransfer.multiTransferState : transfer.transferState;
const transferProgress = isMultiFile ? multiTransfer.overallProgress : transfer.transferProgress;
const transferSpeed = isMultiFile ? multiTransfer.speed : transfer.transferSpeed;
```

**Fix:** Unify into a single `useTransfer` hook that handles both single and multi-file internally.

---

#### Issue: IndexedDB Schema Misalignment

**Files:**
- [client.js](../src/infrastructure/database/client.js) - defines schema
- [transfers.repository.js](../src/infrastructure/database/transfers.repository.js) - uses schema

**Problem:** Schema defines `files` store and `chunks` store, but:
- `files` store is unused (no code writes to it)
- `chunks` store is unused (chunk metadata stored in `transfers.chunkBitmap` field instead)

**Impact:**
- Wasted storage schema
- Confusion about data model

**Fix:** Either use the stores or remove them from schema. Document the decision.

---

#### Issue: WebRTC Perfect Negotiation Incomplete

**File:** [p2pManager.js](../src/utils/p2pManager.js) lines 140-180

**Problem:** Code implements "perfect negotiation" pattern with `isPolite` flag, but rollback logic is incomplete:

```javascript
// Polite peer should rollback local offer on collision
if (offerCollision && isPolite) {
  logger.log('[P2P] Rolling back local offer (polite peer)');
  await peerConnection.setLocalDescription({ type: 'rollback' });
}
```

**Issue:** After rollback, the polite peer doesn't re-attempt connection. Relies on impolite peer to re-send offer.

**Impact:** Connection may stall if impolite peer's offer was lost.

**Fix:** Implement exponential backoff re-attempt for polite peer.

---

### 4. Security Concerns

#### Issue: No HMAC for Chunk Checksums

**Files:**
- [ChunkingEngine.js](../src/transfer/sending/ChunkingEngine.js)
- [AssemblyEngine.js](../src/transfer/receiving/AssemblyEngine.js)

**Problem:** Chunks are SHA-256 checksummed, but checksum is sent over the same channel as data. Attacker could modify both chunk and checksum.

**Current:**
```javascript
const checksum = await crypto.subtle.digest('SHA-256', chunkData);
sendJSON({ type: 'chunk-metadata', checksum });
sendBinary(chunkData);
```

**Impact:** MITM could corrupt chunks without detection (though encrypted signaling makes this unlikely).

**Fix:** Use HMAC-SHA256 with shared secret:
```javascript
const hmac = await crypto.subtle.sign('HMAC', hmacKey, chunkData);
```

---

#### Issue: No File Hash Verification for Resume

**Files:**
- [useResumeTransfer.js](../src/pages/Room/hooks/useResumeTransfer.js)
- Resume protocol

**Problem:** Resume handshake sends `fileHash` but receiver doesn't verify it. If sender modified the file between sessions, receiver might assemble a corrupted file.

**Current:**
```javascript
sendResumeRequest({
  transferId,
  fileName,
  fileSize,
  fileHash, // ❌ Sent but not verified
  chunkBitmap,
});
```

**Impact:** Silent data corruption on resume if file changed.

**Fix:** Receiver should reject resume if `fileHash` doesn't match expected value.

---

### 5. Performance Issues

#### Issue: Bitmap Serialization on Every Chunk (Inefficient)

**File:** [useTransferTracking.js](../src/pages/Room/hooks/useTransferTracking.js)

**Problem:** Bitmap is serialized and written to IndexedDB every 50 chunks. For a 10,000 chunk file (640MB), that's 200 IndexedDB writes.

**Current:**
```javascript
if (++chunkCount % 50 === 0) {
  await updateTransfer(transferId, { 
    chunkBitmap: serializeBitmap(bitmap) // ❌ Heavy serialization
  });
}
```

**Impact:** High CPU and IndexedDB write load during large transfers.

**Fix:** Batch bitmap updates using a debounced flush (e.g., flush on pause or every 5 seconds instead of every 50 chunks).

---

#### Issue: No Chunk De-duplication for Multi-Channel

**File:** [MultiFileTransferManager.js](../src/transfer/multifile/MultiFileTransferManager.js)

**Problem:** When sending chunks across multiple channels, there's no global chunk tracking. If a channel fails and retries, the same chunk might be sent twice on different channels.

**Impact:** Wasted bandwidth and potential duplicate chunk writes.

**Fix:** Implement global chunk-sent tracking in `MultiFileTransferManager`.

---

### 6. UX/Usability Issues

#### Issue: Resume Timeout Too Short

**File:** [useResumeTransfer.js](../src/pages/Room/hooks/useResumeTransfer.js) line 52

**Current:**
```javascript
timeoutRefRef.current = setTimeout(() => {
  setResumeState('timeout');
  addLog('Resume timeout. Starting fresh transfer instead...', 'warning');
  clearResumeContext();
}, 5000); // ❌ 5 seconds
```

**Problem:** 5 seconds is too short. On slow connections, the resume handshake may not complete in time.

**Impact:** Users see resume fail unnecessarily and restart transfers.

**Fix:** Increase to 15-30 seconds, or make configurable.

---

#### Issue: No Progress Indication During Resume

**Problem:** When resume handshake is in progress, UI shows no indication. Users don't know if the app is frozen or working.

**Impact:** Poor UX. Users may close the tab thinking it's broken.

**Fix:** Add "Negotiating resume..." spinner during `resumeState === 'proposing'`.

---

#### Issue: File Re-selection Required on Receiver Resume

**File:** [Room/index.jsx](../src/pages/Room/index.jsx) lines 386-410

**Problem:** Due to browser security, receiver must re-select the file to resume (File System Access API handles are not persistent across sessions).

**Current Flow:**
1. Resume handshake completes
2. App prompts: "Please select the file to resume receiving..."
3. User must navigate and select the exact same file

**Impact:** Confusing UX. Users don't understand why they need to re-select.

**Fix:** Add clear UI explanation: "Your browser requires you to select the file again for security reasons."

---

### Summary Table

| Category | Issue | Severity | Fix Priority |
|----------|-------|----------|--------------|
| **Documentation** | Service layer missing | Low | P3 - Update docs |
| **Documentation** | Room component size mismatch | Low | P3 - Update docs |
| **Documentation** | Testing claims false | Medium | P2 - Add tests or remove claims |
| **Architecture** | Circular dependency (resume) | Medium | P2 - Refactor |
| **Architecture** | Duplicate progress tracking | Medium | P2 - Consolidate |
| **Architecture** | Dual transfer paths | High | P1 - Unify hooks |
| **Code Quality** | Unused transferStore methods | Low | P3 - Remove |
| **Code Quality** | Unused IndexedDB schema | Low | P3 - Clean up |
| **Reliability** | Perfect negotiation incomplete | High | P1 - Fix rollback |
| **Security** | No HMAC for chunks | Medium | P2 - Add HMAC |
| **Security** | No file hash verification | High | P1 - Verify on resume |
| **Performance** | Inefficient bitmap serialization | Medium | P2 - Debounce |
| **Performance** | No chunk de-duplication | Low | P3 - Add tracking |
| **UX** | Resume timeout too short | Low | P3 - Increase |
| **UX** | No resume progress indicator | Medium | P2 - Add spinner |
| **UX** | Confusing file re-selection | Medium | P2 - Improve messaging |

---

## Appendix: Key File References

### Critical Runtime Files (Top 20)

1. [src/main.jsx](../src/main.jsx) - App entry point, IndexedDB init
2. [src/App.jsx](../src/App.jsx) - Router setup
3. [src/pages/Home.jsx](../src/pages/Home.jsx) - File selection, resume detection, room creation
4. [src/pages/Room/index.jsx](../src/pages/Room/index.jsx) - Transfer orchestration (851 lines)
5. [src/pages/Room/hooks/useRoomConnection.js](../src/pages/Room/hooks/useRoomConnection.js) - WebRTC lifecycle
6. [src/pages/Room/hooks/useSecurity.js](../src/pages/Room/hooks/useSecurity.js) - Security verification
7. [src/pages/Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js) - Single-file transfer
8. [src/pages/Room/hooks/useMultiFileTransfer.js](../src/pages/Room/hooks/useMultiFileTransfer.js) - Multi-file transfer
9. [src/pages/Room/hooks/useMessages.js](../src/pages/Room/hooks/useMessages.js) - Message protocol router
10. [src/pages/Room/hooks/useResumeTransfer.js](../src/pages/Room/hooks/useResumeTransfer.js) - Resume handshake
11. [src/transfer/sending/ChunkingEngine.js](../src/transfer/sending/ChunkingEngine.js) - File chunking
12. [src/transfer/receiving/AssemblyEngine.js](../src/transfer/receiving/AssemblyEngine.js) - Chunk assembly
13. [src/transfer/shared/ProgressTracker.js](../src/transfer/shared/ProgressTracker.js) - Progress tracking
14. [src/transfer/multifile/MultiFileTransferManager.js](../src/transfer/multifile/MultiFileTransferManager.js) - Multi-file sender
15. [src/transfer/multifile/MultiFileReceiver.js](../src/transfer/multifile/MultiFileReceiver.js) - Multi-file receiver
16. [src/transfer/multichannel/ChannelPool.js](../src/transfer/multichannel/ChannelPool.js) - Multi-channel management
17. [src/utils/signaling.js](../src/utils/signaling.js) - Socket.IO client, encrypted signaling
18. [src/utils/p2pManager.js](../src/utils/p2pManager.js) - WebRTC peer connection
19. [src/utils/tofuSecurity.js](../src/utils/tofuSecurity.js) - AES-GCM encryption/decryption
20. [src/infrastructure/database/transfers.repository.js](../src/infrastructure/database/transfers.repository.js) - Transfer persistence

---

## Conclusion

This codebase implements a sophisticated P2P file transfer system with multi-file support, multi-channel bandwidth optimization, encrypted signaling, and robust resume capabilities. The architecture has evolved beyond the original documentation, with hooks serving as the primary orchestration layer instead of a traditional service layer.

Key strengths:
- ✅ Clean layered architecture (despite doc drift)
- ✅ Encrypted signaling prevents MITM attacks
- ✅ Bitmap-based resume survives crashes
- ✅ Multi-channel transfers optimize bandwidth
- ✅ Direct disk writes minimize memory usage

Key weaknesses:
- ❌ Documentation significantly outdated
- ❌ Minimal test coverage (<5%)
- ❌ Architectural debt (dual transfer paths, circular dependencies)
- ❌ Some security gaps (no HMAC, no file hash verification on resume)

**Recommendation for new developers:** Read this document first, then skim existing docs for theoretical context. Refer to code as the source of truth for runtime behavior.

**Recommendation for maintainers:** Prioritize P1 issues (unify transfer hooks, fix perfect negotiation, add file hash verification) before adding new features.
