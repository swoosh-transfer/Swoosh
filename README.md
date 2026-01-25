# P2P File Transfer

A secure, browser-based peer-to-peer file transfer application capable of handling **50GB+ files** using WebRTC technology. Transfer files directly between devices without server storage - your data never touches our servers.

![P2P File Transfer](https://img.shields.io/badge/WebRTC-Enabled-blue) ![Security](https://img.shields.io/badge/Security-TOFU-green) ![Large Files](https://img.shields.io/badge/Files-50GB+-orange)

## ✨ Features

- **🔒 End-to-End Security**: TOFU (Trust On First Use) authentication with URL fragment-based secret sharing (server-blind)
- **📦 Large File Support**: Handle 50GB+ files with streaming and chunked transfers
- **💾 Direct Disk Writing**: Uses File System Access API to write directly to disk, avoiding memory overflow
- **🔄 Resume Capability**: Transfer state persistence allows resuming interrupted transfers
- **⏸️ Pause/Play Control**: Pause and resume transfers at any time
- **🛡️ Crash Recovery**: Automatically detect and prompt to resume transfers after browser crashes
- **📊 Real-time Progress**: Live progress tracking with speed and ETA calculations
- **✅ Chunk Verification**: SHA-256 checksums ensure data integrity for every chunk
- **🌐 Cross-Platform**: Works in modern browsers (Chrome, Edge, Brave recommended)
- **📱 QR Code Sharing**: Easy room sharing via QR codes

## 🏗️ Architecture

```
┌─────────────────┐    WebRTC DataChannel     ┌─────────────────┐
│   Sender        │◄─────────────────────────►│   Receiver      │
│                 │                           │                 │
│ File System API │                           │ File System API │
│ Chunking Engine │                           │ Assembly Engine │
│ SHA256 Hasher   │                           │ SHA256 Verifier │
│ IndexedDB Meta  │                           │ IndexedDB Meta  │
│ Zustand Store   │                           │ Zustand Store   │
└─────────────────┘                           └─────────────────┘
```

### Core Components

| Component | Description |
|-----------|-------------|
| **ChunkingEngine** | Splits files into 16KB network chunks, buffers to 64KB storage chunks |
| **AssemblyEngine** | Receives chunks, validates checksums, and reassembles files |
| **FileReceiver** | Handles sequential disk writing with out-of-order chunk buffering |
| **IndexedDB** | Stores transfer metadata only (no chunk data) for resume capability |
| **TOFU Security** | Challenge-response authentication using HMAC-SHA256 |

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- Modern browser with File System Access API support (Chrome 86+, Edge 86+)
- HTTPS or localhost (required for File System API)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/p2p-file-transfer.git
cd p2p-file-transfer

# Install dependencies
npm install

# Start development server
npm run dev
```

### Usage

1. **Create a Room**: Open the app and a unique room is created automatically
2. **Share the Link**: Copy the room link or scan the QR code from another device
3. **Connect**: Once the peer joins, WebRTC connection is established
4. **Transfer Files**: Select files to send - they transfer directly via peer-to-peer
5. **Pause/Resume**: Use pause/play controls to manage ongoing transfers
6. **Crash Recovery**: If browser crashes, reopen and follow prompts to resume

## 🔧 Technical Details

### Dual-Loop Architecture

**Sender Side (Chunking Loop):**
```
File → Read 16KB → Buffer to 64KB → SHA256 Hash → Send via WebRTC
                                         ↓
                               Store metadata in IndexedDB
```

**Receiver Side (Assembly Loop):**
```
WebRTC → Receive 16KB → Buffer to 64KB → Validate SHA256 → Write to Disk
                                              ↓
                                    Store metadata in IndexedDB
```

### Chunk Sizes

| Type | Size | Purpose |
|------|------|---------|
| Network Chunk | 16KB | WebRTC DataChannel limit |
| Storage Buffer | 64KB | Optimized disk I/O batching |
| Adaptive Range | 8KB-32KB | Dynamic sizing based on throughput |

### Security Model

1. **Secret Generation**: 32-byte cryptographically secure random secret
2. **Server-Blind Sharing**: Secret transmitted via URL fragment (`#secret`) - never logged
3. **Key Derivation**: PBKDF2 with 100,000 iterations derives HMAC key
4. **Verification**: Challenge-response using HMAC-SHA256 signatures

### Data Persistence

IndexedDB stores only **metadata** for resume capability:
- `transfers`: Transfer state (status, progress, peer info, pause state)
- `files`: File metadata (name, size, type, total chunks)
- `chunks`: Chunk tracking (index, checksum, status, offset)
- `sessions`: Room/session information

**No actual file data is stored** - it streams directly via WebRTC.

## 📁 Project Structure

```
src/
├── components/
│   └── RoomUI.jsx        # UI components for room/transfer interface
├── pages/
│   ├── Home.jsx          # Landing page
│   └── Room.jsx          # Transfer room page
├── stores/
│   ├── roomStore.js      # Room/connection state management
│   └── transferStore.js  # Transfer progress state management
└── utils/
    ├── chunkingSystem.js # ChunkingEngine & AssemblyEngine
    ├── fileReceiver.js   # Sequential file writing with validation
    ├── fileSystem.js     # File System Access API wrapper
    ├── fileMetadata.js   # Metadata creation and storage
    ├── indexedDB.js      # IndexedDB operations
    ├── p2pManager.js     # WebRTC connection management
    ├── signaling.js      # Socket.io signaling
    ├── tofuSecurity.js   # TOFU authentication
    ├── identityManager.js# UUID session management
    ├── connectionMonitor.js # Connection health monitoring
    └── qrCode.js         # QR code generation
```

## 🔄 Resume & Crash Recovery

The application supports robust resume capability:

### Pause/Resume Feature
- **Sender**: Pause chunking and buffering, state preserved in memory and IndexedDB
- **Receiver**: Pause receiving, already-written chunks preserved on disk
- **State Sync**: Both peers notified of pause/resume via signaling

### Crash Recovery
1. **Automatic Detection**: On app load, checks IndexedDB for incomplete transfers
2. **User Prompt**: Shows dialog with transfer details and resume option
3. **File Re-selection**: For sender, prompts to re-select the same file
4. **Chunk Verification**: Validates existing chunks before resuming
5. **Missing Chunk Request**: Only transfers chunks that weren't received

## 🌐 Browser Support

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | 86+ | ✅ Full support |
| Edge | 86+ | ✅ Full support |
| Brave | Latest | ✅ Full support |
| Firefox | Latest | ⚠️ Memory fallback (no File System API) |
| Safari | Latest | ⚠️ Memory fallback |

> **Note**: Browsers without File System Access API fall back to in-memory storage, limiting file size to available RAM.

## 📜 Scripts

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run preview  # Preview production build
npm run lint     # Run ESLint
```

## 🛠️ Tech Stack

- **Frontend**: React 18 + Vite
- **Styling**: Tailwind CSS
- **State Management**: Zustand
- **Transfer Protocol**: WebRTC DataChannel
- **Storage**: IndexedDB + File System Access API
- **Security**: Web Crypto API (SHA-256, HMAC, PBKDF2)
- **Signaling**: Socket.io

## 🔮 Roadmap

- [ ] Multiple file transfer in single session
- [ ] Directory/folder transfer
- [ ] Transfer queue management
- [x] Pause/Resume functionality
- [x] Crash recovery with prompts
- [ ] Mobile optimizations
- [ ] Transfer speed throttling
- [ ] Encryption at rest option

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

---

**Built with ❤️ for secure, serverless file sharing**
