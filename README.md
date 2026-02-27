# Swoosh 💨

**Swoosh your files instantly, peer-to-peer.**

A secure, browser-based peer-to-peer file transfer application capable of handling **50GB+ files** using WebRTC technology. Transfer files directly between devices without server storage - your data never touches our servers.

![WebRTC](https://img.shields.io/badge/WebRTC-Enabled-blue) ![Security](https://img.shields.io/badge/Security-TOFU-green) ![Large Files](https://img.shields.io/badge/Files-50GB+-orange) ![License](https://img.shields.io/badge/License-MIT-yellow)

## 🌐 Live Deployment

Experience Swoosh now:

- **Production**: https://swoosh-transfer.vercel.app/

> 🔗 Share the deployment link with your peer to start swooshing files instantly!

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

Swoosh follows a **clean layered architecture** for maintainability and scalability:

```
┌──────────────────────────────────────────────────┐
│  UI Layer: React Components & Hooks              │
│  (pages/Room/ - 200 lines, highly modular)       │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│  Service Layer: Business Logic Orchestration     │
│  • ConnectionService - WebRTC management         │
│  • TransferOrchestrator - File transfer logic    │
│  • SecurityService - TOFU authentication         │
│  • MessageService - Protocol handling            │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│  Transfer Layer: Domain-Specific Modules         │
│  • ChunkingEngine - File splitting & sending     │
│  • AssemblyEngine - Chunk validation & assembly  │
│  • ProgressTracker - Single source of truth      │
│  • ResumableTransferManager - Pause/Resume logic │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│  Infrastructure: Data Access & I/O               │
│  • Database Repositories - IndexedDB access      │
│  • FileWriter - File System API integration      │
│  • Storage Layer - Persistent data management    │
└──────────────────────────────────────────────────┘
```

### Key Architectural Principles

- **No Circular Dependencies**: Strict unidirectional data flow
- **Single Responsibility**: Each module has one clear purpose
- **Service Pattern**: Business logic in testable, stateless services
- **Repository Pattern**: Centralized data access layer
- **Event-Driven**: Loose coupling via events between layers

### Core Components

| Component | Layer | Description |
|-----------|-------|-------------|
| **TransferOrchestrator** | Service | Coordinates end-to-end file transfer workflow |
| **ChunkingEngine** | Transfer | Splits files into 16KB network chunks, buffers to 64KB storage chunks |
| **AssemblyEngine** | Transfer | Receives chunks, validates checksums, and reassembles files |
| **FileReceiver** | Transfer | Handles sequential disk writing with out-of-order chunk buffering |
| **ProgressTracker** | Transfer | Single source of truth for all progress tracking |
| **ConnectionService** | Service | WebRTC connection lifecycle management |
| **SecurityService** | Service | TOFU authentication and verification |
| **Database Repositories** | Infrastructure | IndexedDB access layer (metadata only, no chunk data) |

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- Modern browser with File System Access API support (Chrome 86+, Edge 86+)
- HTTPS or localhost (required for File System API)

### Installation

```bash
# Clone the repository
git clone https://github.com/swoosh-transfer/Swoosh
cd Swoosh

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
├── constants/              # Configuration constants with explanatory comments
│   ├── transfer.constants.js
│   ├── network.constants.js
│   ├── timing.constants.js
│   └── messages.constants.js
├── lib/                    # Pure utility functions (no dependencies)
│   ├── formatters.js       # formatBytes, formatDuration, formatSpeed
│   ├── errors.js           # Custom error classes
│   └── validators.js       # Validation helpers
├── infrastructure/         # Data access & I/O layer
│   ├── database/
│   │   ├── client.js       # IndexedDB connection
│   │   ├── transfers.repository.js
│   │   ├── chunks.repository.js
│   │   └── metadata.repository.js
│   └── storage/
│       ├── FileWriter.js   # File System API wrapper
│       └── WriteQueue.js   # Sequential write queue
├── transfer/               # Transfer engine domain layer
│   ├── sending/
│   │   ├── ChunkingEngine.js    # File splitting & sending
│   │   └── BufferManager.js      # Chunk buffering logic
│   ├── receiving/
│   │   ├── AssemblyEngine.js    # Chunk validation & assembly
│   │   ├── FileReceiver.js      # File writing coordination
│   │   └── ChunkValidator.js    # SHA-256 validation
│   ├── resumption/
│   │   ├── ResumableTransferManager.js  # Pause/resume logic
│   │   └── TransferStateManager.js      # State persistence
│   └── shared/
│       └── ProgressTracker.js   # Single source of truth for progress
├── services/               # Business logic orchestration (stateless)
│   ├── connection/
│   │   └── ConnectionService.js # WebRTC lifecycle management
│   ├── security/
│   │   └── SecurityService.js   # TOFU authentication
│   ├── transfer/
│   │   └── TransferOrchestrator.js  # File transfer coordination
│   └── messaging/
│       └── MessageService.js    # Protocol message handling
├── stores/                 # Zustand stores (minimal, UI state only)
│   ├── roomStore.js        # Room metadata (roomId, isHost, securityPayload)
│   ├── transferStore.js    # Transfer history for UI display
│   └── README.md           # Store vs hook guidelines
├── pages/
│   ├── Home.jsx            # Landing page
│   └── Room/               # Main transfer UI (modular, ~200 lines)
│       ├── index.jsx       # Composed room component
│       ├── hooks/          # Custom hooks for business logic
│       │   ├── useRoomConnection.js   # ConnectionService integration
│       │   ├── useFileTransfer.js     # TransferOrchestrator integration
│       │   ├── useSecurity.js         # SecurityService integration
│       │   ├── useMessages.js         # MessageService integration
│       │   └── useUI.js               # UI-specific state
│       ├── components/     # Presentational components
│       │   ├── ConnectionSection.jsx
│       │   ├── SecuritySection.jsx
│       │   ├── TransferSection.jsx
│       │   └── ActivityLog.jsx
│       └── README.md       # Room architecture documentation
├── components/
│   └── shared/             # Reusable UI components
├── utils/                  # Legacy utilities (being refactored)
│   ├── identityManager.js
│   ├── logger.js
│   ├── qrCode.js
│   ├── signaling.js        # Socket.io signaling (used by ConnectionService)
│   ├── p2pManager.js       # WebRTC adapter (used by ConnectionService)
│   └── tofuSecurity.js     # TOFU crypto (used by SecurityService)
└── docs/                   # Developer documentation
    ├── NEW_DEVELOPER_GUIDE.md   # 30-minute onboarding guide
    ├── ADDING_FEATURES.md       # Step-by-step feature guides
    ├── TRANSFER_FLOW.md         # Detailed transfer lifecycle
    └── DEBUGGING.md             # Troubleshooting common issues
```

**📖 For New Developers:** Start with [docs/NEW_DEVELOPER_GUIDE.md](docs/NEW_DEVELOPER_GUIDE.md) for a comprehensive introduction to the codebase.

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

## 📚 Documentation

Comprehensive documentation for developers:

- **[NEW_DEVELOPER_GUIDE.md](docs/NEW_DEVELOPER_GUIDE.md)** - Start here! 30-minute introduction to the codebase
- **[ADDING_FEATURES.md](docs/ADDING_FEATURES.md)** - Step-by-step guides for common development tasks
- **[TRANSFER_FLOW.md](docs/TRANSFER_FLOW.md)** - Detailed transfer lifecycle with sequence diagrams
- **[DEBUGGING.md](docs/DEBUGGING.md)** - Troubleshooting guide for common issues
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Complete architectural overview and design decisions
- **[stores/README.md](src/stores/README.md)** - Store vs hook state management guidelines

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

**Before contributing:**
1. Read the [NEW_DEVELOPER_GUIDE.md](docs/NEW_DEVELOPER_GUIDE.md)
2. Follow the architectural patterns in [ARCHITECTURE.md](ARCHITECTURE.md)
3. Use [ADDING_FEATURES.md](docs/ADDING_FEATURES.md) for implementation guidance

## 👥 Team

Built during DUHacks hackathon.

---

**Swoosh** - Built with ❤️ for secure, serverless file sharing  
*Swoosh it. Share it. Simple.*
