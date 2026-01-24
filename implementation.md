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

**Dual-Loop Architecture:**
The system implements a sophisticated dual-loop architecture optimizing for both network efficiency and storage management:

**CHUNKING LOOP (Sender Side):**
```
1. Initialize chunking state and storage buffer (64KB)
2. Start file stream reader
3. Read 16KB chunks from file (WebRTC DataChannel limit)
4. Append chunks to storage buffer
5. When storage buffer full (64KB):
   - Calculate SHA-256 checksum for entire storage chunk
   - Store chunk metadata in IndexedDB (NOT actual data)
   - Send chunk metadata via WebRTC
   - Send binary data via WebRTC DataChannel
   - Monitor performance and adapt chunk sizes
   - Reset storage buffer
6. Repeat until EOF
7. Process final partial buffer if needed
```

**RECEIVING LOOP (Receiver Side):**
```
1. Initialize assembly state and receive buffer
2. Receive 16KB chunks via WebRTC
3. Append chunks to receive buffer
4. When receive buffer complete:
   - Calculate SHA-256 checksum for validation
   - Validate checksum against received metadata
   - Store validated metadata in IndexedDB
   - Write chunk directly to file system
   - Reset receive buffer
5. Repeat until transfer complete
6. Close file handle and mark assembly complete
```

**Storage Buffer Management:**
- **Chunking Side**: 64KB storage buffers accumulate multiple 16KB network chunks before processing
- **Assembly Side**: 64KB receive buffers validate and write chunks in optimized batches
- **Memory Efficiency**: No storage of actual chunk data - only metadata cached in IndexedDB
- **Direct Streaming**: File data flows directly from disk → WebRTC → disk without intermediate storage

**Adaptive Performance Optimization:**
- **Dynamic Chunk Sizing**: Monitors throughput and adjusts chunk sizes (8KB-32KB range)
- **Performance Metrics**: Tracks bytes/second, adapts based on network conditions
- **Buffer Optimization**: Balances memory usage with transfer efficiency

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
- **Performance Store**: Tracks transfer performance metrics, adaptive chunk sizing history, and connection quality data

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
Peer authenticity is verified through a challenge-response mechanism using HMAC signatures. One peer generates a random challenge, the other signs it with the shared secret-derived key, and the signature is verified. This ensures both peers possess the same secret without transmitting it again.

**Security Flow:**
1. Sender generates shared secret and peer ID
2. Secret shared via URL fragment (server-blind)
3. Both peers derive HMAC key from shared secret
4. Challenge-response verification using derived key
5. Ongoing verification of peer identity

### 6. UUID-Based Session Management

**Session Identification:**
Each browser session generates a unique UUID using the Web Crypto API's randomUUID function. This identifier remains constant throughout the session and helps distinguish between different client instances.

**Session Data Persistence:**
Session information including the UUID, creation timestamp, connected peer ID, and active transfer list is stored in the browser's sessionStorage. This allows the application to maintain session continuity across page refreshes while automatically clearing data when the browser tab is closed.

**Session Lifecycle:**
- Generate UUID on application start
- Persist in sessionStorage for reconnection
- Verify UUID matches across connection drops
- Clean up on session end

### 7. Zustand Store Structure

**Connection Store:**
Manages all WebRTC connection-related state including the peer connection object, data channel reference, current connection status (disconnected, connecting, connected, failed), and connected peer identification. Provides actions for initializing connections, closing connections gracefully, and sending data through established channels.

**Transfer Store:**
Handles file transfer operations and progress tracking. Maintains a list of active transfers, separate progress tracking objects for uploads and downloads (keyed by transfer ID), and provides actions for initiating transfers, updating progress indicators in real-time, and canceling ongoing transfers with proper cleanup.

### 8. Message Protocol Design

**Message Categories:**
The communication protocol defines six core message types:
- **HANDSHAKE**: Initial connection establishment and peer verification
- **FILE_METADATA**: File information transmission before chunks (name, size, hash, etc.)
- **FILE_CHUNK**: Individual file chunk data with metadata
- **CHUNK_ACK**: Acknowledgment of successful chunk receipt and verification
- **TRANSFER_COMPLETE**: Notification when entire file transfer finishes
- **ERROR**: Error reporting and handling information

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
- **Storage Buffers**: 64KB buffers accumulate multiple 16KB network chunks for efficient processing
- **Receive Buffers**: 64KB validation buffers ensure data integrity before file writing
- **Zero-Copy Architecture**: Data streams directly from file system through WebRTC to destination file system
- **Buffer Recycling**: Reuse buffer memory across chunks to minimize garbage collection
- **No Chunk Caching**: Never store actual chunk data locally - only metadata and checksums

**Adaptive Transfer Optimization:**
- **Dynamic Chunk Sizing**: Real-time adjustment of chunk sizes (8KB-32KB) based on network performance
- **Performance Monitoring**: Track bytes/second, connection quality, and buffer efficiency
- **Network-Aware Adaptation**: Increase chunk sizes for high-throughput connections, decrease for unreliable networks
- **Buffer Size Optimization**: Adjust storage buffer sizes based on device capabilities and transfer patterns

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
This implementation documentation provides the technical foundation for building your P2P file transfer application with all the specified features.