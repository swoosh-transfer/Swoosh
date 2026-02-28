## Plan: Multi-File & Multi-Channel Transfer

**TL;DR:** Add multi-file selection (drag-and-drop, folder drop, file picker) to both Home and Room pages, implement a dynamic multi-channel WebRTC data channel system that auto-scales based on bandwidth, and support both sequential and parallel transfer modes with a user toggle. Folder drops preserve relative paths so the receiver can reconstruct directory structure. This touches the store layer, p2pManager, UI components, transfer protocol, and creates new modules in the empty `multichannel/` and `multifile/` directories.

**Steps**

### Phase 1: Store & Constants

1. Update [src/stores/roomStore.js](src/stores/roomStore.js) — change `selectedFile: null` to `selectedFiles: []` and `setSelectedFile(file)` to `setSelectedFiles(files)` + `addFiles(files)` + `removeFile(index)` + `clearFiles()`. Each entry stores `{ file: File, relativePath: string | null }` to support folder structure preservation.

2. Add new constants in [src/constants/transfer.constants.js](src/constants/transfer.constants.js):
   - `MIN_CHANNELS = 1`, `MAX_CHANNELS = 8`, `INITIAL_CHANNELS = 1`
   - `CHANNEL_SCALE_UP_THRESHOLD` (e.g., sustained >1.5 MB/s for 3 seconds)
   - `CHANNEL_SCALE_DOWN_THRESHOLD` (e.g., <500 KB/s sustained)
   - `CHANNEL_LABEL_PREFIX = 'file-transfer-'`

3. Add new message types in [src/constants/messages.constants.js](src/constants/messages.constants.js):
   - `MULTI_FILE_MANIFEST` — sent before transfer begins, lists all files with index, name, size, mimeType, relativePath, totalChunks
   - `FILE_START` — signals beginning of a specific file in the manifest
   - `FILE_COMPLETE` — signals completion of a specific file
   - `CHANNEL_READY` — handshake per-channel to confirm channel opened
   - `TRANSFER_MODE` — tells receiver whether sequential or parallel mode

### Phase 2: Multi-Channel Data Channel Layer

4. Create [src/transfer/multichannel/ChannelPool.js](src/transfer/multichannel/ChannelPool.js) — a `ChannelPool` class that:
   - Manages N data channels on one `RTCPeerConnection`
   - Creates channels named `file-transfer-0` through `file-transfer-N`
   - Tracks per-channel `bufferedAmount`, implements per-channel `waitForDrain()`
   - Provides `send(channelIndex, data)` and `broadcast(data)` methods
   - Round-robin or least-buffered channel selection via `getAvailableChannel()`
   - Emits events: `channel-open`, `channel-close`, `channel-message`

5. Create [src/transfer/multichannel/BandwidthMonitor.js](src/transfer/multichannel/BandwidthMonitor.js) — monitors aggregate throughput across all channels and recommends scaling:
   - Tracks bytes sent per second across all channels
   - `shouldScaleUp()` / `shouldScaleDown()` based on sustained thresholds
   - `getRecommendedChannelCount()` returns target channel count

6. Create [src/transfer/multichannel/index.js](src/transfer/multichannel/index.js) — exports `ChannelPool` and `BandwidthMonitor`

7. Refactor [src/utils/p2pManager.js](src/utils/p2pManager.js):
   - Replace single `dataChannel` variable with integration to `ChannelPool`
   - `createOffer()` creates initial channel (channel-0); additional channels added dynamically via `addChannel()`
   - `ondatachannel` handler routes incoming channels to `ChannelPool`
   - Export `getChannelPool()` for hooks to access
   - Keep backward-compatible `getDataChannel()` that returns channel-0 for signaling/control messages

### Phase 3: Multi-File Transfer Engine

8. Create [src/transfer/multifile/FileQueue.js](src/transfer/multifile/FileQueue.js) — manages the ordered queue of files to transfer:
   - Accepts array of `{ file, relativePath }` entries
   - Tracks per-file state: `pending`, `sending`, `completed`, `failed`
   - Provides `next()`, `current()`, `getManifest()`, `getProgress()` (overall + per-file)
   - Emits events for file-level state changes

