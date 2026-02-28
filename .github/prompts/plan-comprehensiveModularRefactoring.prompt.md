# Plan: Comprehensive Modular Refactoring (Bottom-Up, Phased)

This plan transforms your P2P file transfer app from a functionally-excellent but architecturally-fragile codebase into a maintainable, modular system. We'll work systematically from infrastructure up through services to UI, delivering working code after each phase.

**Key Goals:**
- Reduce [Room.jsx](src/pages/Room.jsx) from 1,401 lines to ~150 lines
- Eliminate circular dependencies between [chunkingSystem.js](src/utils/chunkingSystem.js), [fileReceiver.js](src/utils/fileReceiver.js), and [resumableTransfer.js](src/utils/resumableTransfer.js)
- Create clean service layer for new developers to understand
- Establish consistent patterns and comprehensive documentation

---

## **Phase 1: Foundation & Patterns** (3-5 hours)
*Establish standards, extract constants, fix simple utilities*

**Steps:**
1. Create `src/constants/` folder with organized constant files:
   - `transfer.constants.js` - CHUNK_SIZE, BUFFER_SIZE with explanatory comments
   - `network.constants.js` - TIMEOUT values, RETRY_ATTEMPTS
   - `timing.constants.js` - All magic number timeouts with reasons
   - `messages.constants.js` - Message type enums from Room.jsx

2. Create `src/lib/` for pure utility functions:
   - Extract `formatBytes()` from [Home.jsx](src/pages/Home.jsx) and [RoomUI.jsx](src/components/RoomUI.jsx) to `lib/formatters.js`
   - Create `lib/errors.js` with standardized error classes (`TransferError`, `ConnectionError`, `SecurityError`)
   - Move pure functions from utils into lib (validation helpers, format helpers)

3. Standardize existing small utilities:
   - Add JSDoc to [logger.js](src/utils/logger.js), [qrCode.js](src/utils/qrCode.js)
   - Choose consistent export pattern (named exports only)
   - Update [connectionMonitor.js](src/utils/connectionMonitor.js) to use new error classes

4. Create `ARCHITECTURE.md` documenting:
   - New folder structure and conventions
   - Layer responsibilities (UI → Services → Utils → Infrastructure)
   - Import rules (no circular dependencies)
   - Code style guide

**Verification:** 
- All files import constants from constants/
- No duplicate formatBytes implementations
- Linter passes, all tests green

---

## **Phase 2: Infrastructure Layer Cleanup** (4-6 hours)
*Fix IndexedDB, file system, and data persistence without changing APIs*

**Steps:**
1. Create `src/infrastructure/` folder and reorganize:
   - Move [indexedDB.js](src/utils/indexedDB.js) → `infrastructure/database/`
   - Split into smaller modules:
     - `database/transfers.repository.js` - Transfer CRUD operations
     - `database/chunks.repository.js` - Chunk storage operations  
     - `database/metadata.repository.js` - File metadata operations
     - `database/client.js` - Base DB connection and schema
   
2. Refactor [fileSystem.js](src/utils/fileSystem.js):
   - Extract sequential write queue into `infrastructure/storage/WriteQueue.js`
   - Create `infrastructure/storage/FileWriter.js` with clean interface
   - Add proper error handling and recovery

3. Update [fileMetadata.js](src/utils/fileMetadata.js):
   - Move to `infrastructure/metadata/`
   - Add validateMetadata(), sanitizeFilename() functions
   - Document metadata schema

4. Create thin adapter layer:
   - `infrastructure/index.js` exports clean API
   - Other code doesn't need to know about implementation details

**Verification:**
- All database operations go through repository pattern
- No direct IndexedDB calls outside infrastructure/
- File writing is centralized

---

## **Phase 3: Break Circular Dependencies** (5-7 hours)
*Split chunking, receiving, and resumable transfer into clean modules*

**Steps:**
1. Split [chunkingSystem.js](src/utils/chunkingSystem.js) into transfer/ folder:
   - `transfer/sending/ChunkingEngine.js` (sender logic only, ~350 lines)
   - `transfer/sending/BufferManager.js` (chunk buffering logic)
   - `transfer/receiving/AssemblyEngine.js` (receiver logic, ~300 lines)
   - `transfer/receiving/ChunkValidator.js` (validation, checksums)
   - `transfer/shared/ProgressTracker.js` (single source of truth for progress)
   - `transfer/index.js` (clean exports)

