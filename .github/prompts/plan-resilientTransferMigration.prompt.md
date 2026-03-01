# Plan: Fix New Layer, Add Resilient Resume, Clean Up Dead Code

**TL;DR**: The codebase has two parallel implementations — an OLD working one in `utils/` and a NEW refactored one in `src/transfer/`, `src/services/`, `src/infrastructure/` that is completely broken (13+ import mismatches, no React integration, sends data as base64 instead of binary). The current system has **zero** disconnect resilience — if a peer drops mid-transfer, data is lost. The File System Access API *does* persist partial files to disk, so cross-session resume is feasible without storing binary chunks in IndexedDB. This plan fixes the new layer, wires it to the UI, adds connection-aware transfer pause/resume, enables cross-session resumption, and removes ~3000+ lines of dead/old code.

---

## Phase 1: Fix All Broken Imports in New Layer (13 fixes)

1. **Fix repository namespace imports** — The new layer imports `chunksRepository`, `transfersRepository`, `metadataRepository` as namespace objects, but the repository files export individual functions. Either:
   - Add namespace re-exports to each repository file (e.g., `export const chunksRepository = { saveChunk, getChunksByTransfer, ... }`) mapping the method names the consumers expect (`findByTransferId` → `getChunksByTransfer`, etc.)
   - Fix at: [ResumableTransferManager.js#L10-L11](src/transfer/resumption/ResumableTransferManager.js#L10-L11), [fileMetadata.js#L8-L9](src/transfer/metadata/fileMetadata.js#L8-L9), [transfer/index.js#L23](src/transfer/index.js#L23)

2. **Fix `saveChunkMeta` → `saveChunk`** in [ChunkingEngine.js#L10](src/transfer/sending/ChunkingEngine.js#L10) and [AssemblyEngine.js#L10](src/transfer/receiving/AssemblyEngine.js#L10)

3. **Fix `FileWriter` class import** in [AssemblyEngine.js#L12](src/transfer/receiving/AssemblyEngine.js#L12) — Refactor `AssemblyEngine` to use the functional API (`initFileWriter`, `writeChunk`, `completeWriter`) instead of `new FileWriter()`

4. **Fix ConnectionService p2pManager imports** at [ConnectionService.js#L37-L47](src/services/connection/ConnectionService.js#L37-L47):
   - `createAnswer` → `handleOffer`
   - `addAnswer` → `handleAnswer`
   - `addIceCandidate` → `handleIceCandidate`
   - `closePeerConnection` → add this function to `p2pManager.js` (wrap `peerConnection.close()`)
   - `sendData` → use `getDataChannel()` and call `.send()` directly
   - `getConnectionHealth` → use `connectionMonitor` exports or add the function

5. **Fix `MultiFileTransferManager` to import NEW `ChunkingEngine`** from `../../transfer/sending/ChunkingEngine.js` instead of the old `../../utils/chunkingSystem.js` at [MultiFileTransferManager.js#L12](src/transfer/multifile/MultiFileTransferManager.js#L12)

6. **Reconcile duplicate `createFileMetadata` APIs** — [infrastructure/metadata/index.js](src/infrastructure/metadata/index.js) takes a `File` object, [transfer/metadata/fileMetadata.js](src/transfer/metadata/fileMetadata.js) takes a plain object. Standardize on one.

---

## Phase 2: Fix Architectural Issues

7. **Replace base64 chunk transfer with binary DataChannel** in [TransferOrchestrator.js#L209-L222](src/services/transfer/TransferOrchestrator.js#L209-L222) — The `onChunkReady` callback must send chunk metadata as JSON on channel-0, then send the binary `ArrayBuffer` directly (matching the OLD working approach). Remove all base64 encoding/decoding.

8. **Add `send()` and `sendBinary()` methods to ConnectionService** — Wrap `p2pManager.getDataChannel().send()`. Support JSON messages (stringified) and raw `ArrayBuffer` binary.

9. **Fix MessageService metadata/data pairing** at [MessageService.js#L332-L345](src/services/messaging/MessageService.js#L332-L345) — Buffer the last `chunk-metadata` message so when the subsequent binary `chunk-data` arrives, they can be paired and emitted as a complete `chunkReceived` event with both metadata and binary data.

10. **Wire ChannelPool into TransferOrchestrator** — For multi-channel sending, the orchestrator should use `ChannelPool` to distribute chunks across multiple DataChannels when available, falling back to single-channel.

11. **Bridge SecurityService → signaling encryption** — After `SecurityService.createCredentials()`, call `signaling.setEncryptionKey(key)` automatically. Currently this bridge is missing.

---

## Phase 3: Create React Integration Layer

12. **Create `useAppService()` hook** — A new hook (`src/pages/Room/hooks/useAppService.js`) that:
    - Instantiates `AppService` (which composes `ConnectionService`, `MessageService`, `SecurityService`, `TransferOrchestrator`)
    - Subscribes to service events and maps them to React state (using `useState`/`useRef`)
    - Exposes the same interface that `useRoomConnection`, `useSecurity`, `useFileTransfer` currently provide
    - This is the bridge between the service layer and React

13. **Create `useTransferOrchestrator()` hook** — Replaces `useFileTransfer`. Subscribes to `TransferOrchestrator` events (`progress`, `complete`, `error`, `paused`, `resumed`) and exposes: `transferState`, `transferProgress`, `transferSpeed`, `transferEta`, `isPaused`, `startTransfer()`, `pauseTransfer()`, `resumeTransfer()`, `cancelTransfer()`

14. **Update `useMessages()` hook** — Route DataChannel messages through `MessageService` instead of manual parsing. `MessageService` already categorizes messages by type and emits typed events.

15. **Update [Room/index.jsx](src/pages/Room/index.jsx)** — Replace old hooks with new ones. The component API should remain the same so child components (`FileDropZone`, `RoomUI`, status components) don't need changes.

---

## Phase 4: Add Disconnect-Resilient Transfer Resume

16. **Add connection state watcher to TransferOrchestrator** — Subscribe to `ConnectionService` events:
    - On `'disconnected'` → auto-pause active transfer, save progress to IndexedDB, emit `'auto-paused'`
    - On `'reconnected'` → prompt user to resume (don't auto-resume — the peer may have changed)
    - On `'reconnecting'` → show reconnecting UI state

17. **Implement cross-session resume protocol**:
    - **IndexedDB tracking** (purposeful): On each chunk sent/received, update the chunk status in `chunks` store (already exists, just needs to actually be called). Track `lastCompletedChunk`, `totalChunks`, `fileMetadata`, `transferDirection` in `transfers` store.
    - **Sender resume**: On reconnect or page reload, `checkForRecoverableTransfers()` finds in-progress transfers. UI shows "Resume transfer?" with file info. User re-selects the same file (verified by name + size + lastModified). Sender sends `resume-transfer` message with `transferId` and `lastAcknowledgedChunk`. Chunking resumes from that chunk index.
    - **Receiver resume**: On reconnect, check IndexedDB for in-progress receives. The partial file written via File System Access API persists on disk. User re-selects the partial file via `showSaveFilePicker` (same filename suggested). Open writable with `{ keepExistingData: true }` and seek to `lastWrittenOffset`. Receiver sends `resume-transfer` with `transferId` and list of received chunk indices which drives the sender to skip those.

18. **Add new message types** to [messages.constants.js](src/constants/messages.constants.js):
    - `RESUME_TRANSFER` — `'resume-transfer'` — sent by either peer to propose resuming, includes `transferId`, `receivedChunks[]`, `lastChunkIndex`
    - `RESUME_ACCEPTED` — `'resume-accepted'` — confirms resume, includes `startFromChunk`

19. **Add resume UI** to Room component — Show a banner when recoverable transfers are detected: "Previous transfer of {filename} ({progress}%) can be resumed. [Resume] [Discard]"

20. **Handle File System Access API fallback** — For browsers without FSAPI (Firefox), cross-session resume is not possible (blob accumulation is in-memory). Detect capability at transfer start, track `resumable: boolean` in IndexedDB, and only offer resume for FSAPI transfers.

21. **Add writable stream cleanup** — On error/disconnect, properly close the `FileSystemWritableFileStream` to flush partial data to disk. This is critical for resume — currently the stream may leak on error ([useFileTransfer.js#L367](src/pages/Room/hooks/useFileTransfer.js#L367) doesn't always close it).

---

## Phase 5: Clean Up Dead Code & Redundancy

22. **Delete old utils after migration is complete**:
    - [src/utils/chunkingSystem.js](src/utils/chunkingSystem.js) (~800 lines)
    - [src/utils/fileReceiver.js](src/utils/fileReceiver.js) (~671 lines)
    - [src/utils/resumableTransfer.js](src/utils/resumableTransfer.js)
    - [src/utils/indexedDB.js](src/utils/indexedDB.js) (replaced by `infrastructure/database/`)
    - [src/utils/bandwidthTester.js](src/utils/bandwidthTester.js) (only used by TransferOrchestrator)
    - [src/utils/fileMetadata.js](src/utils/fileMetadata.js) (replaced by `transfer/metadata/`)

23. **Delete backup files**: [src/pages/Room.jsx.backup](src/pages/Room.jsx.backup), [vite.config.js.backup](vite.config.js.backup)

24. **Clean up deprecated store methods** in [transferStore.js](src/stores/transferStore.js) — Remove all no-op methods with `console.warn`: `initiateUpload`, `initiateDownload`, `updateUploadProgress`, `updateDownloadProgress`, `setTransferring`, `setUploadProgress`, `setDownloadProgress`

25. **Clean up deprecated roomStore properties** at [roomStore.js#L153-L159](src/stores/roomStore.js#L153-L159) — Remove `isTransferring`, `uploadProgress`, `downloadProgress` deprecated getters

26. **Remove duplicate `formatBytes`** from [useFileTransfer.js#L76](src/pages/Room/hooks/useFileTransfer.js#L76) — import from [src/lib/formatters.js](src/lib/formatters.js) instead

27. **Extract magic numbers** to constants: `64 * 1024` → `STORAGE_CHUNK_SIZE`, `300ms` completion delay, `3000ms` retry delay → [timing.constants.js](src/constants/timing.constants.js)

---

## Phase 6: Verification & Testing

28. **Unit tests** — Update/add tests for:
    - Repository namespace exports (verify `chunksRepository.saveChunk` etc. work)
    - `ResumableTransferManager` resume logic with IndexedDB mocking
    - `ProgressTracker` subscribing and progress calculation
    - `AssemblyEngine` with functional `FileWriter` API

29. **Integration testing** — Manual test matrix:
    - Happy path: send file, receive file, verify integrity
    - Disconnect mid-transfer → reconnect → verify auto-pause and resume prompt
    - Tab close mid-receive → reopen → verify recoverable transfer detection → re-select file → resume
    - Cancel during transfer → verify IndexedDB cleanup
    - Large file (>1GB) → verify no OOM, stream-based processing
    - Firefox fallback (no FSAPI) → verify blob-based transfer works, no resume offered

30. **Run `eslint`** across the whole project after changes to catch any remaining import errors

---

## Decisions

- **Repository fix approach**: Add namespace adapter objects to repository files rather than rewriting all consumers — less invasive, maintains the clean function-based repository API while satisfying the object-based consumer pattern
- **React integration**: New hooks wrapping services (not replacing React with a different state model) — the component tree stays the same
- **Resume strategy**: File System Access API persistence + IndexedDB chunk tracking (metadata only, never binary). No resume offered on non-FSAPI browsers.
- **Migration order**: Fix imports → fix architecture → create hooks → add resume → delete old code (each phase is independently testable)
