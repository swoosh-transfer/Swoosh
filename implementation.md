# P2P File Transfer Implementation Documentation

## Architecture Overview

```
┌─────────────────┐    WebRTC DataChannel     ┌─────────────────┐
│   Sender        │◄─────────────────────────►│   Receiver      │
│                 │                           │                 │
│ File System API │                           │ File System API │
│ Chunking Engine │                           │ Assembly Engine │
│ SHA256 Hasher   │                           │ SHA256 Verifier │
│ IndexedDB Cache │                           │ IndexedDB Cache │
│ Zustand Store   │                           │ Zustand Store   │
└─────────────────┘                           └─────────────────┘
```

## Core Implementation Details

### 1. WebRTC Connection Setup

**Connection Configuration:**
The WebRTC connection uses standard STUN servers (Google's public STUN servers) to help with NAT traversal and peer discovery. The system maintains a pool of ICE candidates to ensure reliable connection establishment even in complex network environments.

**DataChannel Configuration:**
The data channel is configured for reliable, ordered delivery with a maximum of 3 retransmission attempts. This ensures file chunks arrive in the correct sequence and handles temporary network issues automatically. A custom protocol identifier helps distinguish our file transfer messages from other potential WebRTC communications.

**Key Implementation Points:**
- Use reliable DataChannel with ordered delivery
- Set appropriate buffer thresholds to prevent overflow
- Implement connection state monitoring
- Handle ICE gathering and signaling through URL sharing

### 2. File Chunking System

**Architecture:**
The system uses adaptive chunk sizing optimized for both network efficiency and storage management:

**CHUNKING LOOP (Sender Side):**
```
1. Initialize chunking state (default 64KB chunks)
2. Start file stream reader
3. Read chunks from file (adaptive 16KB–256KB)
4. Calculate SHA-256 checksum for each chunk
5. Send chunk metadata via WebRTC (JSON)
6. Send binary data via WebRTC DataChannel
7. Monitor throughput and adapt chunk sizes
8. Repeat until EOF
9. Process final partial chunk if needed
```

**RECEIVING LOOP (Receiver Side):**
```
1. Initialize assembly state and receive buffer
2. Receive chunks via WebRTC
3. Validate SHA-256 checksum against received metadata
4. Write validated chunk directly to file system (or ZIP archive)
5. Send ACK (batched every 50 chunks)
6. Repeat until transfer complete
7. Close file handle and mark assembly complete
```

**Chunk Configuration (from `transfer.constants.js`):**
- **Default chunk size:** 64KB
- **Mobile chunk size:** 64KB (optimized from 16KB)
- **Adaptive range:** 16KB–256KB based on throughput
- **ACK batch size:** 50 chunks
- **Mobile buffer watermark:** 256KB
- **Scale-up threshold:** 500KB/s throughput

**Adaptive Performance Optimization:**
- Monitors throughput and adjusts chunk sizes dynamically
- Scales up above 500KB/s (removed 2MB/s hard floor)
- ACK batching reduces overhead on fast connections

### 3. File System API Integration

**File Selection Process:**
The system uses the modern File System Access API to allow users to select multiple files of any type through native file picker dialogs. This provides a more secure and user-friendly experience compared to traditional file input elements, giving users direct control over file access.

**File Writing Mechanism:**
Received files are written directly to the user's chosen location using writable file streams. This approach allows for efficient handling of large files without loading everything into memory, and provides real-time progress feedback during the writing process.

**Security Considerations:**
- Request user permission for each file operation
- Handle permission denied scenarios gracefully
- Validate file handles before operations
- Implement proper error handling for unsupported browsers

### 4. IndexedDB Schema Design

**Database Structure:**
The local storage system uses IndexedDB with a dedicated database for P2P file transfers, storing only metadata and transfer state - never actual chunk data which streams directly via WebRTC.

**Data Organization:**
Four main object stores organize the data:
- **Transfers Store**: Tracks overall transfer operations using unique transfer IDs, with indexes for quick lookups by status, timestamp, and associated file ID
- **Chunks Store**: Stores ONLY chunk metadata (validation checksums, transfer state, timestamps) using composite keys (transfer ID + chunk index), with indexes for efficient retrieval by transfer ID and processing status
- **Files Store**: Maintains file metadata and references using unique file IDs, with indexes for searching by name, size, and creation timestamp
- **Sessions Store**: Tracks peer identity sessions keyed by roomId, containing peer UUID and lastConnected timestamp for returning-peer verification

**Storage Buffer Metadata Models:**
- **Transfer**: ID, file metadata, storage buffer progress, status, peer info, performance metrics
- **Chunk**: Transfer ID, storage chunk index, checksum, validation status, size, file offset, timestamp (NO binary data)
- **File**: ID, name, size, type, handle reference, total storage chunks expected
- **Performance**: Transfer ID, bytes/second, adaptive chunk sizes, buffer efficiency metrics

**Data Flow Architecture:**
```
File System → Storage Buffer (64KB) → IndexedDB (metadata only) → WebRTC (binary data)
                    ↓                           ↓                         ↓
                SHA-256 Hash              Metadata Storage         Direct Streaming
                    ↓                           ↓                         ↓
             Checksum Storage          Progress Tracking          No Local Cache
```

### 5. Security Implementation (TOFU)

**Shared Secret Generation:**
The system generates a cryptographically secure 32-byte random secret using the Web Crypto API. This secret is base64-encoded for safe transmission and serves as the foundation for all subsequent security operations.

**Server-Blind Secret Sharing:**
The shared secret and peer identification are transmitted through URL fragments (the part after #), ensuring that web servers cannot log or intercept this sensitive information. The secret data is JSON-encoded and base64-encoded for safe URL transmission.

**Verification Process:**
Peer authenticity is verified through encrypted signaling using AES-GCM-256. The shared secret is used to derive an encryption key via PBKDF2. All signaling messages are encrypted end-to-end, so the signaling server cannot read them. Peers exchange UUIDs over the encrypted channel and verify returning peers against the IndexedDB sessions store.

**Security Flow:**
1. Sender generates shared secret and peer ID
2. Secret shared via URL fragment (server-blind)
3. Both peers derive AES-GCM-256 key from shared secret via PBKDF2
4. All signaling encrypted end-to-end
5. UUID exchange and verification over encrypted channel
6. Returning peers auto-identified for transfer resume

### 6. UUID-Based Session Management

**Session Identification:**
Each browser session generates a unique UUID using the Web Crypto API's randomUUID function. This identifier remains constant throughout the session and helps distinguish between different client instances.

**Session Data Persistence:**
The local UUID is stored in sessionStorage (cleared on tab close). Peer sessions are stored in IndexedDB's sessions store, keyed by roomId, containing the peer's UUID and lastConnected timestamp. Stale sessions older than 24 hours are cleaned up automatically. This allows verification of returning peers on reconnection.

**Session Lifecycle:**
- Generate UUID on application start
- Persist in sessionStorage for reconnection
- Store peer sessions in IndexedDB for cross-reconnection verification
- Selectively clean up stale sessions (>24h) rather than wiping all

### 7. Zustand Store Structure

**Connection Store:**
Manages all WebRTC connection-related state including the peer connection object, data channel reference, current connection status (disconnected, connecting, connected, failed), and connected peer identification. Provides actions for initializing connections, closing connections gracefully, and sending data through established channels.

**Transfer Store:**
Handles file transfer operations and progress tracking. Maintains a list of active transfers, separate progress tracking objects for uploads and downloads (keyed by transfer ID), and provides actions for initiating transfers, updating progress indicators in real-time, and canceling ongoing transfers with proper cleanup.

### 8. Message Protocol Design

**Message Categories:**
The communication protocol defines these core message types:
- **HANDSHAKE**: Initial connection establishment and peer verification
- **FILE_METADATA**: File information transmission before chunks (name, size, hash, etc.)
- **FILE_CHUNK**: Individual file chunk data with metadata
- **CHUNK_ACK**: Acknowledgment of successful chunk receipt (batched every 50)
- **TRANSFER_COMPLETE**: Notification when entire file transfer finishes
- **TEXT_MESSAGE**: Peer-to-peer text/clipboard sharing
- **ERROR**: Error reporting and handling information
- **Multi-file types**: MULTI_FILE_MANIFEST, FILE_START, FILE_COMPLETE, ALL_FILES_COMPLETE
- **Resume types**: RESUME_TRANSFER, RESUME_ACCEPTED, RESUME_REJECTED, RECEIVER_READY

**Message Format:**
All messages follow a consistent structure containing the message type, unique transfer identifier for tracking, timestamp for ordering and debugging, and a payload section containing type-specific data. This standardized format enables reliable message parsing and routing.

### 9. Error Handling Strategy

**Error Classification:**
The system categorizes errors into specific types for targeted handling:
- **CONNECTION_LOST**: Network disconnections or peer unavailability
- **CHUNK_VERIFICATION_FAILED**: SHA256 checksum mismatches indicating data corruption
- **STORAGE_QUOTA_EXCEEDED**: Browser storage limits reached during caching
- **FILE_ACCESS_DENIED**: User permission issues or file system restrictions
- **UNSUPPORTED_BROWSER**: Missing required browser features or APIs

**Recovery Mechanisms:**
Each error type has a corresponding recovery strategy:
- Connection losses trigger automatic reconnection attempts with resume capability
- Failed chunk verification prompts retransmission requests for specific chunks
- Storage quota issues initiate cleanup of completed transfers and temporary data
- Access denials prompt user re-authorization or alternative file selection
- Browser compatibility issues trigger graceful degradation or polyfill loading

### 10. Performance Optimization Techniques

**Dual-Buffer Memory Management:**
- **Zero-Copy Architecture**: Data streams directly from file system through WebRTC to destination file system
- **Buffer Recycling**: Reuse buffer memory across chunks to minimize garbage collection
- **No Chunk Caching**: Never store actual chunk data locally - only metadata and checksums
- **waitForDrain**: 10s timeout + readyState check to prevent hanging

**Adaptive Transfer Optimization:**
- **Dynamic Chunk Sizing**: Real-time adjustment of chunk sizes (16KB-256KB) based on network performance
- **Performance Monitoring**: Track bytes/second, connection quality, and buffer efficiency
- **Network-Aware Adaptation**: Increase chunk sizes for high-throughput connections
- **ACK Batching**: Every 50 chunks to reduce protocol overhead

**Storage Efficiency Strategy:**
- **Metadata-Only IndexedDB**: Store only checksums, transfer state, and progress - never binary data
- **Direct File System Streaming**: Write received chunks directly to destination files without intermediate storage
- **Minimal Memory Footprint**: Process chunks immediately upon receipt, clear from memory after processing
- **Progressive Cleanup**: Remove completed transfer metadata to prevent database bloat

**Background Processing Architecture:**
- **Web Workers Integration**: Offload SHA-256 hashing to background threads
- **Streaming Hash Calculation**: Calculate checksums as data flows through buffers
- **Parallel Validation**: Validate received chunks while processing new incoming data
- **Non-Blocking I/O**: Use async file operations to prevent UI blocking during large transfers

### 11. Browser Compatibility Handling

**Feature Detection System:**
The application performs comprehensive feature detection on startup, checking for:
- **WebRTC Support**: RTCPeerConnection availability for peer-to-peer communication
- **File System API**: Native file picker and writer support for modern file handling
- **IndexedDB**: Client-side database support for chunk storage and transfer state
- **Web Crypto API**: Cryptographic functions for security and verification
- **Web Workers**: Background processing capability for intensive operations

**Graceful Degradation Strategy:**
When modern features are unavailable, the system automatically falls back to alternative approaches:
- File System API unavailable → traditional file input elements
- Web Workers unavailable → main thread processing with progress indicators
- Advanced crypto unavailable → simplified verification methods
This ensures basic functionality across a wide range of browsers and devices.

### 12. Testing Strategy

**Unit Tests:**
- Chunk generation and verification
- Hash calculation accuracy
- IndexedDB operations
- Message serialization/deserialization

**Integration Tests:**
- End-to-end file transfer
- Connection recovery scenarios
- Large file handling
- Multiple concurrent transfers

**Performance Tests:**
- Memory usage with large files
- Transfer speed optimization
- Connection stability testing
- Browser compatibility testing

### 13. Deployment Considerations

**Build Configuration:**
- Bundle size optimization
- Service Worker for offline capability
- Progressive Web App features
- HTTPS requirement for WebRTC

**Security Headers:**
- Content Security Policy
- Cross-Origin policies
- Feature Policy for File System API
- Secure context requirements

---

### 14. Multi-File & ZIP Transfer

**Multi-File Architecture:**
The multi-file system uses `MultiFileTransferManager` (sender) and `MultiFileReceiver` (receiver) to handle batches of files. The sender sends a MULTI_FILE_MANIFEST listing all files, then transfers them sequentially or in parallel.

**Streamed ZIP Download:**
The receiver can optionally bundle all incoming files into a single ZIP archive:

```
ZipStreamWriter (fflate)
├── addFile(name, size)    → Creates ZipPassThrough entry (store mode, no compression)
├── pushChunk(data)        → Pushes chunk to current ZIP entry
├── endFile()              → Finalizes current ZIP entry
└── finish()               → Returns Promise<Blob|null> or writes to File System API writable
```

**Critical ZIP Constraint:**
Files MUST be written to the ZIP sequentially (file 0 → 1 → 2 → N). When chunks arrive for a later file, they are buffered in `_zipChunkBuffers` Map and flushed when the current file completes.

**ZIP Output Modes:**
1. **File System API writable** (preferred) — streamed directly to disk via `showSaveFilePicker()`
2. **In-memory Blob** (fallback) — for browsers without File System API

**ZIP Error Handling:**
- try/catch in `_writeChunkToZip` — calls `onError` on failure
- try/catch in `_flushZipBuffer` — calls `onError` on flush failure
- try/catch in `_completeFile` ZIP path — calls `onError` on finalize failure
- ZIP-specific error messages suggest retrying without ZIP mode

### 15. Text/Clipboard Sharing

**Protocol:**
Text messages use the `TEXT_MESSAGE` type over the existing DataChannel. Messages contain `{ text, timestamp }` payloads. The `TextShareSection` component provides a chat-style interface with copy-to-clipboard buttons.

**Implementation:**
- `useMessages.js` handles `TEXT_MESSAGE` type and forwards to `onTextMessage` callback
- Room component maintains `textMessages` state array
- Messages are displayed chronologically with "You" / "Peer" labels

### 16. Real-Time Speed Graph

**SpeedGraph Component:**
Canvas-based real-time throughput visualization rendering the last 30 seconds of transfer speed data. Uses `requestAnimationFrame` for smooth rendering and auto-scales the Y-axis based on peak speed.

**Implementation:**
- Samples speed every second while transfer is active
- Maintains circular buffer of 30 data points
- Renders filled area chart with grid lines and axis labels
- Shows current speed, peak speed, and average speed

### 17. Connection Quality Indicator

**Quality Assessment:**
The `connectionMonitor.js` tracks RTT (round-trip time) and packet loss from WebRTC stats (`getStats()` with 5s timeout). Quality is classified as:

| Quality | RTT | Packet Loss | Color |
|---------|-----|-------------|-------|
| Excellent | < 50ms | < 1% | Green |
| Good | < 150ms | < 3% | Yellow |
| Fair | < 300ms | < 5% | Orange |
| Poor | ≥ 300ms | ≥ 5% | Red |

The badge is rendered in the Room page's connection status card.

### 18. Browser Notifications

**Transfer Notifications:**
`transferNotifications.js` uses the browser Notification API to alert users when:
- A transfer completes (sender and receiver sides)
- Notifications fire only when the tab is not focused

**Integration:**
- `notifyTransferComplete(fileName)` called in both `useFileTransfer.js` and `useMultiFileTransfer.js` completion paths
- Permission requested on first use via `Notification.requestPermission()`

---
This implementation documentation provides the technical foundation for the P2P file transfer application.