2. Refactor [fileReceiver.js](src/utils/fileReceiver.js):
   - Rename to `transfer/receiving/FileReceiver.js`
   - Remove singleton export (just export class)
   - Use ProgressTracker instead of own progress logic
   - Delegate to ChunkValidator for validation
   - Use infrastructure/storage for writes

3. Refactor [resumableTransfer.js](src/utils/resumableTransfer.js):
   - Move to `transfer/resumption/ResumableTransferManager.js`
   - Extract pause/resume coordination into `transfer/resumption/TransferStateManager.js`
   - Remove duplicate progress tracking - use ProgressTracker
   - Use database repositories for persistence

4. Create dependency flow:
   ```
   FileReceiver → AssemblyEngine → ChunkValidator → ProgressTracker
   ChunkingEngine → BufferManager → ProgressTracker
   ResumableTransferManager → database repositories
   (No circular dependencies!)
   ```

**Verification:**
- Draw dependency graph - should be acyclic
- Each module has single responsibility
- Progress is tracked in exactly one place

---

## **Phase 4: Service Layer Creation** (6-8 hours)  
*Create orchestration layer that Room.jsx will use*

**Steps:**
1. Create `src/services/connection/ConnectionService.js`:
   - Manages WebRTC connection lifecycle
   - Uses [signaling.js](src/utils/signaling.js) internally
   - Uses [p2pManager.js](src/utils/p2pManager.js) internally  
   - Exposes clean event-based API: `onConnected`, `onDisconnected`, `onDataChannelReady`
   - Integrates [connectionMonitor.js](src/utils/connectionMonitor.js)

2. Create `src/services/security/SecurityService.js`:
   - Wraps [tofuSecurity.js](src/utils/tofuSecurity.js)
   - Manages TOFU verification workflow
   - Exposes: `verifyPeer()`, `getPeerStatus()`, `getTrustLevel()`

3. Create `src/services/transfer/TransferOrchestrator.js`:
   - **This is the key service new developers will understand**
   - Coordinates ChunkingEngine (sending) and FileReceiver (receiving)
   - Manages pause/resume through ResumableTransferManager
   - Handles transfer lifecycle: `startSending()`, `startReceiving()`, `pause()`, `resume()`, `cancel()`
   - Emits events: `onProgress`, `onComplete`, `onError`, `onPaused`
   - Uses ProgressTracker for all progress updates

4. Create `src/services/messaging/MessageService.js`:
   - Extract 200-line message handler switch from Room.jsx
   - Protocol handling: parse, validate, route messages
   - Type-safe message builders
   - Delegates to appropriate services (TransferOrchestrator, SecurityService, etc.)

5. Create `src/services/index.js`:
   - Exports AppService that composes all services
   - Provides unified API for UI layer

**Verification:**
- Services don't import React 
- Services can be unit tested without UI
- Clear separation: Services call utils, UI calls services

---

## **Phase 5: Room.jsx Decomposition** (8-10 hours)
*Transform 1,401-line god component into clean, focused modules*

**Steps:**
1. Create `src/pages/Room/` folder structure:
   ```
   Room/
   ├── index.jsx                    (~150 lines - main component)
   ├── hooks/
   │   ├── useRoomConnection.js     (ConnectionService integration)
   │   ├── useFileTransfer.js       (TransferOrchestrator integration)
   │   ├── useSecurity.js           (SecurityService integration)  
   │   ├── useMessages.js           (MessageService integration)
   │   └── useRoomState.js          (Local UI state only)
   ├── components/
   │   ├── ConnectionSection.jsx    (Connection status UI)
   │   ├── SecuritySection.jsx      (TOFU verification UI)
   │   ├── TransferSection.jsx      (File transfer UI)
   │   ├── ActivityLog.jsx          (Activity feed)
   │   └── index.js
   └── README.md                    (Explains Room page architecture)
   ```

