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
- **Multi-file & folder transfer** with per-file progress tracking
- **ZIP archive download** — receiver can bundle all files into a single ZIP
- **Drag & drop** file selection with bulk add/remove
- **Real-time speed graph** — canvas-based throughput chart during transfers
- **Text/clipboard sharing** — send text snippets between peers
- **Browser notifications** — notified on transfer completion
- **Connection quality indicator** — Excellent/Good/Fair/Poor badge based on RTT & packet loss

## Architecture Overview

The application follows a layered architecture with clear separation of concerns:

**UI Layer** - React components and hooks that handle user interaction

**Hooks Layer** - Business logic lives in custom React hooks (`useFileTransfer`, `useRoomConnection`, `useMessages`, etc.)

**Transfer Layer** - Domain-specific modules for chunking, assembly, validation, and progress tracking

**Infrastructure Layer** - Data access through repositories and I/O operations via the File System API

Key design principles:
- No circular dependencies
- Unidirectional data flow
- Single responsibility per module
- Repository pattern for data access abstraction
- Event-driven communication between layers

### Core Components

| Component | Purpose |
|-----------|---------|
| ChunkingEngine | Splits files into 64KB chunks for transfer |
| AssemblyEngine | Validates chunks and reassembles files on receiver side |
| ProgressTracker | Single source of truth for transfer progress |
| MultiFileTransferManager | Orchestrates multi-file sending (sequential or parallel) |
| MultiFileReceiver | Routes incoming chunks to per-file writers or ZIP archive |
| ZipStreamWriter | Streams multiple files into a single .zip archive using fflate |
| useFileTransfer | Orchestrates end-to-end single-file transfer workflow |
| useMultiFileTransfer | Wraps multi-file sender/receiver with ZIP support |
| useRoomConnection | Manages WebRTC connection lifecycle |
| FileWriter | Abstracts File System API for disk writes |
| SpeedGraph | Canvas-based real-time throughput chart |
| TextShareSection | Text/clipboard sharing between peers |

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

**Sending:** Files are read in 64KB chunks and sent via WebRTC DataChannels. Metadata and progress are tracked in IndexedDB. Multi-file transfers can run sequentially or in parallel.

**Receiving:** Incoming chunks are validated against SHA-256 checksums and written directly to disk using the File System Access API. The receiver can optionally bundle all incoming files into a single ZIP archive using streaming compression (fflate).

### Chunk Strategy

- **Default chunk size:** 64KB (adaptive 16KB–256KB based on throughput)
- **Mobile-optimized:** 64KB chunks, 256KB buffer watermark
- **ACK batching:** Every 50 chunks to reduce overhead
- **Adaptive sizing:** Scales up above 500KB/s throughput

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
│   ├── multichannel/      Bandwidth monitoring and channel pooling
│   └── multifile/         MultiFileTransferManager, MultiFileReceiver, ZipStreamWriter
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

The codebase is structured to keep concerns separate. UI layer stays thin, hooks handle business logic, and the transfer layer contains domain-specific knowledge. Tests live alongside the code they test.

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

- **React 19** with Vite 7
- **Tailwind CSS 4** for styling
- **Zustand 5** for minimal state management
- **WebRTC DataChannel** for peer-to-peer transfer
- **IndexedDB** for transfer metadata
- **File System Access API** for direct disk I/O
- **Web Crypto API** for SHA-256, HMAC, PBKDF2
- **Socket.io** for signaling
- **fflate** for streaming ZIP archive creation
- **Vitest** for testing

## Completed Features

- Pause/Resume functionality
- Crash recovery with recovery prompts
- Multiple file transfers in a single session
- Directory/folder transfer
- Transfer queue management  
- Mobile-optimized UI
- Transfer history tracking
- Configurable transfer speed throttling
- Optional encryption at rest
- Drag & drop file selection
- Real-time speed graph (canvas-based throughput chart)
- Text/clipboard sharing between peers
- Browser notifications on transfer events
- Connection quality indicator (RTT + packet loss)
- Streamed ZIP download — receiver bundles all files into a single archive
- Comprehensive error handling for ZIP mode (sequential-only warning, corrupt archive recovery)

## Testing

254 unit tests across 11 test files covering:

| Module | Tests |
|--------|-------|
| `lib/formatters` | 18 |
| `transfer/chunkBitmap` | 33 |
| `transfer/ProgressTracker` | 26 |
| `lib/validators` | ~40 |
| `lib/errors` | ~30 |
| `utils/qrCode` | 13 |
| `constants/transfer.constants` | ~20 |
| `transfer/multifile/ZipStreamWriter` | 14 |
| `utils/transferNotifications` | ~20 |
| `stores/transferStore` | ~14 |
| `utils/connectionMonitor` | ~10 |

```bash
npm test              # watch mode
npm run test:run      # single run (CI)
```

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
