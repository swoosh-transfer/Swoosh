# P2P File Transfer Development Tracker

## Project Overview
Web-based peer-to-peer file transfer application capable of handling 50GB+ transfers using WebRTC technology.

**Tech Stack:**
- Frontend: React 19 + Tailwind CSS 4 + Vite 7
- State Management: Zustand 5
- Storage: IndexedDB + File System API
- Transfer Protocol: WebRTC DataChannel
- Security: TOFU (Trust On First Use) + SHA256 verification
- ZIP: fflate (streaming ZIP archives)
- Testing: Vitest 3.2

---

## Core Features & Implementation Tasks

### 1. WebRTC Connection Management
- [x] Implement WebRTC peer connection setup
- [x] Handle ICE candidate exchange
- [x] Manage connection states (connecting, connected, disconnected, failed)
- [x] Auto-reconnection logic for dropped connections
- [x] Connection health monitoring
- [x] Connection quality indicator (Excellent/Good/Fair/Poor badge based on RTT + packet loss)

**Implementation Notes:**
- Use RTCPeerConnection with reliable DataChannel
- Configure DataChannel with ordered delivery for file integrity
- Implement heartbeat mechanism for connection health
- getStats() has 5s timeout to prevent hanging

### 2. File System Integration
- [x] File System API integration for file selection
- [x] File reading with progress tracking
- [x] Large file handling (streaming read)
- [x] File writing during reception
- [x] Directory/folder transfer support
- [x] File metadata extraction (name, size, type, modified date)
- [x] Drag & drop file selection with bulk add/remove

**Implementation Notes:**
- Use FileSystemAccess API for file operations
- Implement streaming file reader to avoid memory overflow
- Handle permission requests gracefully
- AbortError on file picker cancel handled correctly (no false starts)

### 3. Chunk-Based Transfer System
- [x] File chunking algorithm (64KB default, adaptive 16KB–256KB)
- [x] Chunk ordering and sequencing
- [x] Chunk verification using SHA256 checksums
- [x] Transfer progress tracking per chunk
- [x] Parallel chunk processing optimization
- [x] Chunk retry mechanism for failed transfers
- [x] ACK batching (every 50 chunks)

**Implementation Notes:**
- Default 64KB chunks, adaptive based on throughput
- Mobile-optimized: 64KB chunks, 256KB buffer watermark
- Scale-up threshold at 500KB/s throughput
- Generate SHA256 hash for each chunk before sending
- Store chunk metadata in IndexedDB for resume capability

### 4. File Metadata Management
- [x] Metadata packet creation (file info, chunk count, total size)
- [x] Metadata transmission before file chunks
- [x] Metadata validation and parsing
- [x] File reconstruction from metadata
- [x] Multiple file transfer metadata handling

**Implementation Notes:**
- Send metadata as first packet in transfer session
- Include file name, size, type, chunk count, and file hash
- Validate metadata before accepting transfer

### 5. IndexedDB Storage System
- [x] Database schema design for file transfer metadata
- [x] Chunk metadata storage and retrieval (NO actual chunk data)
- [x] Transfer state persistence
- [x] Incomplete transfer cleanup
- [ ] Storage quota management
- [x] Database migration handling

**Implementation Notes:**
- Store only chunk metadata in IndexedDB (transfer ID, index, checksum, status)
- Never store actual chunk data - stream directly via WebRTC
- Persist transfer state for resume functionality
- Implement cleanup for completed/cancelled transfers
- Minimal storage usage - only metadata and progress tracking

### 6. Resume Capability
- [x] Transfer state tracking and persistence
- [x] Chunk completion status tracking (metadata only)
- [x] Resume transfer from last successful chunk
- [x] Partial file reconstruction
- [x] Resume negotiation between peers
- [x] Resume after connection loss
- [x] Resume file-hash verification (SHA-256 on first 1MB + size + lastModified)
- [x] Session token binding for replay protection

**Implementation Notes:**
- Track completed chunk metadata in IndexedDB (not actual chunks)
- Resume by requesting missing chunks only (bitmap-based)
- Use file system API to verify partial file state
- Corrupt bitmap data handled gracefully (try-catch + rejection)
- In-room reconnection auto-resumes from interrupted chunk

### 7. Security Implementation (TOFU)
- [x] Shared secret generation
- [x] URL fragment-based secret sharing (server-blind)
- [x] Secret verification handshake
- [x] String encoding/decoding with shared secret
- [x] Peer identity verification
- [x] Secure channel establishment
- [x] Chunk authentication (HMAC auth tags)

