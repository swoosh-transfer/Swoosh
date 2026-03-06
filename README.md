# Swoosh

**Peer-to-peer file transfer for the browser.** Swoosh moves files directly between devices using WebRTC, handling 50GB+ without touching your servers. Your files never leave your devices.

## Features

- **End-to-end security** with TOFU (Trust On First Use) authentication
- **Large file support** - tested with 50GB+ transfers
- **Direct disk writing** via File System Access API (no memory overflow)
- **Resume support** - pause and resume transfers, recover from crashes
- **Chunk verification** with SHA-256 checksums on every chunk
- **Real-time progress** with speed and ETA calculations
- **Cross-browser** compatibility (Chrome, Edge, Brave)
- **QR code sharing** for easy peer pairing

## Architecture Overview

The application follows a layered architecture with clear separation of concerns:

**UI Layer** - React components and hooks that handle user interaction

**Service Layer** - Business logic orchestration including connection management, security, and transfer coordination

**Transfer Layer** - Domain-specific modules for chunking, assembly, validation, and progress tracking

**Infrastructure Layer** - Data access through repositories and I/O operations via the File System API

Key design principles:
- No circular dependencies
- Unidirectional data flow
- Single responsibility per module
- Service pattern for testable, stateless business logic
- Repository pattern for data access abstraction
- Event-driven communication between layers

### Core Components

| Component | Purpose |
|-----------|---------|
| TransferOrchestrator | Coordinates end-to-end transfer workflow |
| ChunkingEngine | Splits files into network chunks (16KB) and storage buffers (64KB) |
| AssemblyEngine | Validates chunks and reassembles files on receiver side |
| ProgressTracker | Single source of truth for transfer progress |
| ConnectionService | Manages WebRTC connection lifecycle |
| SecurityService | Handles TOFU authentication and secret verification |
| FileWriter | Abstracts File System API for disk writes |

## Getting Started

### Requirements

- Node.js 18 or later
- A modern browser with File System Access API support (Chrome 86+, Edge 86+)
- HTTPS or localhost (required for File System API)

### Installation

```bash
git clone https://github.com/swoosh-transfer/Swoosh
cd Swoosh
npm install
npm run dev
```

The app will be available at `http://localhost:5173`

### Basic Usage

1. Open Swoosh in one browser window
2. Share the room URL or QR code with your peer
3. Peer opens the shared link
4. Once connected, select files to transfer
5. Transfer happens directly between devices via WebRTC

## Technical Details

### How Transfers Work

**Sending:** Files are read in chunks, split into 16KB network packets, and sent via WebRTC. Metadata and progress are tracked in IndexedDB.

**Receiving:** Incoming chunks are validated against SHA-256 checksums, buffered to 64KB, and written directly to disk using the File System Access API. Already-received chunks are tracked in IndexedDB for resume capability.

### Chunk Strategy

- **Network packets:** 16KB (WebRTC DataChannel limits)
- **Storage buffers:** 64KB (optimized disk I/O batching)
- **Adaptive sizing:** 8-32KB based on throughput

### Security

The app uses TOFU (Trust On First Use) authentication:
1. A 32-byte random secret is generated per session
2. Secret is shared via URL fragment (never sent to server)
3. Both peers derive an HMAC key using PBKDF2 (100k iterations)
4. Challenge-response verification ensures peer identity

### Browser Support

Chrome, Edge, and Brave have full support including direct disk writing. Firefox and Safari fall back to in-memory storage, which limits file size to available RAM.

## Project Structure

```
src/
├── constants/              Configuration and magic numbers
├── lib/                   Pure utility functions (no dependencies)
│   ├── formatters.js      formatBytes(), formatDuration(), etc.
│   ├── errors.js          Custom error classes
│   └── validators.js      Input validation helpers
│
├── infrastructure/        Data access and I/O abstractions
│   ├── database/          IndexedDB repositories
│   └── storage/           File System API wrappers
│
├── transfer/              Transfer engine (core domain logic)
│   ├── sending/           ChunkingEngine for file splitting
│   ├── receiving/         AssemblyEngine for chunk validation
│   ├── resumption/        Pause/resume state management
│   ├── shared/            ProgressTracker (single source of truth)
│   └── multichannel/      Bandwidth monitoring and channel pooling
│
├── services/              Business logic and orchestration
│   ├── connection/        ConnectionService for WebRTC management
│   ├── security/          SecurityService for TOFU auth
│   ├── transfer/          TransferOrchestrator
│   └── messaging/         Protocol message handling
│
├── stores/                Zustand state (minimal, UI-only)
│   ├── roomStore.js       Room metadata
│   └── transferStore.js   Transfer UI state
│
├── pages/                 Page components
│   ├── Home.jsx           Landing page
│   └── Room/              Main transfer interface (modular)
│       ├── hooks/         Business logic hooks
│       └── components/    Presentational components
│
├── components/            Reusable UI components
└── utils/                 Legacy utilities (being refactored)
```

The codebase is structured to keep concerns separate. UI layer stays thin, services handle business logic, and the transfer layer contains domain-specific knowledge. Tests live alongside the code they test.

## Pause, Resume, and Recovery

The application tracks transfer state in IndexedDB, allowing you to pause transfers and resume them later—even after browser crashes.

**Pause/Resume:**
- Sender and receiver can pause at any time
- Already-received chunks are kept (not re-transferred)
- Both peers are notified via signaling protocol

**Crash Recovery:**
- On app load, IndexedDB is checked for incomplete transfers
- User is prompted to resume if transfers are found
- App validates existing chunks and requests only missing ones

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome 86+ | Full support |
| Edge 86+ | Full support |
| Brave | Full support |
| Firefox | In-memory storage only |
| Safari | In-memory storage only |

Browsers without File System Access API support store files in memory, limiting file size to available RAM.

## Development

```bash
npm run dev              Start development server
npm run build            Build for production
npm run preview          Preview production build locally
npm test                 Run tests in watch mode
npm run test:run         Run tests once (CI)
npm run lint             Run ESLint
```

## Stack

- **React 18** with Vite
- **Tailwind CSS** for styling
- **Zustand** for minimal state management
- **WebRTC DataChannel** for peer-to-peer transfer
- **IndexedDB** for transfer metadata
- **File System Access API** for direct disk I/O
- **Web Crypto API** for SHA-256, HMAC, PBKDF2
- **Socket.io** for signaling
- **Vitest** for testing

## Completed Features

- Pause/Resume functionality
- Crash recovery with recovery prompts
- Multiple file transfers in a single session
- Directory/folder transfer
- Transfer queue management  
- Mobile-optimized UI
- Configurable transfer speed throttling
- Optional encryption at rest

## Documentation

- [NEW_DEVELOPER_GUIDE.md](docs/NEW_DEVELOPER_GUIDE.md) - Start here for codebase introduction
- [ADDING_FEATURES.md](docs/ADDING_FEATURES.md) - How to implement new features
- [TRANSFER_FLOW.md](docs/TRANSFER_FLOW.md) - Detailed transfer lifecycle
- [DEBUGGING.md](docs/DEBUGGING.md) - Troubleshooting common issues
- [TESTING.md](docs/TESTING.md) - Testing strategy and practices
- [ARCHITECTURE.md](ARCHITECTURE.md) - Full architectural overview
- [stores/README.md](src/stores/README.md) - State management guidelines

## License

MIT License - See [LICENSE](LICENSE) for details.
