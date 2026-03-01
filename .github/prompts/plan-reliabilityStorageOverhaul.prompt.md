# Plan: Reliable Transfer Storage & Resumption Overhaul

**TL;DR:** The codebase is mid-migration between old `utils/` code and a new layered architecture in `infrastructure/` + `transfer/` + `services/`. The old code is still wired into critical paths (`useFileTransfer`, `main.jsx`), the chunks IndexedDB store is never populated, resume protocol messages are TODO stubs, and the Home page shows failed transfers but can't act on them. This plan fully migrates to the new architecture, implements chunk-level bitmap tracking in IndexedDB, wires up the resume protocol, and makes the Home page functional for selecting and resuming specific failed files in new rooms. Large file binary data continues to flow through the FileSystem API — only metadata/bitmaps go into IndexedDB.

## Phase 1: Unify the IndexedDB Layer (eliminate dual-DB problem)

1. In `src/main.jsx`, replace the import of `initializeDatabase` from `utils/indexedDB.js` with the one from `infrastructure/database/client.js`. This ensures the new layer is the single DB entry point at startup.

2. In `src/infrastructure/database/client.js`, bump `DB_VERSION` to 5 and extend the schema upgrade handler to add a `chunkBitmap` field on the `transfers` store (for storing the compact completion bitmap — see Phase 2).

3. In `src/infrastructure/database/transfers.repository.js`, fix `updateTransfer` to use a single read-write transaction (currently does get-then-put with no transaction guard, creating a race condition).

4. In `src/infrastructure/database/index.js`, fix `cleanupTransferData` — it calls `deleteFileMetadata(transferId)` but the files store uses `fileId` as keyPath. Either store `transferId` on file records and add an index, or look up the file by transfer association first.

5. In `src/infrastructure/database/chunks.repository.js`, fix `getChunksByStatus` to use the existing `status` index instead of fetching all chunks and filtering in JS.

## Phase 2: Implement Chunk Completion Bitmap in Transfer Records

6. Create a new utility `src/infrastructure/database/chunkBitmap.js` that provides:
   - `createBitmap(totalChunks)` → `Uint8Array` (1 bit per chunk, ceil(totalChunks/8) bytes)
   - `markChunk(bitmap, chunkIndex)` → mutates bitmap, sets bit
   - `isChunkComplete(bitmap, chunkIndex)` → boolean
   - `getCompletedCount(bitmap)` → number (popcount)
   - `getMissingChunks(bitmap, totalChunks)` → `number[]`
   - `getFirstMissingChunk(bitmap, totalChunks)` → `number | -1`
   - `serializeBitmap(bitmap)` → base64 string (for IndexedDB storage)
   - `deserializeBitmap(base64)` → `Uint8Array`

   For a 50GB file at 64KB chunks (~781,250 chunks), the bitmap is ~96KB — negligible for IndexedDB.

7. Extend the transfer record schema (in `trackTransferStart` and `saveTransfer`) to include:
   - `chunkBitmap`: base64-encoded completion bitmap
   - `totalChunks`: total expected chunk count
   - `fileHash`: SHA-256 of the first N bytes of the file (for sender-side file re-identification)
   - `fileLastModified`: sender's `file.lastModified` (for file validation on resume)
   - `originalFileName`: original file name
   - `originalFileSize`: original file size
   - For multi-file: `fileManifest` (array of `{fileName, fileSize, relativePath, totalChunks, status, chunkBitmap}`)

## Phase 3: Wire Chunk Tracking into Active Transfer Paths

8. In `src/transfer/multifile/MultiFileTransferManager.js`, after each chunk is sent successfully, update the per-file chunk bitmap in the transfer record. Use a throttled write (every 50 chunks or every 2 seconds, whichever comes first) to avoid IndexedDB write storms. On pause/disconnect, flush the latest bitmap immediately.

9. In `src/transfer/multifile/MultiFileReceiver.js`, after each chunk is written to the FileSystem writable stream, update the per-file chunk bitmap. Same throttling strategy. On `FILE_COMPLETE`, mark all bits for that file and flush.

