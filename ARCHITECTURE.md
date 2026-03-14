# Architecture Guide

This document describes the architectural principles, folder structure, and coding conventions for this P2P file transfer application.

## Overview

The application follows a **layered architecture** with clear separation of concerns:

```
┌─────────────────────────────────────┐
│         UI Layer (React)             │  Pages, Components, Hooks
├─────────────────────────────────────┤
│   Domain/Transfer Layer              │  Transfer Engines, Protocols
├─────────────────────────────────────┤
│    Utility / Infrastructure Layer    │  Helpers, Storage, Database, I/O
├─────────────────────────────────────┤
│      Library Layer                   │  Pure Functions, Constants
└─────────────────────────────────────┘
```

> **Note:** Business logic orchestration (connection management, messaging, security verification)
> lives in React hooks under `src/pages/Room/hooks/`, not in a separate services layer.

## Folder Structure

### `/src/constants/`
**Configuration and constant values**

All magic numbers, configuration values, and enums live here with explanatory comments.

- `transfer.constants.js` - Chunk sizes, buffer limits, transfer states
- `network.constants.js` - Timeouts, retry limits, ICE servers
- `timing.constants.js` - Delays and intervals with explanations
- `messages.constants.js` - Protocol message types and enums

**Rules:**
- ✅ Export named constants with UPPER_SNAKE_CASE
- ✅ Include JSDoc comments explaining WHY each value is chosen
- ✅ Group related constants together
- ❌ No logic or computed values (pure constants only)

**Example:**
```javascript
/**
 * STORAGE_CHUNK_SIZE: 64KB
 * 
 * Used for IndexedDB storage and file system operations.
 * Larger chunks reduce storage overhead and improve disk I/O performance.
 */
export const STORAGE_CHUNK_SIZE = 64 * 1024;
```

---

### `/src/lib/`
**Pure utility functions**

Stateless, side-effect-free functions for common operations. These don't depend on app state.

- `formatters.js` - formatBytes(), formatDuration(), formatSpeed()
- `validators.js` - validateFileMetadata(), sanitizeFilename()
- `errors.js` - Custom error classes (TransferError, ConnectionError, etc.)

**Rules:**
- ✅ Pure functions only (same input → same output)
- ✅ No side effects (no state modification, API calls, etc.)
- ✅ Fully unit testable
- ✅ Complete JSDoc with examples
- ❌ No imports from other app modules (except other lib files)

**Example:**
```javascript
/**
 * Format bytes to human-readable string
 * @param {number} bytes - The byte value to format
 * @returns {string} Formatted string (e.g., "1.50 MB")
 */
export function formatBytes(bytes) {
  // ... implementation
}
```

---

### `/src/infrastructure/`
**Low-level data access and I/O**

Handles persistence, storage, and external system interactions.

- `database/` - IndexedDB repositories (transfers, chunks, files, sessions)
- `storage/` - File system operations (write queue, file writer)

**Rules:**
- ✅ Repository pattern for data access
- ✅ Encapsulate storage implementation details
- ✅ Return result objects (success/failure)
- ✅ Handle errors gracefully
- ❌ No business logic (just data CRUD)

---

### `/src/transfer/`
**Transfer engine and protocol**

Core file transfer logic: chunking, assembly, validation, resumption.

- `sending/` - ChunkingEngine
- `receiving/` - AssemblyEngine, ChunkValidator
- `resumption/` - ResumableTransferManager
- `shared/` - ProgressTracker (single source of truth)
- `multichannel/` - ChannelPool, BandwidthMonitor
- `multifile/` - MultiFileTransferManager, MultiFileReceiver, ZipStreamWriter, FileQueue
- `metadata/` - fileMetadata (canonical metadata utilities)

**Rules:**
- ✅ Single responsibility per module
- ✅ NO circular dependencies (enforce acyclic graph)
- ✅ Use ProgressTracker for all progress (no duplicates)
- ✅ Export classes (not singleton instances)
- ❌ No direct UI imports
- ❌ No duplicate progress/state tracking

---

### `/src/utils/`
**Helper utilities**

Single-purpose helper modules that don't fit infrastructure or lib.