9. Create [src/transfer/multifile/MultiFileTransferManager.js](src/transfer/multifile/MultiFileTransferManager.js) — orchestrates multi-file sending:
   - **Sequential mode:** sends one file at a time, all channels contribute to that file's chunks (round-robin chunk distribution across channels)
   - **Parallel mode:** assigns files to channels (e.g., small files get one channel, large files get multiple), transfers multiple files concurrently
   - Uses `ChannelPool` for data channel access
   - Uses existing `ChunkingEngine` per-file for chunking
   - Coordinates with `BandwidthMonitor` to dynamically add/remove channels mid-transfer
   - Emits aggregate progress, per-file progress, speed, ETA

10. Create [src/transfer/multifile/MultiFileReceiver.js](src/transfer/multifile/MultiFileReceiver.js) — coordinates receiving multiple files:
    - Parses `MULTI_FILE_MANIFEST` to know what to expect
    - Routes incoming chunks by `fileIndex` + `channelIndex` to correct file writer
    - For folder-path files, creates nested directory structure using File System Access API (`getDirectoryHandle()` with `create: true`)
    - Tracks per-file and aggregate completion
    - Falls back to individual downloads for browsers without directory picker

11. Create [src/transfer/multifile/index.js](src/transfer/multifile/index.js) — exports public API

### Phase 4: Protocol Updates

12. Update chunk metadata protocol in the `useFileTransfer` hook and `ChunkingEngine`:
    - Add `fileIndex` field to chunk metadata JSON (identifies which file in the manifest)
    - Add `channelIndex` field so receiver knows which channel the data arrives on
    - Add `totalFiles` and `currentFileIndex` to `file-metadata` messages

13. Create a new `useMultiFileTransfer.js` hook in [src/pages/Room/hooks/](src/pages/Room/hooks/) that wraps `MultiFileTransferManager` and `MultiFileReceiver`:
    - Exposes: `startMultiTransfer()`, `pauseAll()`, `resumeAll()`, `cancelAll()`, `transferMode` (sequential/parallel), `setTransferMode()`
    - Tracks aggregate state: `overallProgress`, `perFileProgress[]`, `speed`, `eta`, `currentFileIndex`
    - Replaces `useFileTransfer` when multiple files are selected (falls back to single-file path for 1 file)

### Phase 5: UI — Shared File Drop Zone Component

14. Create a reusable `FileDropZone` component at [src/components/FileDropZone.jsx](src/components/FileDropZone.jsx):
    - Supports `<input type="file" multiple webkitdirectory>` for file picker + folder picker
    - Drag-and-drop with `onDrop` handling both files and directories via `DataTransferItem.webkitGetAsEntry()` for recursive folder traversal
    - Preserves `relativePath` from `entry.fullPath` or `file.webkitRelativePath`
    - Visual states: empty, dragging, files-selected (shows file list with counts/sizes)
    - File list with remove-individual-file buttons and "Clear all" 
    - Shows aggregate size and file count
    - Props: `files`, `onFilesAdded`, `onFileRemoved`, `onFilesCleared`, `disabled`, `compact` (for Room page)

### Phase 6: UI — Home Page

15. Update [src/pages/Home.jsx](src/pages/Home.jsx):
    - Replace the single-file drag-drop area and `<input type="file">` with `<FileDropZone>`
    - Change `setSelectedFile(file)` calls to `setSelectedFiles(files)` / `addFiles(files)` 
    - Show selected file count and total size in the drop zone
    - Add a "Select Folder" button alongside the file picker
    - Update `handleStartTransfer` to work with `selectedFiles[]` array
    - Analytics emit `fileCount: selectedFiles.length` and `totalBytes: sum of sizes`

### Phase 7: UI — Room Page

16. Update [src/pages/Room/index.jsx](src/pages/Room/index.jsx):
    - Add a compact `<FileDropZone compact>` for the host to add/change files while in the room
    - Wire to `useMultiFileTransfer` hook instead of `useFileTransfer`
    - Add a toggle (pills/switch) for "Sequential / Parallel" transfer mode
    - Replace single-file `TransferSection` props with multi-file arrays