**Implementation Notes:**
- Generate shared secret on sender side
- Share secret via URL fragment (#secret) to avoid server logs
- Derive AES-GCM-256 key from secret via PBKDF2
- Encrypt all signaling messages end-to-end
- Exchange and verify peer UUID over encrypted channel
- Per-chunk auth tags for tamper detection

### 8. UUID-Based Client Verification
- [x] UUID generation for each client session
- [x] UUID exchange during connection setup
- [x] UUID persistence across reconnections
- [x] Client identity verification
- [x] Session continuity validation

**Implementation Notes:**
- Generate UUID on page load/session start
- Store UUID in sessionStorage; persist peer sessions in IndexedDB
- Verify UUID matches on reconnection to identify returning peers
- Selective session cleanup (stale sessions >24h removed, active preserved)

### 9. User Interface Components
- [x] File selection interface
- [x] Transfer progress visualization
- [x] Connection status indicators
- [x] Transfer speed and ETA display
- [x] Error handling and user notifications
- [x] Multiple concurrent transfer management
- [x] Real-time speed graph (canvas-based, 30-second window)
- [x] Text/clipboard sharing between peers
- [x] Browser notifications on transfer events
- [x] ZIP toggle with sequential-only warning
- [x] ZIP-specific completion card and error messaging

**Implementation Notes:**
- Use React components with Tailwind for responsive design
- Implement real-time progress bars for chunk-level progress
- Show connection quality indicators (color-coded badge)

### 10. State Management (Zustand)
- [x] Global transfer state management
- [x] Connection state tracking
- [x] File queue management
- [x] Progress state updates
- [x] Error state handling
- [x] Transfer history tracking (initiateUpload/initiateDownload/completeTransfer)
- [ ] Settings and preferences

**Implementation Notes:**
- Create stores for: connections, transfers, files, settings
- Implement middleware for persistence and logging
- Use subscriptions for real-time UI updates

### 11. Error Handling & Recovery
- [x] Connection failure recovery
- [x] Chunk transfer error handling
- [x] File corruption detection and recovery
- [x] Network interruption handling
- [x] User-friendly error messages
- [x] Automatic retry mechanisms
- [x] ZIP archive error handling (corrupt write, flush, finalize)
- [x] File picker cancel handling (no false start on AbortError)

**Implementation Notes:**
- Implement exponential backoff for retry logic
- Provide detailed error information for debugging
- Graceful degradation for unsupported features
- waitForDrain has 10s timeout + readyState check to prevent hanging

### 12. Performance Optimization
- [x] Chunk processing optimization
- [x] Memory usage optimization for large files
- [x] Transfer speed optimization
- [x] Mobile device optimization (64KB chunks, 256KB watermark)
- [ ] Browser compatibility testing
- [ ] Background transfer capability

**Implementation Notes:**
- Adaptive chunk sizing based on connection quality
- Optimize for low-memory devices
- ACK batch size: 50 chunks
- AssemblyEngine pendingAcks memory cleanup
- MultiFileReceiver/Manager destroy() clears all Maps

### 13. Testing & Quality Assurance
- [x] Unit tests for core functions (254 tests across 11 files)
- [ ] Integration tests for file transfer flow
- [ ] Cross-browser compatibility testing
- [ ] Large file transfer testing (50GB+)
- [ ] Network condition simulation testing
- [ ] Security vulnerability assessment

**Implementation Notes:**
- Test modules: formatters, chunkBitmap, ProgressTracker, validators, errors, qrCode, transferConstants, ZipStreamWriter, transferNotifications, transferStore, connectionMonitor
- Vitest with jsdom environment
- Comprehensive mocking for IndexedDB, File System API, WebRTC, Web Crypto

### 14. Multi-File & ZIP Transfer
- [x] Multi-file transfer manager (sequential or parallel)
- [x] Multi-file receiver with per-file progress
- [x] Folder/directory transfer support
- [x] Streamed ZIP download (receiver bundles files into single archive)
- [x] ZIP sequential file ordering
- [x] ZIP error handling (write, flush, finalize paths)
- [x] ZIP UX: toggle, warnings, progress badge, completion card

**Implementation Notes:**
- ZIP uses fflate's ZipPassThrough (store mode, no compression for speed)
- Files MUST be written to ZIP sequentially (chunks for later files buffered)
- Two output modes: File System API writable (preferred) or in-memory Blob (fallback)
- Sender shows informational note about receiver's ZIP option

---

## Development Milestones

### Phase 1: Core Infrastructure ✅
- WebRTC connection setup
- Basic file chunking
- IndexedDB integration
- Simple file transfer

### Phase 2: Advanced Features ✅
- Resume capability
- Security implementation
- UUID verification
- Error recovery

### Phase 3: Optimization & Polish ✅
- Performance optimization (mobile chunks, ACK batching, buffer tuning)
- UI/UX improvements (speed graph, text sharing, connection quality)
- Multi-file and ZIP transfer
- Browser notifications

### Phase 4: Testing & Documentation ✅
- 254 unit tests across 11 test files
- Comprehensive documentation
- Bug fixes and stability improvements

---

## Technical Considerations

- **Chunk Sizes**: Default 64KB, adaptive 16KB–256KB based on throughput
- **Browser Storage**: IndexedDB quotas, cleanup strategies
- **Security**: Client-side only verification, URL fragment security, HMAC chunk auth
- **Performance**: Large file memory management, adaptive chunking, ACK batching
- **Compatibility**: File System API support, WebRTC support across browsers
- **ZIP**: Sequential file ordering critical, streaming to avoid memory pressure