2. Extract custom hooks from Room.jsx:
   - `useRoomConnection.js` - Manages `ConnectionService`, socket state
   - `useFileTransfer.js` - Manages `TransferOrchestrator`, file selection, progress
   - `useSecurity.js` - Manages `SecurityService`, TOFU flow, verification UI
   - `useMessages.js` - Manages `MessageService`, message handling
   - `useRoomState.js` - Only UI-specific state (modals, tabs, alerts)

3. Extract UI sections into focused components:
   - `ConnectionSection.jsx` - Renders connection status, QR code, room ID
   - `SecuritySection.jsx` - Renders TOFU verification UI  
   - `TransferSection.jsx` - Renders file picker, progress bars, pause/resume
   - `ActivityLog.jsx` - Renders activity feed

4. Refactor `Room/index.jsx`:
   ```jsx
   export default function Room() {
     const connection = useRoomConnection();
     const transfer = useFileTransfer(connection);
     const security = useSecurity(connection);
     const messages = useMessages(connection, transfer, security);
     const uiState = useRoomState();
     
     return (
       <>
         <ConnectionSection {...connection} />
         <SecuritySection {...security} />
         <TransferSection {...transfer} />
         <ActivityLog {...messages} />
       </>
     );
   }
   ```

5. Move reusable UI components from [RoomUI.jsx](src/components/RoomUI.jsx) to `components/shared/`:
   - Extract progress bars, status badges, file cards
   - Keep Room-specific UI in `Room/components/`

**Verification:**
- Room/index.jsx is under 200 lines
- Each hook has single responsibility
- Components are purely presentational
- Easy to trace: User action → Hook → Service → Utils

---

## **Phase 6: Zustand Store Cleanup** (2-3 hours)
*Eliminate state duplication, clarify store responsibility*

**Steps:**
1. Simplify [roomStore.js](src/stores/roomStore.js):
   - Remove duplicate connection state (managed by ConnectionService)
   - Keep only: room metadata, participant list, room history
   - Document what should live in store vs service vs component state

2. Refactor [transferStore.js](src/stores/transferStore.js):
   - Remove duplicate progress (managed by ProgressTracker)
   - Remove duplicate pause state (managed by ResumableTransferManager)
   - Keep only: transfer history for UI, user preferences (auto-accept settings)
   - Remove localStorage persistence (conflicts with IndexedDB)

3. Add `stores/README.md`:
   - Explain store vs service state
   - Document when to useStore vs use service directly

**Verification:**
- No progress state in stores (delegated to services)
- Single persistence mechanism (IndexedDB)
- Stores contain only UI-relevant, cross-page state

---

## **Phase 7: Code Quality & Documentation** (4-5 hours)
*Polish, document, and make the codebase welcoming*

**Steps:**
1. Add comprehensive JSDoc to all public APIs:
   - Services (TransferOrchestrator, ConnectionService, etc.)
   - Infrastructure repositories
   - Transfer modules
   - Include examples in JSDoc for complex functions

2. Create developer onboarding docs:
   - `docs/NEW_DEVELOPER_GUIDE.md` - Where to start, how code is organized
   - `docs/ADDING_FEATURES.md` - How to add new features following architecture
   - `docs/TRANSFER_FLOW.md` - Detailed transfer lifecycle with sequence diagrams
   - `docs/DEBUGGING.md` - Common issues and debugging strategies

3. Update existing documentation:
   - Update [README.md](README.md) with new architecture
   - Update [flow.md](flow.md) with service layer
   - Add architecture diagram showing layers

4. Add inline comments for complex algorithms:
   - Document adaptive chunk sizing in ChunkingEngine
   - Explain out-of-order chunk handling in AssemblyEngine
   - Comment TOFU verification flow
   - Explain write queue sequencing

5. Create examples:
   - `examples/custom-transfer-handler.js` - How to extend TransferOrchestrator
   - `examples/adding-a-message-type.js` - How to add new protocol messages

**Verification:**
- New developer can understand transfer flow in 30 minutes
- Every public function has JSDoc
- Complex algorithms have explanatory comments
- Architecture is documented with diagrams

---

## **Phase 8: Testing Infrastructure** (Optional, 3-4 hours)
*Make the codebase testable*

**Steps:**
1. Add dependency injection to services:
   - Services accept dependencies in constructor
   - Makes mocking easy for tests