17. Update [src/pages/Room/components/TransferSection.jsx](src/pages/Room/components/TransferSection.jsx):
    - Show file list with per-file progress bars (name, size, individual %)
    - Show overall aggregate progress bar at the top
    - Show current channel count indicator (e.g., "4 channels active")
    - Transfer mode badge (Sequential / Parallel)
    - Keep pause/resume/cancel as aggregate controls

18. Update [src/components/RoomUI.jsx](src/components/RoomUI.jsx):
    - Add `MultiFileInfo` component (file list with statuses) alongside existing `FileInfo`
    - Add `MultiFileProgress` component (overall + per-file progress)
    - Update `IncomingFilePrompt` to show full manifest (file count, total size, folder structure preview)

### Phase 8: Receiver-Side Folder Handling

19. Add directory picker support in the receiver flow:
    - When manifest includes `relativePath` entries, prompt receiver to select a **directory** via `showDirectoryPicker()` instead of individual `showSaveFilePicker()` calls
    - Create subdirectories as needed using the Directory handle API
    - Fallback: if browser doesn't support directory picker, download each file individually with `relativePath` embedded in filename (e.g., `folder_subfolder_file.txt`)

### Phase 9: Hook Updates & Wiring

20. Update [src/pages/Room/hooks/index.js](src/pages/Room/hooks/index.js) to export `useMultiFileTransfer`

21. Update [src/pages/Room/hooks/useRoomConnection.js](src/pages/Room/hooks/useRoomConnection.js):
    - Initialize `ChannelPool` instead of single data channel ref
    - Expose `channelPool` ref, `getChannelCount()`, `addChannel()` methods
    - Keep `sendJSON` and `sendBinary` working via channel-0 for control messages
    - Add `sendOnChannel(channelIndex, data)` for multi-channel data

22. Update [src/pages/Room/hooks/useMessages.js](src/pages/Room/hooks/useMessages.js) (or equivalent message routing):
    - Handle new message types: `MULTI_FILE_MANIFEST`, `FILE_START`, `FILE_COMPLETE`, `CHANNEL_READY`, `TRANSFER_MODE`
    - Route messages from all channels (not just channel-0)

### Phase 10: Dynamic Channel Scaling

23. Implement auto-scaling in `MultiFileTransferManager`:
    - On transfer start: begin with 1 channel
    - Every 3 seconds: consult `BandwidthMonitor`
    - If throughput is high and stable → create additional channel via `ChannelPool.addChannel()` (up to `MAX_CHANNELS`)
    - If throughput drops → close excess channels
    - Both peers negotiate new channels (sender creates, receiver accepts via `ondatachannel`)
    - Log channel scaling events to activity log

**Verification**

- **Unit tests:** Add tests in `src/__tests__/unit/` for `ChannelPool`, `FileQueue`, `BandwidthMonitor` (mock RTCPeerConnection and DataChannel)
- **Manual test — multi-file:** Select 5+ files on Home, verify they show in list, navigate to Room, verify file list persists, send to receiver, verify all files arrive
- **Manual test — folder drop:** Drop a folder with nested subfolders on Home, verify recursive file collection with paths, send to receiver, verify directory structure is recreated
- **Manual test — multi-channel:** Monitor DevTools WebRTC internals (`chrome://webrtc-internals`), verify multiple data channels open and carry data, observe speed improvement vs single channel
- **Manual test — dynamic scaling:** Transfer a large file (>100MB), observe channel count increasing in the UI channel indicator
- **Manual test — mode toggle:** Toggle between Sequential/Parallel mid-queue (before transfer starts), verify behavior changes accordingly
- **Fallback test:** Test in Firefox (no `showDirectoryPicker`), verify individual file downloads work

**Decisions**
- Dynamic channel count (1→8) auto-detected via bandwidth rather than a fixed count
- Both sequential and parallel modes with a user toggle
- Folder paths preserved on receiver side using File System Access Directory API
- New modules go in the existing empty `multichannel/` and `multifile/` directories
- New `useMultiFileTransfer` hook rather than overloading existing `useFileTransfer` — the old hook stays as a fallback for single-file transfers and backward compatibility
- Shared `FileDropZone` component used by both Home and Room pages to avoid duplication
- Channel-0 reserved for control/JSON messages; channels 1+ used for bulk data to avoid head-of-line blocking
