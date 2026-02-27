# New Developer Guide

Welcome to the P2P File Transfer project! This guide will help you understand the codebase and start contributing in under 30 minutes.

## What This Application Does

This is a **browser-to-browser peer-to-peer file transfer application** using WebRTC. Users share files directly without a server intermediary, with features including:

- ✅ Direct peer-to-peer file transfer via WebRTC DataChannels
- ✅ TOFU (Trust On First Use) security for peer verification
- ✅ Large file support with chunking and progress tracking
- ✅ Pause/resume/cancel functionality
- ✅ Persistent transfer state (crash recovery)
- ✅ Room-based connections with QR code sharing

## 30-Minute Quick Start

### Step 1: Understand the Architecture (5 minutes)

The codebase follows a **layered architecture** from UI → Services → Domain → Infrastructure:

```
┌──────────────────────────────────────────────────────┐
│  UI LAYER                                             │
│  pages/Room/ - Main transfer UI (200 lines)          │
│  └── hooks/ - Custom hooks for business logic        │
│  └── components/ - Presentational UI components      │
└──────────────────────────────────────────────────────┘
                        ↓ uses
┌──────────────────────────────────────────────────────┐
│  SERVICE LAYER                                        │
│  services/ - Stateless orchestration                 │
│  ├── ConnectionService - WebRTC connection           │
│  ├── SecurityService - TOFU verification             │
│  ├── TransferOrchestrator - File transfer logic      │
│  └── MessageService - Protocol messages              │
└──────────────────────────────────────────────────────┘
                        ↓ uses
┌──────────────────────────────────────────────────────┐
│  TRANSFER LAYER                                       │
│  transfer/ - Transfer engine modules                 │
│  ├── sending/ - ChunkingEngine, BufferManager        │
│  ├── receiving/ - AssemblyEngine, FileReceiver       │
│  ├── resumption/ - ResumableTransferManager          │
│  └── shared/ - ProgressTracker (single source!)      │
└──────────────────────────────────────────────────────┘
                        ↓ uses
┌──────────────────────────────────────────────────────┐
│  INFRASTRUCTURE LAYER                                 │
│  infrastructure/ - Data persistence                  │
│  ├── database/ - IndexedDB repositories              │
│  └── storage/ - File System API, write queues        │
└──────────────────────────────────────────────────────┘
```

**Key Principle:** Upper layers depend on lower layers, never the reverse. No circular dependencies!

### Step 2: Trace a File Transfer (10 minutes)

Let's follow what happens when a user sends a file:

1. **UI Component** ([Room/components/TransferSection.jsx](../src/pages/Room/components/TransferSection.jsx))
   - User selects file via File System API
   - Calls `handleSendFile()` from `useFileTransfer` hook

2. **Hook Layer** ([Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js))
   - Hook calls `TransferOrchestrator.startSending(file)`
   - Returns progress callbacks and control functions

3. **Service Layer** ([services/TransferOrchestrator.js](../src/services/TransferOrchestrator.js))
   - Initializes transfer ID, metadata
   - Creates `ChunkingEngine` instance
   - Coordinates with `MessageService` to send metadata
   - Starts chunking process

4. **Transfer Layer** ([transfer/sending/ChunkingEngine.js](../src/transfer/sending/ChunkingEngine.js))
   - Reads file in 16KB chunks (WebRTC DataChannel limit)
   - Accumulates chunks into 64KB storage buffers
   - Calculates SHA-256 checksums
   - Sends chunks via DataChannel
   - Updates `ProgressTracker` (single source of truth)

5. **Infrastructure Layer** ([infrastructure/database/transfers.repository.js](../src/infrastructure/database/transfers.repository.js))
   - Saves transfer metadata to IndexedDB
   - Persists progress for crash recovery

**On the receiving side:**

1. **MessageService** receives file metadata message
2. **TransferOrchestrator** creates `FileReceiver` instance
3. **AssemblyEngine** validates chunks, checks checksums
4. **FileWriter** writes validated chunks to disk via File System API
5. **ProgressTracker** updates receive progress

**📖 See [TRANSFER_FLOW.md](TRANSFER_FLOW.md) for detailed sequence diagrams**

### Step 3: Explore Key Files (10 minutes)

Start with these files to understand the system:

#### **Entry Point: Room Page**
[pages/Room/index.jsx](../src/pages/Room/index.jsx) (~200 lines)
- Main transfer UI
- Composes hooks and components
- **Read this first** to see how everything connects