10. In `src/pages/Room/hooks/useTransferTracking.js`:
    - Restore and implement `trackChunkProgress(transferId, chunkIndex)` — updates the in-memory bitmap copy and queues a throttled IndexedDB flush.
    - On `trackTransferPause` and peer disconnect, immediately flush the current bitmap.
    - `trackTransferComplete` already deletes the record — keep this behavior (completed transfers don't need resumption data).

## Phase 4: Implement Resume Protocol Messages

11. In `src/pages/Room/hooks/useMessages.js`, replace the three `TODO Phase 4` stubs:

    - **`RESUME_TRANSFER` handler (receiver → sender proposal):** Validate `msg.fileHash` and `msg.fileSize` against the current file. If match, respond with `RESUME_ACCEPTED` containing `startFromChunk` (first missing chunk from bitmap). If mismatch, respond with `RESUME_REJECTED` with reason.

    - **`RESUME_ACCEPTED` handler (sender receives acceptance):** Set the `ChunkingEngine`/`MultiFileTransferManager` to skip to `msg.startFromChunk`, begin sending from there. Update transfer tracking state to `'active'`.

    - **`RESUME_REJECTED` handler:** Show user a notification explaining the mismatch. Fall back to full re-transfer or let user re-select the correct file.

12. Add a new message sender function `sendResumeRequest(transferInfo)` in `useMessages` or `useFileTransfer` that sends `RESUME_TRANSFER` with: `transferId`, `fileName`, `fileSize`, `fileHash`, `totalChunks`, `chunkBitmap` (so the sender knows exactly what the receiver already has).

## Phase 5: Multi-File Per-File Granularity for Resume

13. Extend the transfer record's `fileManifest` array to track per-file status: `pending | sending | completed | failed`. On resume, the `MultiFileTransferManager` should:
    - Skip files marked `completed`
    - For files marked `sending` (interrupted mid-transfer), read their `chunkBitmap` and begin from the first missing chunk
    - For files marked `pending`, send normally

14. In `src/transfer/multifile/MultiFileTransferManager.js`, add a `resumeFromManifest(files, savedManifest)` method that:
    - Validates each file against the saved manifest (name, size, lastModified)
    - Creates `ChunkingEngine` instances with `startFromChunk` offset for partially-sent files
    - Sends an updated `MULTI_FILE_MANIFEST` with `isResume: true` and per-file `startFromChunk` values

15. In `src/transfer/multifile/MultiFileReceiver.js`, add `handleResumeManifest(manifest)` that:
    - For completed files: skip (don't re-open writable streams)
    - For partial files: re-open the writable stream at the correct byte offset using `seek()` on the `FileSystemWritableFileStream`
    - For pending files: initialize normally

## Phase 6: Home Page — Resume UI & File Selection

16. In `src/pages/Home.jsx`, transform the incomplete transfers card from passive display to interactive:
    - Make each failed transfer row clickable / add a "Resume" button
    - On click, store the transfer's resumption metadata (`transferId`, `fileName`, `fileSize`, `fileHash`, `totalChunks`, `chunkBitmap`, `direction`, `fileManifest` for multi-file) into the `roomStore` or a new `resumeStore`
    - Navigate to a new room with the resume context (pass via Zustand store, not URL)

17. Add file re-selection flow for the sender side:
    - When the user clicks "Resume" on a send-direction failed transfer, show a file picker dialog
    - Validate the selected file matches the saved metadata (`fileSize`, `fileLastModified`, first-bytes hash)
    - If validated, navigate to a new room with `resumeContext` populated
    - If mismatched, show an error explaining the file doesn't match

18. For receive-direction failed transfers:
    - Check if the FileSystem API file handle is still accessible (handles persist across sessions in some browsers via `queryPermission`/`requestPermission`)
    - If the handle is still valid, allow resume by navigating to a new room and sending a `RESUME_TRANSFER` proposal to the sender once connected
    - If the handle is lost, show a message that the partial file must be discarded

## Phase 7: Room Page — Resume Handshake on Connect

19. In `src/pages/Room/index.jsx`:
    - Check for `resumeContext` from the store on mount
    - If present and peer connects, initiate the resume handshake protocol automatically:
      - Sender: send `RESUME_TRANSFER` proposal with saved bitmap
      - Receiver: wait for `RESUME_TRANSFER` from sender, validate, respond with `RESUME_ACCEPTED`/`RESUME_REJECTED`
    - If no `resumeContext`, proceed with normal fresh transfer flow

20. Add a `useResumeTransfer` hook in `src/pages/Room/hooks/` that encapsulates:
    - Loading resume context from store
    - File validation (sender side)
    - Resume handshake coordination
    - Falling back to fresh transfer if resume fails

## Phase 8: Cut Over from Old Utils to New Architecture

21. In `src/pages/Room/hooks/useFileTransfer.js`:
    - Replace import of `ChunkingEngine` from `utils/chunkingSystem.js` → `transfer/sending/ChunkingEngine.js`
    - Replace import of `fileReceiver` from `utils/fileReceiver.js` → use `AssemblyEngine` from `transfer/receiving/AssemblyEngine.js`
    - Replace import of `resumableTransferManager` from `utils/resumableTransfer.js` → `transfer/resumption/ResumableTransferManager.js`
    - Replace import of `cleanupTransferData` from `utils/indexedDB.js` → `infrastructure/database/index.js`
    - Update all function calls to match the new API signatures

22. Verify `TransferOrchestrator` in `src/services/transfer/TransferOrchestrator.js` is wired up as the coordination layer between hooks and transfer engines. If `useMultiFileTransfer` already bypasses it (going directly to `MultiFileTransferManager`), either:
    - Wire `TransferOrchestrator` as the single entry point, or
    - Remove `TransferOrchestrator` if `MultiFileTransferManager` is the de facto orchestrator (simpler)

23. After all imports are migrated, mark the following old utils as deprecated with `console.warn` on import, to be deleted in a follow-up:
    - `src/utils/indexedDB.js`
    - `src/utils/resumableTransfer.js`
    - `src/utils/fileReceiver.js`
    - `src/utils/chunkingSystem.js`
    - `src/utils/fileSystem.js`

## Phase 9: Edge Case Hardening

24. **Bitmap flush on visibility change:** Add a `visibilitychange` event listener that flushes the current chunk bitmap to IndexedDB when the tab is hidden or about to unload (`beforeunload`). This catches browser kills and tab closures.

25. **Stale transfer cleanup:** In `src/pages/Home.jsx`, auto-discard incomplete transfers older than 7 days (using `cleanupOldTransfers` from the transfers repository, but fix it to batch-delete instead of loop-deleting).

26. **Bandwidth monitor flapping:** In `src/constants/transfer.constants.js`, increase `CHANNEL_SCALE_SUSTAIN_COUNT` from 1 to 3 to require sustained throughput before scaling channels up/down.

27. **Progress tracking unification:** The `ProgressTracker` singleton in `src/transfer/shared/ProgressTracker.js` is the canonical progress source. Wire the UI (`useFileTransfer` state, `useMultiFileTransfer` state) to subscribe to `ProgressTracker` events instead of maintaining parallel progress state via `useState` / custom callbacks.

## Verification

- **Unit tests:** Add tests for `chunkBitmap.js` — create, mark, serialize/deserialize roundtrip, getMissingChunks with various patterns, edge cases (0 chunks, 1 chunk, exactly 8 chunks, large numbers)
- **Integration test — resume flow:** Simulate a transfer that completes 60%, kill it, verify IndexedDB has correct bitmap, restart in new room, verify only remaining 40% is transferred
- **Integration test — multi-file resume:** Transfer 3 files, kill after file 2 completes and file 3 is 50%, verify resume skips files 1-2 and starts file 3 from 50%
- **Manual test — 50GB+ file:** Verify FileSystem API handles persist, bitmap stays small in IndexedDB, no chunk data leaks into IndexedDB
- **Manual test — Home page flow:** Disconnect mid-transfer, go to Home, see failed transfer, click Resume, re-pick file, join new room, verify transfer resumes from correct chunk
- **Regression test:** Verify `beforeunload` / `visibilitychange` flush works, verify stale cleanup runs

## Key Decisions

- **Chunk bitmap over individual chunk rows:** Chose compact bitmap in the transfer record (~96KB for 50GB file) over one IndexedDB row per chunk (781K rows). This keeps IndexedDB fast and avoids write storms.
- **Full migration to new architecture:** Old `utils/` code will be deprecated and replaced, not maintained in parallel. The multi-file path is already on the new code; single-file `useFileTransfer` is the last holdout.
- **Per-file granularity for multi-file resume:** Completed files are skipped entirely. Partially-sent files resume from the first missing chunk. This requires the receiver to `seek()` on the writable stream.
- **TransferOrchestrator decision deferred:** Step 22 evaluates whether to keep it or remove it — depends on whether `useMultiFileTransfer` already serves as the orchestrator.
- **No chunk binary data in IndexedDB:** Confirmed — only metadata and bitmaps. FileSystem API handles all binary data for large files.

## Current Bug Inventory (found during research)

| Issue | Severity | Location |
|-------|----------|----------|
| `useFileTransfer` uses old `utils/` code, not new architecture | High | `src/pages/Room/hooks/useFileTransfer.js` L11-15 |
| Resume protocol messages are TODO stubs | High | `src/pages/Room/hooks/useMessages.js` L253 |
| Chunks IndexedDB store is never written to (trackChunkProgress removed) | High | `src/pages/Room/hooks/useTransferTracking.js` |
| No resume button on Home page — failed transfers are display-only | Medium | `src/pages/Home.jsx` |
| `main.jsx` initializes old `utils/indexedDB.js`, not new infrastructure layer | Medium | `src/main.jsx` L5 |
| Dual `IDBDatabase` singletons for same DB (old + new layers) | Medium | `utils/indexedDB.js` + `infrastructure/database/client.js` |
| `cleanupTransferData` uses wrong key for file metadata deletion | Low | `src/infrastructure/database/index.js` L52 |
| `updateTransfer` has read-then-write race (no transaction guard) | Low | `src/infrastructure/database/transfers.repository.js` |
| `getChunksByStatus` fetches all then filters in JS (ignores index) | Low | `src/infrastructure/database/chunks.repository.js` |
| `TransferOrchestrator` is fully implemented but never imported by any UI code | Low | `src/services/transfer/TransferOrchestrator.js` |
| `ChunkValidator` uses djb2 hash, inconsistent with SHA-256 elsewhere | Low | `src/transfer/receiving/ChunkValidator.js` L187 |
| `CHANNEL_SCALE_SUSTAIN_COUNT = 1` causes aggressive channel flapping | Low | `src/constants/transfer.constants.js` L84 |
| `handleStartTransfer` may create duplicate IndexedDB records (single + multi) | Low | `src/pages/Room/index.jsx` L207-220 |
| Progress tracked via parallel `useState` + custom callbacks, not `ProgressTracker` | Low | `src/pages/Room/hooks/useFileTransfer.js` |