2. Create test utilities:
   - Mock implementations of services
   - Factories for test data (files, chunks, metadata)
   - Test helpers for IndexedDB

3. Add example tests:
   - Unit test for ProgressTracker
   - Integration test for TransferOrchestrator
   - Hook test for useFileTransfer

4. Document testing approach in `docs/TESTING.md`

---

## **Final Structure**

```
src/
├── constants/              # All configuration constants
│   ├── transfer.constants.js
│   ├── network.constants.js
│   ├── timing.constants.js
│   └── messages.constants.js
├── lib/                    # Pure utility functions
│   ├── formatters.js
│   ├── errors.js
│   └── validators.js
├── infrastructure/         # Low-level data access
│   ├── database/
│   │   ├── client.js
│   │   ├── transfers.repository.js
│   │   ├── chunks.repository.js
│   │   └── metadata.repository.js
│   ├── storage/
│   │   ├── WriteQueue.js
│   │   └── FileWriter.js
│   └── index.js
├── transfer/               # Transfer engine (no circular deps!)
│   ├── sending/
│   │   ├── ChunkingEngine.js
│   │   └── BufferManager.js
│   ├── receiving/
│   │   ├── AssemblyEngine.js
│   │   ├── FileReceiver.js
│   │   └── ChunkValidator.js
│   ├── resumption/
│   │   ├── ResumableTransferManager.js
│   │   └── TransferStateManager.js
│   ├── shared/
│   │   └── ProgressTracker.js
│   └── index.js
├── services/               # Business logic orchestration
│   ├── connection/
│   │   └── ConnectionService.js
│   ├── security/
│   │   └── SecurityService.js
│   ├── transfer/
│   │   └── TransferOrchestrator.js
│   ├── messaging/
│   │   └── MessageService.js
│   └── index.js
├── utils/                  # Remaining utilities (identityManager, logger, etc.)
│   ├── identityManager.js
│   ├── logger.js
│   ├── qrCode.js
│   ├── connectionMonitor.js
│   ├── signaling.js  (used by ConnectionService)
│   ├── p2pManager.js (used by ConnectionService)
│   └── tofuSecurity.js (used by SecurityService)
├── stores/                 # Zustand stores (minimal)
│   ├── roomStore.js
│   └── transferStore.js
├── pages/
│   ├── Home.jsx
│   └── Room/
│       ├── index.jsx
│       ├── hooks/
│       │   ├── useRoomConnection.js
│       │   ├── useFileTransfer.js
│       │   ├── useSecurity.js
│       │   ├── useMessages.js
│       │   └── useRoomState.js
│       ├── components/
│       │   ├── ConnectionSection.jsx
│       │   ├── SecuritySection.jsx
│       │   ├── TransferSection.jsx
│       │   └── ActivityLog.jsx
│       └── README.md
├── components/
│   ├── shared/         # Reusable components
│   └── RoomUI.jsx      # Becomes just shared component exports
└── docs/               # Developer documentation
    ├── ARCHITECTURE.md
    ├── NEW_DEVELOPER_GUIDE.md
    ├── ADDING_FEATURES.md
    ├── TRANSFER_FLOW.md
    └── DEBUGGING.md
```

---

## **Key Decisions**

- **Bottom-up approach**: Fix infrastructure first so services have clean foundation
- **Service layer pattern**: Clear separation between UI and business logic
- **Repository pattern**: Centralized data access through infrastructure layer
- **Event-based services**: Services emit events, UI subscribes (decoupled)
- **Single source of truth**: Progress in ProgressTracker, state in services, not duplicated
- **No singletons**: Export classes, let services instantiate (testable)
- **Named exports only**: Consistent, tree-shakeable, easier to refactor
- **JSDoc everywhere**: Self-documenting codebase for new developers

---

## **Success Criteria**

After completing this refactoring:
- New developers can understand the codebase in hours, not days
- Room.jsx is under 200 lines and purely compositional
- No circular dependencies in the dependency graph
- All business logic lives in testable services
- Progress tracking happens in exactly one place
- Each file has a single, clear responsibility
- Documentation explains both "what" and "why"
- The application maintains 100% of its current functionality