- `signaling.js` - WebSocket signaling client
- `p2pManager.js` - WebRTC connection setup
- `tofuSecurity.js` - Encrypted signaling (AES-GCM key derivation)
- `identityManager.js` - Device identity & session verification
- `connectionMonitor.js` - Connection health monitoring (RTT, packet loss, quality badge)
- `transferNotifications.js` - Activity log events + browser notifications
- `heartbeatMonitor.js` - WebRTC heartbeat for disconnection detection
- `bandwidthTester.js` - Network bandwidth testing *(currently unused)*
- `networkSpeedTest.js` - Speed measurement utilities *(currently unused)*
- `logger.js` - Logging utility
- `qrCode.js` - QR code generation

**Rules:**
- ✅ Focused, single-purpose modules
- ✅ Can have side effects (unlike lib/)
- ✅ Document API with JSDoc
- ❌ Keep small (< 300 lines per file)

---

### `/src/stores/`
**Zustand state stores**

Global state for cross-component data sharing.

- `roomStore.js` - Room metadata, participant list
- `transferStore.js` - Transfer history, user preferences

**Rules:**
- ✅ Store ONLY UI-relevant, cross-page state
- ✅ Use for: history, preferences, UI state, resume context
- ❌ NO duplicate state from transfer layer
- ❌ NO progress/transfer state (managed by hooks/transfer engines)

**State Ownership:**
- **Custom Hooks:** Active transfer state, connection status, progress
- **Stores:** Transfer history, room metadata, resume context
- **Components:** Local UI state (modals, forms, tabs)

---

### `/src/pages/`
**Page components**

Top-level route components.

- `Home.jsx` - Landing page
- `Room/` - Transfer room (decomposed into hooks + components)
  - `index.jsx` - Main component (compositional)
  - `hooks/` - Custom React hooks (useRoomConnection, useFileTransfer, useMultiFileTransfer, useMessages, useSecurity, etc.)
  - `components/` - Page-specific UI components
    - `TransferSection.jsx` - File selection, progress, completion, error states, ZIP toggle
    - `SpeedGraph.jsx` - Canvas-based real-time throughput chart (30-second window)
    - `TextShareSection.jsx` - Chat-style text/clipboard sharing between peers
    - `ConnectionSection.jsx` - Connection status display *(currently unused — status rendered inline)*
    - `SecuritySection.jsx` - Security info display *(currently unused — rendered inline)*

**Rules:**
- ✅ Composition over complexity (< 200 lines main component)
- ✅ Extract logic into custom hooks
- ✅ Extract UI into sub-components
- ✅ Use custom hooks for business logic
- ❌ NO business logic in components (use hooks)
- ❌ NO direct database/WebRTC access

---

### `/src/components/`
**Reusable UI components**

Shared components used across multiple pages.

- `shared/` - Generic reusable components

**Rules:**
- ✅ Presentational components (props in, UI out)
- ✅ No business logic
- ✅ Reusable across pages

---

## Import Rules

### Dependency Flow (Must be Acyclic!)

```
UI Layer
  ↓ (can import)
Transfer / Utils
  ↓ (can import)
Infrastructure
  ↓ (can import)
Lib / Constants
```

**Allowed:**
```javascript
// ✅ UI imports transfer engine
import { ChunkingEngine } from '@/transfer';

// ✅ Hooks orchestrate transfer logic
import { useFileTransfer } from '@/pages/Room/hooks';

// ✅ Transfer imports infrastructure
import { saveChunk } from '@/infrastructure';

// ✅ Anyone imports lib/constants
import { formatBytes } from '@/lib';
import { STORAGE_CHUNK_SIZE } from '@/constants';
```

**Forbidden:**
```javascript
// ❌ Infrastructure imports transfer
import { ChunkingEngine } from '@/transfer';

// ❌ Circular dependencies
// moduleA.js imports moduleB.js
// moduleB.js imports moduleA.js
```

---

## Code Conventions

### Export Style

**Use named exports consistently:**

```javascript
// ✅ Good
export function formatBytes(bytes) { }
export class TransferError extends Error { }
export const CHUNK_SIZE = 64 * 1024;

// ❌ Avoid
export default { formatBytes, TransferError, CHUNK_SIZE };
```

**Rationale:**
- Tree-shakeable (better bundle size)
- Better IDE autocomplete
- Easier refactoring
- Clear dependencies

---

### Error Handling

**Use custom error classes:**

```javascript
import { TransferError, ConnectionError, StorageError } from '@/lib/errors';

// ✅ Good
throw new TransferError('Chunk validation failed', {
  chunkId: 123,
  expected: 'abc',
  actual: 'xyz'
});

// ❌ Avoid
throw new Error('Chunk validation failed');
```

**Return result objects for recoverable errors:**