#### **Connection Management**
[services/ConnectionService.js](../src/services/ConnectionService.js)
- WebRTC lifecycle management
- Signaling and ICE candidate exchange
- Event-based API: `onConnected`, `onDisconnected`

#### **Transfer Orchestration**
[services/TransferOrchestrator.js](../src/services/TransferOrchestrator.js)
- **The most important service for transfers**
- Coordinates sending and receiving
- Exposes: `startSending()`, `startReceiving()`, `pause()`, `resume()`

#### **Progress Tracking**
[transfer/shared/ProgressTracker.js](../src/transfer/shared/ProgressTracker.js)
- **Single source of truth for all progress**
- Calculates speed, ETA, percentage
- Used by all transfer components

#### **State Management**
[stores/roomStore.js](../src/stores/roomStore.js) - Room metadata only
[stores/transferStore.js](../src/stores/transferStore.js) - Transfer history only
- Zustand stores for cross-page UI state
- **NOT for business logic** (that's in hooks/services)
- See [stores/README.md](../src/stores/README.md) for store vs hook guidelines

### Step 4: Run the Application (5 minutes)

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Open two browser windows to test P2P transfer
# Window 1: Create a room
# Window 2: Join the room via QR code or room ID
```

**To test transfers:**
1. Window 1 creates a room → becomes host
2. Window 2 scans QR or enters room ID → becomes peer
3. Verify TOFU security (first-time only)
4. Select file to send
5. Watch real-time progress in both windows
6. Try pause/resume/cancel

## Code Organization Rules

### Import Hierarchy (Prevent Circular Dependencies)

```
UI (pages/, components/)
  ↓ can import
Services (services/)
  ↓ can import
Transfer Modules (transfer/)
  ↓ can import
Infrastructure (infrastructure/)
  ↓ can import
Library (lib/)
  ↓ can import
Constants (constants/)
```

**❌ NEVER import upward** (e.g., service importing from UI)

### State Management Guidelines

**Zustand Stores** (`stores/`) - Only for:
- ✅ Cross-page UI state (room metadata, transfer history)
- ✅ Global UI preferences
- ❌ NOT for business logic state

**Custom Hooks** (`pages/Room/hooks/`) - For:
- ✅ Component-specific business logic
- ✅ Service integration
- ✅ Real-time state (connection, progress, TOFU)

**Services** (`services/`) - For:
- ✅ Stateless orchestration
- ✅ Coordinating multiple modules
- ❌ NO React dependencies
- ❌ NO component state

**📖 See [stores/README.md](../src/stores/README.md) for detailed guidelines**

### File Naming Conventions

- **Components:** PascalCase (e.g., `TransferSection.jsx`)
- **Hooks:** camelCase with `use` prefix (e.g., `useFileTransfer.js`)
- **Services:** PascalCase with `Service` suffix (e.g., `ConnectionService.js`)
- **Utilities:** camelCase (e.g., `formatBytes.js`)
- **Constants:** camelCase with `.constants.js` suffix

## Common Development Tasks

### Adding a New Message Type

See [ADDING_FEATURES.md](ADDING_FEATURES.md#adding-a-new-message-type)

### Adding Transfer Progress Callback

See [ADDING_FEATURES.md](ADDING_FEATURES.md#adding-progress-callbacks)

### Debugging Transfer Issues

See [DEBUGGING.md](DEBUGGING.md#transfer-debugging)

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- ProgressTracker.test.js

# Run tests in watch mode
npm test -- --watch
```

## Architecture Decisions

### Why Services Instead of Direct Utils?

**Before (❌ Problems):**
```javascript
// Room.jsx directly using 15+ utility files
import { chunkFile } from '@/utils/chunkingSystem';
import { receiveFile } from '@/utils/fileReceiver';
import { setupWebRTC } from '@/utils/p2pManager';
// ... 12 more imports
// 1,401 lines of tangled logic
```

**After (✅ Solution):**
```javascript
// Room.jsx using clean services
const connection = useRoomConnection();    // Wraps all connection logic
const transfer = useFileTransfer();        // Wraps all transfer logic
const security = useSecurity();            // Wraps all TOFU logic
// ~200 lines, easy to understand
```

**Benefits:**
- New developers learn 3 services, not 15+ utils
- Services can be unit tested without React
- Clear separation: UI → Services → Utils
- Easier to refactor internal implementation

### Why No Circular Dependencies?

**Problem:** Previous codebase had:
```
chunkingSystem.js ←→ fileReceiver.js ←→ resumableTransfer.js
(All importing each other, impossible to test in isolation)
```

**Solution:** Strict hierarchy:
```
ChunkingEngine → ProgressTracker
FileReceiver → ProgressTracker
(Both depend on ProgressTracker, but ProgressTracker depends on nothing)
```

**Benefits:**
- Each module can be tested independently
- Clear dependency graph
- Easier to understand data flow
- Prevents infinite loops and subtle bugs

### Why IndexedDB Instead of LocalStorage?

- **LocalStorage:** 5-10MB limit, synchronous (blocks UI), string only
- **IndexedDB:** Hundreds of MB+, asynchronous, structured data, indexed queries
- **Our Use Case:** Store transfer metadata, chunk validation data, crash recovery state

## Project-Specific Conventions

### Constants Over Magic Numbers

❌ **Bad:**
```javascript
const chunkSize = 16384; // What is this number?
```

✅ **Good:**
```javascript
import { NETWORK_CHUNK_SIZE } from '@/constants/transfer.constants';
// NETWORK_CHUNK_SIZE = 16KB (WebRTC DataChannel maximum)
```

### Repository Pattern for Data Access

❌ **Bad:**
```javascript
// Direct IndexedDB access scattered everywhere
const db = await openDB('mydb');
const tx = db.transaction('transfers', 'readwrite');
```

✅ **Good:**
```javascript
import { transfersRepository } from '@/infrastructure/database';
const result = await transfersRepository.saveTransfer(transferData);
```

### Event-Based Services

Services emit events, UI subscribes:

```javascript
// Service emits events
transferOrchestrator.on('progress', (data) => {
  console.log(`Progress: ${data.percentage}%`);
});

// Not: Polling service state every 100ms
```

### Single Source of Truth for Progress

All progress flows through `ProgressTracker`:

```javascript
// ✅ Good: All modules update ProgressTracker
progressTracker.updateProgress(bytesTransferred);

// ❌ Bad: Duplicate progress in store, service, component
```

## Next Steps

Now that you understand the basics:

1. **Read the code:** Start with [Room/index.jsx](../src/pages/Room/index.jsx) and follow the flow
2. **Try a small change:** Add a log message, change a timeout value
3. **Read detailed docs:**
   - [TRANSFER_FLOW.md](TRANSFER_FLOW.md) - Deep dive into transfer lifecycle
   - [ADDING_FEATURES.md](ADDING_FEATURES.md) - Step-by-step feature guides
   - [DEBUGGING.md](DEBUGGING.md) - Troubleshooting common issues
4. **Explore the tests:** See how modules are tested in isolation
5. **Ask questions:** Open an issue if anything is unclear!

## Quick Reference

### Important Files for Each Feature

| Feature | Key Files |
|---------|-----------|
| **Room Creation** | `pages/Room/hooks/useRoomConnection.js`, `services/ConnectionService.js` |
| **WebRTC Connection** | `services/ConnectionService.js`, `utils/p2pManager.js`, `utils/signaling.js` |
| **TOFU Security** | `services/SecurityService.js`, `utils/tofuSecurity.js` |
| **File Sending** | `transfer/sending/ChunkingEngine.js`, `transfer/sending/BufferManager.js` |
| **File Receiving** | `transfer/receiving/FileReceiver.js`, `transfer/receiving/AssemblyEngine.js` |
| **Progress Tracking** | `transfer/shared/ProgressTracker.js` |
| **Pause/Resume** | `transfer/resumption/ResumableTransferManager.js` |
| **Data Persistence** | `infrastructure/database/`, `infrastructure/storage/` |

### Common Debugging Commands

```javascript
// Enable verbose logging
localStorage.setItem('DEBUG', 'true');

// Check IndexedDB state
// Chrome DevTools → Application → IndexedDB

// Monitor WebRTC stats
// Chrome: chrome://webrtc-internals/

// Check transfer state in console
import { useTransferStore } from '@/stores/transferStore';
console.log(useTransferStore.getState());
```

### Getting Help

- **Architecture Questions:** Read [ARCHITECTURE.md](../ARCHITECTURE.md)
- **Transfer Flow Questions:** Read [TRANSFER_FLOW.md](TRANSFER_FLOW.md)
- **Bugs/Issues:** See [DEBUGGING.md](DEBUGGING.md)
- **Feature Implementation:** See [ADDING_FEATURES.md](ADDING_FEATURES.md)

Welcome aboard! 🚀
