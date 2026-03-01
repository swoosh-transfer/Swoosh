# Swoosh - Complete Project Flow Documentation

> **📖 Note:** This document provides detailed implementation flows. For a quick introduction, see:
> - **[docs/NEW_DEVELOPER_GUIDE.md](docs/NEW_DEVELOPER_GUIDE.md)** - 30-minute onboarding guide
> - **[docs/TRANSFER_FLOW.md](docs/TRANSFER_FLOW.md)** - Transfer lifecycle with sequence diagrams
> - **[docs/DEBUGGING.md](docs/DEBUGGING.md)** - Troubleshooting guide
> - **[ARCHITECTURE.md](ARCHITECTURE.md)** - Architectural overview

## 📋 Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture Overview](#architecture-overview)
3. [Technology Stack](#technology-stack)
4. [Application Flow](#application-flow)
5. [Core Components](#core-components)
6. [Detailed Flow Diagrams](#detailed-flow-diagrams)
7. [Security Implementation](#security-implementation)
8. [Data Flow](#data-flow)
9. [State Management](#state-management)
10. [File System & Storage](#file-system--storage)
11. [Error Handling & Recovery](#error-handling--recovery)

---

## 🎯 Project Overview

**Swoosh** is a secure, browser-based peer-to-peer file transfer application that enables direct file transfers between devices without server storage. It supports:

- **Large Files**: 50GB+ file transfers
- **Direct P2P**: WebRTC DataChannel for peer-to-peer communication
- **Security**: TOFU (Trust On First Use) authentication
- **Resume Capability**: Pause/resume and crash recovery
- **Direct Disk Writing**: File System Access API for memory efficiency
- **Real-time Progress**: Live tracking with speed and ETA

---

## 🏗️ Architecture Overview

Swoosh uses a **layered architecture** with clear separation of concerns:

```
┌───────────────────────────────────────────────────────────────┐
│                        UI Layer (React)                        │
│  pages/Room/ - Modular components & custom hooks (~200 lines) │
│  └── hooks/ - useRoomConnection, useFileTransfer, useSecurity │
└────────────────────────────┬──────────────────────────────────┘
                             ↓
┌───────────────────────────────────────────────────────────────┐
│                    Transfer Layer (Domain)                     │
│  • ChunkingEngine - File splitting & buffering                │
│  • AssemblyEngine - Chunk validation & assembly               │
│  • ProgressTracker - Single source of truth for progress      │
│  • ResumableTransferManager - Pause/resume logic              │
│  • MultiFileTransferManager - Multi-file orchestration        │
│  • ChannelPool - Multi-channel bandwidth management           │
└────────────────────────────┬──────────────────────────────────┘
                             ↓
┌───────────────────────────────────────────────────────────────┐
│                 Infrastructure Layer (Data & I/O)              │
│  • Database Repositories - IndexedDB access                   │
│  • FileWriter - File System API wrapper                       │
│  • Storage Layer - Persistent data management                 │
└───────────────────────────────────────────────────────────────┘
```

### Peer-to-Peer Communication Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Browser Environment                       │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────────┐          WebRTC           ┌─────────────┐  │
│  │   Sender    │◄──────────────────────────►│  Receiver   │  │
│  │             │      DataChannel           │             │  │
│  │ ┌─────────┐ │                           │ ┌─────────┐ │  │
│  │ │ File    │ │                           │ │ File    │ │  │
│  │ │ System  │ │                           │ │ System  │ │  │
│  │ │ API     │ │                           │ │ API     │ │  │
│  │ └─────────┘ │                           │ └─────────┘ │  │
│  │             │                           │             │  │
│  │ ┌─────────┐ │                           │ ┌─────────┐ │  │
│  │ │Chunking │ │                           │ │Assembly │ │  │
│  │ │Engine   │ │                           │ │Engine   │ │  │
│  │ └─────────┘ │                           │ └─────────┘ │  │
│  │             │                           │             │  │
│  │ ┌─────────┐ │                           │ ┌─────────┐ │  │
│  │ │ SHA256  │ │                           │ │ SHA256  │ │  │
│  │ │ Hasher  │ │                           │ │Verifier │ │  │
│  │ └─────────┘ │                           │ └─────────┘ │  │
│  │             │                           │             │  │
│  │ ┌─────────┐ │                           │ ┌─────────┐ │  │
│  │ │IndexedDB│ │                           │ │IndexedDB│ │  │
│  │ │ (Meta)  │ │                           │ │ (Meta)  │ │  │
│  │ └─────────┘ │                           │ └─────────┘ │  │
│  │             │                           │             │  │
│  │ ┌─────────┐ │                           │ ┌─────────┐ │  │
│  │ │ Zustand │ │                           │ │ Zustand │ │  │
│  │ │  Store  │ │                           │ │  Store  │ │  │
│  │ └─────────┘ │                           │ └─────────┘ │  │
│  └─────────────┘                           └─────────────┘  │
│         │                                          │         │
│         │         Socket.IO Signaling Server       │         │
│         └──────────────────┬───────────────────────┘         │
│                            │                                 │
│                    ┌───────▼────────┐                        │
│                    │  Signaling     │                        │
│                    │  Server        │                        │
│                    │  (WebSocket)   │                        │
│                    └────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

**📖 For detailed architecture information, see [ARCHITECTURE.md](ARCHITECTURE.md)**

---

## 💻 Technology Stack

### Frontend Framework
- **React 19.2.0** - UI library
- **React Router DOM 7.13.0** - Client-side routing
- **Vite 7.2.4** - Build tool and dev server

### Styling
- **Tailwind CSS 4.1.18** - Utility-first CSS framework
- Custom dark theme with zinc color palette

### State Management
- **Zustand 5.0.10** - Lightweight state management
  - `roomStore.js` - Room and connection state
  - `transferStore.js` - Transfer progress and history

### Communication
- **Socket.IO Client 4.8.3** - Signaling server communication
- **WebRTC** - Peer-to-peer data channels

### Storage & APIs
- **IndexedDB** - Transfer metadata persistence
- **File System Access API** - Direct disk writing
- **Web Crypto API** - Security and hashing

---

## 🔄 Application Flow

### 1. Initial Setup Flow

```
App Startup
    │
    ├──► Initialize IndexedDB
    │    └──► Create stores: transfers, files, chunks, sessions
    │
    ├──► Load React App
    │    └──► BrowserRouter with Routes
    │         ├──► "/" → Home Page
    │         └──► "/:roomId" → Room Page
    │
    └──► Ready for user interaction
```

### 2. Host (Sender) Flow

```
Home Page
    │
    ├──► User selects file
    │    └──► Store in fileInputRef
    │
    ├──► User clicks "Start Transfer"
    │    │
    │    ├──► 1. Initialize Socket Connection
    │    │    └──► Connect to signaling server
    │    │
    │    ├──► 2. Create TOFU Security Setup
    │    │    ├──► Generate 32-byte secret
    │    │    ├──► Generate peer ID
    │    │    └──► Create security payload
    │    │
    │    ├──► 3. Create Room on Signaling Server
    │    │    └──► Receive unique room ID
    │    │
    │    ├──► 4. Store State in Zustand
    │    │    ├──► setSelectedFile(file)
    │    │    ├──► setIsHost(true)
    │    │    ├──► setRoomId(roomId)
    │    │    └──► setSecurityPayload({secret, peerID})
    │    │
    │    └──► 5. Navigate to Room
    │         └──► URL: /:roomId#base64({secret, peerID, timestamp})
    │
    └──► Room Page (Host)
         │
         ├──► Parse security from URL hash
         │
         ├──► Initialize WebRTC
         │    ├──► Create RTCPeerConnection
         │    ├──► Set as impolite peer (isPolite = false)
         │    └──► Setup ICE candidate handling
         │
         ├──► Create DataChannel
         │    └──► Channel: "file-transfer" (reliable, ordered)
         │
         ├──► Wait for peer to join
         │    └──► Listen for "peer-joined" event
         │
         ├──► When peer joins:
         │    ├──► Generate offer
         │    ├──► Set local description
         │    └──► Send offer via signaling
         │
         ├──► Handle answer from peer
         │    └──► Set remote description
         │
         ├──► Encrypted Signaling Verification
         │    ├──► Derive AES-GCM key from shared URL-fragment secret
         │    ├──► Exchange encrypted identity (UUID)
         │    ├──► Verify peer UUID against IndexedDB sessions
         │    └──► Save peer session
         │
         ├──► Wait for peer verification
         │    └──► Peer sends "tofu-verified"
         │
         ├──► Start File Transfer
         │    ├──► Initialize ChunkingEngine
         │    ├──► Create file metadata
         │    ├──► Send metadata to peer
         │    ├──► Start chunking loop
         │    │    ├──► Read 16KB from file
         │    │    ├──► Buffer to 64KB storage chunks
         │    │    ├──► Calculate SHA-256 hash
         │    │    ├──► Send chunk metadata (JSON)
         │    │    ├──► Send chunk data (binary)
         │    │    ├──► Save metadata to IndexedDB
         │    │    └──► Repeat until complete
         │    └──► Monitor progress
         │         ├──► Calculate speed
         │         ├──► Calculate ETA
         │         └──► Update UI
         │
         └──► Transfer Complete
              ├──► Send completion message
              └──► Display success UI
```

### 3. Guest (Receiver) Flow

```
Receive Share Link
    │
    ├──► User opens link: /:roomId#securityPayload
    │
    └──► Room Page (Guest)
         │
         ├──► Parse URL
         │    ├──► Extract roomId from path
         │    └──► Extract security from hash
         │         ├──► Decode base64
         │         └──► Parse JSON {secret, peerID, timestamp}
         │
         ├──► Initialize Socket
         │    └──► Connect to signaling server
         │
         ├──► Join Room
         │    └──► Emit "join-room" with roomId
         │
         ├──► Initialize WebRTC
         │    ├──► Create RTCPeerConnection
         │    ├──► Set as polite peer (isPolite = true)
         │    └──► Setup ICE candidate handling
         │
         ├──► Receive Offer from host
         │    ├──► Set remote description
         │    ├──► Generate answer
         │    ├──► Set local description
         │    └──► Send answer via signaling
         │
         ├──► DataChannel established
         │    └──► Listen for ondatachannel event
         │
         ├──► Encrypted Signaling Verification
         │    ├──► Derive AES-GCM key from shared URL-fragment secret
         │    ├──► Exchange encrypted identity (UUID)
         │    ├──► verifyPeer(peerUUID, roomId) against IndexedDB
         │    ├──► If returning peer with interrupted transfer → auto-resume
         │    └──► Save peer session to IndexedDB
         │
         ├──► Receive File Metadata
         │    ├──► Display file info (name, size)
         │    └──► Wait for user acceptance
         │
         ├──► User accepts file
         │    ├──► Trigger File System Access API
         │    ├──► showSaveFilePicker()
         │    ├──► Create writable stream
         │    └──► Send "ready" signal
         │
         ├──► Receive File Transfer
         │    ├──► Initialize FileReceiver
         │    ├──► Register transfer in resumableTransferManager
         │    ├──► Receive chunks
         │    │    ├──► Receive metadata (JSON)
         │    │    ├──► Receive binary data
         │    │    ├──► Verify SHA-256 hash
         │    │    ├──► Buffer out-of-order chunks
         │    │    ├──► Write chunks sequentially to disk
         │    │    └──► Save metadata to IndexedDB
         │    └──► Monitor progress
         │         ├──► Calculate speed
         │         ├──► Calculate ETA
         │         └──► Update UI
         │
         └──► Transfer Complete
              ├──► Close writable stream
              ├──► Verify file integrity
              └──► Display success UI
```

---

## 🔧 Core Components

### 1. Pages

#### **Home.jsx** - Landing/File Selection Page
**Purpose**: Initial file selection and room creation for host

**Key Features**:
- File input with drag-and-drop UI
- File size formatting
- Room creation trigger
- Loading and error states

**Flow**:
1. User selects file
2. Click "Start Transfer"
3. Initialize socket
4. Create TOFU security
5. Create room
6. Navigate to room with security in URL hash

#### **Room.jsx** - Main Transfer Room
**Purpose**: Core P2P connection and file transfer logic

**Key Responsibilities**:
- WebRTC connection management
- TOFU security verification
- File chunking and assembly
- Progress tracking
- Pause/resume control
- Crash recovery detection

**State Management**:
- Uses both Zustand stores (roomStore, transferStore)
- Local state for UI (logs, connection info, transfer states)
- Refs for chunking engine, data channel, HMAC keys

**Key Features**:
- Dual role support (host/guest)
- Perfect negotiation pattern for WebRTC
- Challenge-response authentication
- Real-time connection monitoring
- Activity logging

### 2. UI Components (RoomUI.jsx)

#### **StatusSection**
- Socket connection status
- P2P connection status
- TOFU verification status
- Animated indicators

#### **FileInfo**
- File name display
- File size formatting
- File icon

#### **TransferProgress**
- Progress bar
- Percentage display
- Transfer speed
- ETA calculation

#### **TransferProgressWithControls**
- Enhanced progress with pause/resume
- Pause/resume button
- Cancel button
- State-aware styling

#### **ShareUrlBox**
- Room URL display
- Copy to clipboard
- QR code generation (toggleable)
- QR code scanning support

#### **IncomingFilePrompt**
- File acceptance UI
- File metadata display
- Save location selector

#### **TransferComplete**
- Success indicator
- Download button (fallback)
- Completion status

#### **PauseResumeButton**
- Minimal icon-only design
- Play/pause toggle
- Disabled state handling

#### **CrashRecoveryPrompt**
- Detects incomplete transfers
- Resume/discard options
- Transfer info display

### 3. State Management

#### **roomStore.js** (Zustand)
**Purpose**: Room and connection state management

**State**:
- `roomId` - Current room identifier
- `isHost` - Whether user created the room
- `securityPayload` - TOFU security data
- `peerConnected` - P2P connection status
- `dataChannelReady` - DataChannel open status
- `tofuVerified` - Security verification status
- `connectionState` - Overall connection state
- `selectedFile` - File to transfer
- `transferState` - Current transfer phase
- `transferProgress` - Progress percentage
- `transferSpeed` - Bytes per second
- `error` - Error messages

**Actions**:
- Setters for all state properties
- `resetRoom()` - Clear all state

#### **transferStore.js** (Zustand + Persist)
**Purpose**: Transfer operations and history tracking

**State**:
- `activeTransfers` - Currently running transfers
- `uploadProgress` - Upload progress by transferId
- `downloadProgress` - Download progress by transferId
- `transferHistory` - Completed transfers
- `recoverableTransfers` - Crashes/paused transfers

**Actions**:
- `initiateUpload()` - Start new upload
- `initiateDownload()` - Start new download
- `updateUploadProgress()` - Update upload metrics
- `updateDownloadProgress()` - Update download metrics
- `pauseTransfer()` - Pause active transfer
- `resumeTransfer()` - Resume paused transfer
- `cancelTransfer()` - Cancel transfer
- `completeTransfer()` - Mark as complete
- `getRecoverableTransfers()` - Get crash recovery list

**Persistence**:
- Uses Zustand persist middleware
- Stores to localStorage
- Enables crash recovery

---

## 📊 Detailed Flow Diagrams

### WebRTC Connection Establishment

```
Host (Impolite)                 Signaling Server              Guest (Polite)
      │                                │                            │
      ├─────── create-room ───────────►│                            │
      │                                │                            │
      │◄─────── room-created ──────────┤                            │
      │        (roomId)                │                            │
      │                                │                            │
      │                                │◄────── join-room ──────────┤
      │                                │        (roomId)            │
      │                                │                            │
      │◄────── peer-joined ────────────┤                            │
      │                                │                            │
      ├── createDataChannel()          │                            │
      ├── createOffer()                │                            │
      ├── setLocalDescription()        │                            │
      │                                │                            │
      ├──────── offer ────────────────►│                            │
      │                                │                            │
      │                                ├───────── offer ───────────►│
      │                                │                            │
      │                                │         setRemoteDesc() ◄──┤
      │                                │         createAnswer() ◄───┤
      │                                │         setLocalDesc() ◄───┤
      │                                │                            │
      │                                │◄───────── answer ──────────┤
      │                                │                            │
      │◄────── answer ─────────────────┤                            │
      │                                │                            │
      ├── setRemoteDescription()       │                            │
      │                                │                            │
      ├──── ICE candidates ───────────►│                            │
      │                                ├──── ICE candidates ───────►│
      │                                │                            │
      │◄──── ICE candidates ───────────┤◄──── ICE candidates ───────┤
      │                                │                            │
      ├═══════════ DataChannel Connected ═════════════════════════►│
      │                                │                            │
```

### Encrypted Signaling & Identity Verification

Swoosh uses **encrypted signaling** rather than challenge-response. The shared secret
(passed via URL fragment) is used to derive an AES-GCM-256 key via PBKDF2. All
signaling messages (offers, answers, ICE candidates) are encrypted end-to-end so the
signaling server cannot read them. Identity is verified by exchanging UUIDs over the
encrypted channel; returning peers are recognised by matching their UUID against
the IndexedDB `sessions` store.

```
Host                                                        Guest
  │                                                           │
  │           DataChannel / Encrypted Signaling                │
  │◄══════════════════════════════════════════════════════════│
  │                                                           │
  │  Derive AES-GCM key from URL-fragment secret (PBKDF2)     │
  ├─► encryptSignaling(message, aesKey)                      │
  │                                                           │
  │  Exchange encrypted identity (UUID)                       │
  │◄══════════════════════════════════════════════════════════►│
  │                                                           │
  │  verifyPeer(peerUUID, roomId) → check IndexedDB sessions │
  ├─► isReturningPeer = true/false                           │
  │                                                           │
  ├─► savePeerSession(peerUUID, roomId)                      ├─► savePeerSession(peerUUID, roomId)
  │                                                           │
  │              Ready for File Transfer                      │
  │  (if returning peer with interrupted transfer → auto-resume)
  │                                                           │
```

### File Transfer - Chunking Loop (Sender)

```
┌─────────────────────────────────────────────────────────┐
│            ChunkingEngine - Sender Side                 │
└─────────────────────────────────────────────────────────┘

File → FileReader.getReader()
  │
  ├──► Loop: Read 16KB chunks
  │     │
  │     ├──► Append to 64KB storage buffer
  │     │
  │     ├──► When buffer full (64KB):
  │     │     │
  │     │     ├──► Calculate SHA-256 hash
  │     │     │
  │     │     ├──► Create chunk metadata:
  │     │     │    {
  │     │     │      transferId,
  │     │     │      chunkIndex,
  │     │     │      checksum (SHA-256),
  │     │     │      size
  │     │     │    }
  │     │     │
  │     │     ├──► Save metadata to IndexedDB
  │     │     │
  │     │     ├──► Send metadata (JSON) via DataChannel
  │     │     │
  │     │     ├──► Send chunk data (binary) via DataChannel
  │     │     │
  │     │     ├──► Wait for buffer drain (backpressure)
  │     │     │
  │     │     ├──► Update progress
  │     │     │
  │     │     └──► Clear buffer, increment chunkIndex
  │     │
  │     ├──► Check if paused
  │     │     └──► If paused, wait for resume signal
  │     │
  │     └──► Continue until file complete
  │
  └──► Flush final partial buffer
        │
        └──► Send transfer-complete message
```

### File Transfer - Assembly Loop (Receiver)

```
┌─────────────────────────────────────────────────────────┐
│            FileReceiver - Receiver Side                 │
└─────────────────────────────────────────────────────────┘

DataChannel.onmessage
  │
  ├──► Receive chunk metadata (JSON)
  │     │
  │     ├──► Parse: { chunkIndex, checksum, size }
  │     │
  │     ├──► Store in pendingChunks map
  │     │
  │     └──► Wait for binary data
  │
  ├──► Receive chunk data (binary ArrayBuffer)
  │     │
  │     ├──► Calculate SHA-256 hash
  │     │
  │     ├──► Verify hash matches metadata.checksum
  │     │     │
  │     │     ├──► If valid:
  │     │     │     │
  │     │     │     ├──► Mark as validated
  │     │     │     ├──► Add to receivedChunks map
  │     │     │     └──► Save metadata to IndexedDB
  │     │     │
  │     │     └──► If invalid:
  │     │           └──► Request re-send
  │     │
  │     ├──► Add to write queue
  │     │
  │     ├──► Process write queue (sequential)
  │     │     │
  │     │     ├──► While nextExpectedChunk is available:
  │     │     │     │
  │     │     │     ├──► Get chunk from queue
  │     │     │     │
  │     │     │     ├──► Write to FileSystemWritableStream
  │     │     │     │    (sequential append, no position)
  │     │     │     │
  │     │     │     ├──► Update bytesWritten
  │     │     │     │
  │     │     │     ├──► Increment nextExpectedChunk
  │     │     │     │
  │     │     │     └──► Update progress
  │     │     │
  │     │     └──► Out-of-order chunks buffered
  │     │
  │     ├──► Check if paused
  │     │     └──► If paused, buffer chunks but don't write
  │     │
  │     └──► Continue until all chunks received
  │
  └──► On transfer complete:
        │
        ├──► Close writable stream
        ├──► Verify total chunks received
        └──► Display success
```

### Pause/Resume Flow

```
User clicks Pause                User clicks Resume
       │                                │
       ├──► Host/Guest                  ├──► Host/Guest
       │                                │
       ├──► Call pause()                ├──► Call resume()
       │                                │
       ├──► ChunkingEngine:             ├──► ChunkingEngine:
       │    │                           │    │
       │    ├─► Set isPaused = true     │    ├─► Set isPaused = false
       │    │                           │    │
       │    ├─► Save state to           │    ├─► Load state from
       │    │   IndexedDB               │    │   IndexedDB
       │    │                           │    │
       │    └─► Stop sending chunks     │    └─► Resume from lastChunk
       │                                │
       ├──► FileReceiver:               ├──► FileReceiver:
       │    │                           │    │
       │    ├─► Set isPaused = true     │    ├─► Set isPaused = false
       │    │                           │    │
       │    ├─► Buffer incoming chunks  │    ├─► Process buffered chunks
       │    │                           │    │
       │    └─► Stop writing to disk    │    └─► Resume writing
       │                                │
       ├──► Send pause signal           ├──► Send resume signal
       │    to peer                     │    to peer
       │                                │
       └──► Update UI                   └──► Update UI
            (show paused state)              (show active state)
```

### Crash Recovery Flow

```
Browser Crash/Close
       │
       ├──► IndexedDB persists:
       │    ├─► Transfer metadata
       │    ├─► Chunk metadata
       │    ├─► File metadata
       │    └─► Session data
       │
       └──► State lost from memory
```

```
Browser Reopens
       │
       ├──► App initializes
       │
       ├──► Check sessionStorage for UUID
       │    └──► Not found (new tab session)
       │
       ├──► Generate new session UUID
       │
       ├──► Query IndexedDB for transfers
       │    with status = 'active' or 'paused'
       │
       ├──► If found:
       │    │
       │    ├──► Display CrashRecoveryPrompt
       │    │    ├─► Transfer info
       │    │    ├─► Progress at crash
       │    │    └─► Options: Resume / Discard
       │    │
       │    └──► User chooses:
       │         │
       │         ├──► Resume:
       │         │    ├─► Reconnect to room
       │         │    ├─► Re-establish P2P
       │         │    ├─► TOFU re-verification
       │         │    ├─► Resume from lastChunk
       │         │    └─► Continue transfer
       │         │
       │         └──► Discard:
       │              └─► Delete metadata from IndexedDB
       │
       └──► Normal flow
```

---

## 🔒 Security Implementation

### TOFU (Trust On First Use) Architecture

**Concept**: Security established on first connection, then verified on subsequent connections.

#### 1. Secret Generation
```javascript
generateSharedSecret()
  ├──► Generate 32 random bytes
  ├──► Use crypto.getRandomValues()
  └──► Encode to base64
```

#### 2. Peer ID Generation
```javascript
generatePeerID()
  ├──► Generate 16 random bytes
  ├──► Use crypto.getRandomValues()
  └──► Encode to base64
```

#### 3. URL Fragment Security
```javascript
URL Structure:
https://swoosh.app/:roomId#base64({
  secret: "...",      // 32-byte secret
  peerID: "...",      // 16-byte peer ID
  timestamp: 1234567  // Creation timestamp
})

Benefits:
  ├──► Fragment never sent to server
  ├──► Client-side only parsing
  ├──► Server-blind security
  └──► URL shareable via QR/clipboard
```

#### 4. HMAC Key Derivation
```javascript
deriveHMACKey(secret)
  ├──► Import secret as base key
  ├──► Use PBKDF2 algorithm
  │    ├─► Salt: "p2p-verification"
  │    ├─► Iterations: 100,000
  │    └─► Hash: SHA-256
  └──► Return HMAC-SHA256 key
```

#### 5. Encrypted Signaling Protocol
```javascript
Both Peers:
  ├──► Derive AES-GCM-256 key from shared secret via PBKDF2
  ├──► Encrypt all signaling messages (offers, answers, ICE candidates)
  ├──► Decrypt incoming signaling messages
  └──► Server cannot read signaling traffic

Identity Verification:
  ├──► Exchange UUID over encrypted channel
  ├──► Compare UUID against IndexedDB sessions store
  ├──► If match → returning peer (auto-resume eligible)
  └──► Save/update peer session in IndexedDB
```

#### 6. Session Persistence
```javascript
savePeerSession(peerUUID, roomId)
  ├──► Store in IndexedDB "sessions" store
  ├──► Key by roomId (scoped verification)
  └──► Record: { roomId, peerUUID, lastConnected }

verifyPeer(peerUUID, roomId)
  ├──► Query IndexedDB by roomId
  ├──► Compare stored peerUUID with current
  └──► Return true if match (verified session)
```

### Cryptographic Operations

#### SHA-256 Hashing (Chunk Verification)
```javascript
calculateChunkHash(chunk)
  ├──► Use Web Crypto API
  ├──► crypto.subtle.digest('SHA-256', chunk)
  ├──► Convert to hex string
  └──► Store with chunk metadata
```

#### Security Guarantees
1. **Man-in-the-Middle Protection**: Encrypted signaling via AES-GCM-256 derived from shared secret
2. **Data Integrity**: SHA-256 per-chunk verification
3. **Server-Blind**: Security payload in URL fragment; signaling encrypted end-to-end
4. **Session Persistence**: IndexedDB session store with UUID verification
5. **Secure Context Only**: HTTPS or localhost required
6. **In-Room Reconnection**: Returning peers auto-identified via UUID; interrupted transfers auto-resume

---

## 📡 Data Flow

### Signaling Flow (Socket.IO)

```
Events from Client to Server:
  ├──► "create-room"
  ├──► "join-room" { roomId }
  ├──► "offer" { offer, roomId }
  ├──► "answer" { answer, roomId }
  └──► "ice-candidate" { candidate, roomId }

Events from Server to Client:
  ├──► "room-created" { roomId }
  ├──► "peer-joined"
  ├──► "offer" { offer }
  ├──► "answer" { answer }
  ├──► "ice-candidate" { candidate }
  ├──► "peer-disconnected"
  └──► "error" { message }
```

### WebRTC DataChannel Messages

```javascript
Message Types (JSON):

1. File Transfer Messages:
   ├──► { type: "file-metadata", ...metadata }
   ├──► { type: "chunk-meta", transferId, chunkIndex, checksum, size }
   ├──► { type: "transfer-complete", transferId }
   └──► { type: "transfer-error", error }

2. TOFU Security Messages:
   ├──► { type: "identity", uuid, roomId }
   ├──► { type: "identity-ack" }
   └──► (signaling messages encrypted via AES-GCM-256)

3. Control Messages:
   ├──► { type: "pause", transferId, lastChunk }
   ├──► { type: "resume", transferId, fromChunk }
   ├──► { type: "cancel", transferId }
   ├──► { type: "resync", transferId, fromChunk }
   └──► { type: "ready" }

4. Binary Data:
   └──► ArrayBuffer (chunk data)
```

### Message Ordering

```
DataChannel Configuration:
  ├──► reliable: true  (guaranteed delivery)
  ├──► ordered: true   (maintain order)
  └──► maxRetransmits: unlimited

Chunk Transmission:
  1. Send chunk metadata (JSON)
  2. Send chunk binary data (ArrayBuffer)
  3. Wait for backpressure drain
  4. Repeat

Receiver Handling:
  ├──► Queue metadata by chunkIndex
  ├──► Match binary data to metadata
  ├──► Buffer out-of-order chunks
  └──► Write sequentially to disk
```

---

## 🗄️ File System & Storage

### IndexedDB Schema

```javascript
Database: "P2PFileTransfer"
Version: 5

Stores:
  1. transfers
     ├──► keyPath: "transferId"
     └──► Fields:
          ├─► transferId (string)
          ├─► role (sender/receiver)
          ├─► fileName (string)
          ├─► fileSize (number)
          ├─► totalChunks (number)
          ├─► status (pending/active/paused/completed/failed)
          ├─► chunksProcessed (number)
          ├─► bytesProcessed (number)
          ├─► lastChunkIndex (number)
          ├─► createdAt (timestamp)
          ├─► updatedAt (timestamp)
          ├─► pausedAt (timestamp)
          └─► resumedAt (timestamp)

  2. files
     ├──► keyPath: "fileId"
     └──► Fields:
          ├─► fileId (string)
          ├─► name (string)
          ├─► size (number)
          ├─► type (string)
          ├─► hash (SHA-256)
          └─► lastModified (timestamp)

  3. chunks
     ├──► keyPath: ["transferId", "chunkIndex"]
     ├──► Indexes:
     │    ├─► "transferId" (non-unique)
     │    └─► "status" (non-unique)
     └──► Fields:
          ├─► transferId (string)
          ├─► chunkIndex (number)
          ├─► checksum (SHA-256)
          ├─► size (number)
          ├─► status (pending/validated/written)
          └─► timestamp (number)

  4. sessions
     ├──► keyPath: "roomId"
     └──► Fields:
          ├─► roomId (string)
          ├─► peerUuid (string)
          └─► lastConnected (timestamp)
```

### File System Access API

```javascript
Usage Flow:

1. Request File Handle:
   showSaveFilePicker({
     suggestedName: fileName,
     types: [{ description: 'All Files', accept: { '*/*': [] } }]
   })
   └──► Returns FileSystemFileHandle

2. Create Writable Stream:
   handle.createWritable({ keepExistingData: false })
   └──► Returns FileSystemWritableFileStream

3. Write Operations:
   Sequential Writes (Recommended):
   ├──► writable.write(chunk)  // Append mode
   ├──► No position parameter
   └──► Avoids state caching issues

   Position-Based Writes (Avoided):
   └──► writable.write({ type: 'write', position: X, data: chunk })
        (Can cause "state cached in interface object" error)

4. Close Stream:
   writable.close()
   └──► Finalizes file

Browser Support:
  ├──► Chrome 86+
  ├──► Edge 86+
  ├──► Opera 72+
  └──► Not supported: Firefox, Safari

Fallback:
  └──► In-memory buffer → Blob → Download link
```

### Memory Management

```javascript
Strategy: Stream-to-Disk (Zero Memory)

Sender:
  ├──► Read file in 16KB chunks (streaming)
  ├──► Buffer to 64KB storage chunks
  ├──► Send immediately via DataChannel
  └──► No file kept in memory

Receiver:
  ├──► Receive chunks via DataChannel
  ├──► Verify hash
  ├──► Write directly to disk (streaming)
  ├──► Buffer out-of-order chunks temporarily
  └──► No file assembled in memory

Benefits:
  ├──► Supports 50GB+ files
  ├──► Constant memory usage (~1-2MB)
  ├──► No browser memory limits
  └──► No crashes from OOM errors
```

---

## ⚠️ Error Handling & Recovery

### Connection Errors

```javascript
WebRTC States Monitoring:

peerConnection.connectionState
  ├──► "new" - Initial state
  ├──► "connecting" - ICE negotiation
  ├──► "connected" - P2P established ✓
  ├──► "disconnected" - Temporary loss
  ├──► "failed" - Connection failed ✗
  └──► "closed" - Manually closed

peerConnection.iceConnectionState
  ├──► "new"
  ├──► "checking"
  ├──► "connected" ✓
  ├──► "completed" ✓
  ├──► "disconnected"
  ├──► "failed" ✗
  └──► "closed"

Auto-Reconnection:
  if (state === "disconnected" || state === "failed"):
    ├──► Attempt ICE restart
    ├──► Re-send offer/answer
    ├──► Max retries: 3
    └──► Timeout: 30s per attempt
```

### Transfer Errors

```javascript
Error Types:

1. Hash Mismatch:
   ├──► Receiver detects incorrect SHA-256
   ├──► Send re-send request for chunk
   ├──► Max retries per chunk: 3
   └──► If still invalid: abort transfer

2. Out-of-Order Chunks:
   ├──► Buffer in pendingChunks map
   ├──► Write sequentially when in order
   └──► No error (normal operation)

3. Missing Chunks:
   ├──► Detect gaps in received chunks
   ├──► Send resync request to sender
   ├──► Sender resumes from requested chunk
   └──► Receiver marks as complete

4. File System Errors:
   ├──► Permission denied
   ├──► Disk full
   ├──► Invalid file handle
   └──► Fallback to in-memory if possible

5. Browser Crash:
   ├──► IndexedDB persists state
   ├──► Detect on reopen
   └──► Offer resume option
```

### Network Resilience

```javascript
Backpressure Handling:

DataChannel.bufferedAmount
  ├──► Monitor buffer level
  ├──► Wait if > 64KB (bufferedAmountLow threshold)
  └──► Resume when drained

Strategy:
  async waitForDrain() {
    if (channel.bufferedAmount <= 65536) return;
    
    return new Promise(resolve => {
      channel.bufferedAmountLowThreshold = 65536;
      channel.addEventListener('bufferedamountlow', resolve);
      
      // Poll every 10ms as backup
      const poll = setInterval(() => {
        if (channel.bufferedAmount <= 65536) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
  }

Benefits:
  ├──► Prevents sender overload
  ├──► Adapts to network speed
  └──► Maintains reliable delivery
```

### Connection Monitoring

```javascript
Health Metrics:

getStats() (every 1000ms)
  ├──► Round Trip Time (RTT)
  │    └──► From candidate-pair stats
  │
  ├──► Packet Loss
  │    └──► From inbound-rtp stats
  │         ├─► packetsLost
  │         ├─► packetsReceived
  │         └─► Loss % = (lost / total) * 100
  │
  └──► Display in UI for debugging

Quality Indicators:
  ├──► RTT < 100ms: Excellent
  ├──► RTT 100-300ms: Good
  ├──► RTT > 300ms: Poor
  ├──► Packet Loss < 1%: Excellent
  ├──► Packet Loss 1-5%: Acceptable
  └──► Packet Loss > 5%: Poor (may affect transfer)
```

---

## 🎨 UI/UX Flow

### Visual States

```javascript
Connection Status Indicator:
  ├──► Socket: gray → amber (connecting) → green (connected)
  ├──► P2P: gray → amber (connecting) → green (connected)
  └──► Verified: gray → amber (verifying) → green (verified)
               └──► red (failed)

Progress Bar:
  ├──► Emerald (active transfer)
  ├──► Amber (paused)
  └──► Green (completed)

Transfer Speed Display:
  └──► Format: formatBytes(bytesPerSecond) + "/s"
       Examples: "1.2 MB/s", "856 KB/s"

ETA Calculation:
  └──► (remainingBytes / bytesPerSecond) + "s"
       Examples: "45s", "2m 30s"
```

### Activity Logging

```javascript
Log Types:
  ├──► info (default)
  ├──► success (green)
  ├──► warning (amber)
  └──► error (red)

Log Display:
  ├──► Max 50 entries (FIFO)
  ├──► Timestamp per entry
  ├──► Scrollable container
  └──► Auto-scroll to latest
```

---

## 🚀 Performance Optimizations

### Adaptive Chunking

```javascript
ChunkingEngine Performance Monitoring:
  ├──► Track chunks processed
  ├──► Calculate bytes per second
  ├──► Adjust chunk size dynamically
  │    ├─► If fast: increase to MAX_CHUNK_SIZE (32KB)
  │    ├─► If slow: decrease to MIN_CHUNK_SIZE (8KB)
  │    └─► Default: INITIAL_CHUNK_SIZE (16KB)
  └──► Balance between:
       ├─► Throughput (larger chunks)
       └─► Latency (smaller chunks)
```

### Concurrency Control

```javascript
Write Queue Management:
  ├──► Single writer lock (isWriting flag)
  ├──► Sequential writes to avoid conflicts
  ├──► Process queue when chunks in order
  └──► Buffer out-of-order chunks

Benefits:
  ├──► Prevents race conditions
  ├──► Maintains file integrity
  └──► Efficient disk writes
```

---

## 📱 Browser Compatibility

```javascript
Required Features:
  ✓ WebRTC RTCPeerConnection
  ✓ WebRTC DataChannel
  ✓ Web Crypto API
  ✓ IndexedDB
  ✓ File System Access API (or fallback)
  ✓ Secure Context (HTTPS/localhost)

Supported Browsers:
  ✓ Chrome 86+ (Full support)
  ✓ Edge 86+ (Full support)
  ✓ Brave (Full support)
  ⚠ Firefox (No File System API - uses fallback)
  ⚠ Safari (Limited WebRTC support)

Fallback Mechanisms:
  ├──► No File System API:
  │    └──► Use in-memory array + Blob download
  │
  └──► No WebRTC:
       └──► Display compatibility warning
```

---

## 🔍 Key Utility Functions

### tofuSecurity.js
- `generateSharedSecret()` - Creates 32-byte secret
- `deriveHMACKey()` - PBKDF2 key derivation
- `generateChallenge()` - Random challenge generation
- `signChallenge()` - HMAC signature creation
- `verifyChallenge()` - HMAC signature verification
- `createSecurityURL()` - URL with fragment security

### signaling.js
- `initSocket()` - Socket.IO initialization
- `createRoom()` - Room creation on server
- `joinRoom()` - Join existing room
- `waitForConnection()` - Promise-based connection wait
- `setupSignalingListeners()` - WebRTC signaling setup

### p2pManager.js
- `initializePeerConnection()` - RTCPeerConnection setup
- `createOffer()` - SDP offer generation
- `handleOffer()` - SDP offer processing (perfect negotiation)
- `handleAnswer()` - SDP answer processing
- `handleIceCandidate()` - ICE candidate handling
- `setPolite()` - Set negotiation politeness

### identityManager.js
- `getLocalUUID()` - Session-scoped UUID
- `savePeerSession()` - Persist peer verification
- `verifyPeer()` - Check peer authenticity

---

## 📝 Summary

Swoosh is a sophisticated P2P file transfer application that combines:

1. **WebRTC** for direct peer-to-peer communication
2. **TOFU Security** for cryptographic authentication
3. **Dual-loop architecture** for efficient chunking and assembly
4. **File System API** for memory-efficient large file handling
5. **IndexedDB** for transfer state persistence
6. **Zustand** for reactive state management
7. **Perfect negotiation** for robust WebRTC connections
8. **Pause/resume** with crash recovery support

The architecture ensures:
- ✅ 50GB+ file support with constant memory usage
- ✅ Secure, server-blind transfers
- ✅ Crash recovery capability
- ✅ Real-time progress tracking
- ✅ Cross-platform browser support (with fallbacks)
- ✅ Efficient network utilization with backpressure handling

---

## 🐛 Recent Bug Fixes & Improvements

### Issue #1: Retransmission "Transfer not found" Error
**Problem**: When retransmitted chunks arrived, receiver had no active transfer to process them because `completeTransfer()` cleaned up state prematurely.

**Solution**:
- Modified `completeTransfer()` to only cleanup when all chunks are actually received
- Added `forceCleanup()` method for explicit cleanup after retransmission
- Keep transfer state active when requesting retransmission
- Retry completion after retransmitted chunks arrive

### Issue #2: File Extension Placement on Mobile
**Problem**: Phones saved files as `name.jpg (1)` instead of `name(1).jpg`

**Solution**: 
- Provide clean filename to `showSaveFilePicker()`
- Browser handles numbering according to platform conventions
- Different OS handle this differently (acceptable behavior)

### Issue #3: Pause/Resume Sync Issue
**Problem**: Sender resumed from where IT paused, not from where receiver last received chunks, causing gaps.

**Solution**:
- Store receiver's last chunk position in `receiverLastChunkRef`
- When resuming, sender checks receiver's position
- If sender is ahead, retransmit missing chunks before resuming
- Proper sync ensures no gaps in file

**Flow**:
```
Sender pauses at chunk 223
Receiver pauses at chunk 193 (30 chunks behind)
  ↓
User clicks Resume
  ↓
Receiver sends: "resume from chunk 194"
  ↓
Sender receives resume signal:
  - Sees receiver needs chunk 194
  - Sender is at chunk 223
  - Retransmits chunks 194-222 (29 chunks)
  - Then resumes normal sending from 223
  ↓
Receiver gets all missing chunks
No gaps in file! ✓
```

### Issue #4: Writing to Closing Stream
**Problem**: Stream was closed during `completeTransfer()` but retransmitted chunks tried to write to it.

**Solution**:
- Check if writable stream exists before writing in `_processWriteQueue()`
- Check stream state in `_queueChunkForWrite()`
- Better error handling - treat closing stream as warning, not error
- Prevents "Cannot write to a closing writable stream" errors

### Issue #5: Incomplete File Writes After Pause/Resume
**Problem**: Only 13MB written out of 99MB - 1302 pending chunks never got written because stream closed prematurely.

**Solution**:
- Enhanced `completeTransfer()` to loop until ALL pending chunks are written
- Processes write queue up to 100 times with 100ms delays between iterations
- Only closes stream after `pendingChunks` map is empty
- Distinguishes between "pending write" (have chunk) vs "missing" (need retransmit)
- Three-tier retry strategy in `handleTransferComplete()`:
  1. Pending chunks (waiting for sequential write) → Wait 3s, retry
  2. Missing chunks (never received) → Request retransmit, wait 3s
  3. Final retry after retransmit → Wait 1s for writes

**Before Fix**:
```
Transfer complete → Process queue once → 1302 chunks pending
→ Close stream immediately → Only 13MB written ✗
```

**After Fix**:
```
Transfer complete → Loop processing queue
→ Iteration 1: Write sequential chunks, wait 100ms
→ Iteration 2: Write more chunks, wait 100ms
→ ... continues until all 1302 chunks written
→ All 99MB written → Close stream ✓
```

### Performance Improvements
- Longer timeouts for chunk arrival (300ms instead of 100ms)
- Better retry logic with progressive delays (3s → 3s → 1s)
- Improved logging for debugging pending chunks
- Stream state validation before write operations

---

**End of Flow Documentation**