```javascript
// ✅ Good
function saveChunk(chunk) {
  try {
    // ... save logic
    return { success: true, chunkId: chunk.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Use in calling code
const result = saveChunk(chunk);
if (!result.success) {
  logger.error('Save failed:', result.error);
}
```

---

### Async Patterns

**Use async/await consistently:**

```javascript
// ✅ Good
export async function startTransfer(file) {
  try {
    const metadata = await prepareFile(file);
    const result = await sendChunks(metadata);
    return result;
  } catch (err) {
    throw new TransferError('Transfer failed', { file: file.name, error: err });
  }
}

// ❌ Avoid mixing patterns
function startTransfer(file) {
  return new Promise((resolve, reject) => {
    prepareFile(file).then(metadata => {
      sendChunks(metadata, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  });
}
```

---

### Documentation

**Add JSDoc to all public APIs:**

```javascript
/**
 * Start file transfer to connected peer
 * 
 * Chunks the file, sends metadata, and begins streaming chunks
 * over the WebRTC DataChannel.
 * 
 * @param {File} file - File to transfer
 * @param {RTCDataChannel} channel - Active data channel
 * @returns {Promise<string>} Transfer ID
 * @throws {TransferError} If file is invalid or transfer fails to start
 * 
 * @example
 * const transferId = await startTransfer(selectedFile, dataChannel);
 * console.log('Transfer started:', transferId);
 */
export async function startTransfer(file, channel) {
  // ...
}
```

**Include examples for complex functions:**
- Show typical usage
- Include edge cases if relevant
- Keep examples concise

---

## State Management Strategy

### Single Source of Truth

Each piece of state should have ONE owner:

| State | Owner | Accessed By |
|-------|-------|-------------|
| Active transfer progress | ProgressTracker (transfer/) | Hooks, UI via callbacks |
| Connection status | Custom hooks (Room/hooks/) | UI components |
| Transfer history | transferStore (Zustand) | UI components |
| Room participants | roomStore (Zustand) | UI components |
| Resume context | roomStore (Zustand) | Room hooks |
| UI modals/tabs | Component local state | N/A |

### Anti-Pattern: Duplicate State

```javascript
// ❌ BAD: Progress tracked in 3 places!
// chunkingEngine tracks progress
// fileReceiver tracks progress
// Room.jsx tracks progress in state

// ✅ GOOD: Single ProgressTracker
// chunkingEngine.updateProgress() → ProgressTracker
// fileReceiver.updateProgress() → ProgressTracker
// UI subscribes to ProgressTracker events
```

---

## Testing Strategy

### Unit Tests
- **lib/**: Test all pure functions
- **infrastructure/**: Mock IndexedDB, test repositories
- **transfer/**: Test chunking logic, validation
- **hooks/**: Test with mocked dependencies

### Integration Tests
- Test hook → transfer → infrastructure flow
- Test full transfer lifecycle
- Test pause/resume scenarios

### E2E Tests (Optional)
- Full browser-to-browser transfer
- Network condition simulation

---

## Performance Considerations

### Chunk Sizes
- **Default chunk:** 64KB (adaptive 16KB–256KB based on throughput)
- **Mobile default:** 64KB with 256KB buffer watermark
- **ACK batching:** Every 50 chunks to reduce overhead
- **Scale-up threshold:** 500KB/s throughput triggers larger chunks

### Memory Management
- Buffer maximum 100 chunks (~6.4MB)
- Stream large files (don't load all into memory)
- Clean up IndexedDB after successful transfers
- ZIP mode: files written sequentially to avoid buffering entire archive

### Progress Updates
- Throttle UI updates (every 100ms)
- Use RAF for smooth progress bars
- Batch chunk notifications

---

## Architecture Notes

The codebase was originally planned to have a Service Layer (ConnectionService, SecurityService,
TransferOrchestrator, MessageService) but this was never implemented. All business logic lives
in custom React hooks (`pages/Room/hooks/`) that directly use the transfer layer and utilities.
This keeps the codebase simpler with fewer abstraction layers. The `src/services/` directory
does not exist.

---

## Questions or Issues?

When adding new features:
1. Identify the correct layer (infrastructure, transfer, hooks, UI)
2. Follow the import rules (no upward dependencies)
3. Use constants instead of magic numbers
4. Add JSDoc documentation
5. Use appropriate error classes
6. Maintain single source of truth for state

See `docs/ADDING_FEATURES.md` for step-by-step guides (coming in Phase 7).
