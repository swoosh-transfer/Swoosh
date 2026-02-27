# Room Page Architecture

This folder contains the refactored Room page, decomposed from a single 1,401-line component into a modular, maintainable architecture.

## Structure

```
Room/
├── index.jsx                    # Main Room component (~200 lines)
├── hooks/                       # Custom hooks for business logic
│   ├── useRoomState.js         # UI state (logs, copy, pending files)
│   ├── useRoomConnection.js    # WebRTC connection lifecycle
│   ├── useSecurity.js          # TOFU verification workflow
│   ├── useFileTransfer.js      # Transfer send/receive/pause/resume
│   ├── useMessages.js          # Message protocol routing
│   └── index.js                # Hook exports
├── components/                  # Presentational UI components
│   ├── ConnectionSection.jsx   # Connection status & QR code
│   ├── SecuritySection.jsx     # TOFU verification status
│   ├── TransferSection.jsx     # File transfer UI
│   ├── ActivityLogSection.jsx  # Activity feed
│   └── index.js                # Component exports
└── README.md                    # This file
```

## Hooks

### useRoomState
**Purpose:** Manages local UI state that doesn't belong in business logic
- Activity logs
- Clipboard copy state
- Pending file information
- Download results
- Crash recovery transfers

**Usage:**
```js
const { logs, addLog, handleCopy, pendingFile, downloadResult } = useRoomState();
```

### useRoomConnection
**Purpose:** Manages WebRTC peer connection and socket lifecycle
- Socket initialization and state tracking
- WebRTC peer connection setup with perfect negotiation
- Data channel creation and management
- Connection state monitoring (ICE, signaling, RTC)
- Automatic reconnection handling

**Usage:**
```js
const { 
  socketConnected, 
  dataChannelReady, 
  sendJSON, 
  sendBinary,
  waitForDrain 
} = useRoomConnection(roomId, isHost, onDataChannelReady, addLog);
```

### useSecurity
**Purpose:** Manages TOFU (Trust On First Use) verification workflow
- Identity handshake with peer UUID
- Challenge/response cryptographic protocol
- TOFU verification state machine
- Pending data queue (chunks received before verification)

**How TOFU Works:**
1. Peers exchange identity handshakes
2. One peer sends a cryptographic challenge
3. Other peer proves knowledge of shared secret
4. Both peers verify and mark connection as trusted
5. Queued data is processed after verification

**Usage:**
```js
const {
  tofuVerified,
  handleHandshake,
  handleTOFUChallenge,
  sendHandshake
} = useSecurity(roomId, sendJSON, addLog);
```

### useFileTransfer
**Purpose:** Manages complete file transfer lifecycle
- **Sending:** Chunked file transfer with progress tracking
- **Receiving:** Sequential chunk assembly with validation
- **Pause/Resume:** Synchronized pause/resume between peers
- **Crash Recovery:** Resume interrupted transfers
- **Retransmission:** Handle missing or corrupted chunks

**Key Features:**
- Uses ChunkingEngine for sending (64KB chunks)
- Uses FileReceiver for receiving (sequential writes)
- Backpressure handling with `waitForDrain`
- Progress tracking with speed and ETA
- Analytics events (transfer-start, transfer-complete, transfer-failed)

**Usage:**
```js
const {
  transferState,
  transferProgress,
  startTransfer,
  pauseTransfer,
  resumeTransfer,
  cancelTransfer
} = useFileTransfer(
  roomId, isHost, selectedFile, securityPayload, 
  tofuVerified, sendJSON, sendBinary, waitForDrain, addLog
);
```

### useMessages
**Purpose:** Routes data channel messages to appropriate handlers
- Handles 13+ message types (handshake, TOFU, file-metadata, chunk-data, etc.)
- Queues chunks until TOFU verification complete
- Coordinates security verification with data processing
- Security: Blocks file data until identity + TOFU verified

**Message Flow:**
```
Binary ArrayBuffer → handleChunkData → receiveChunk
JSON Message → handleMessage → route to handler
```

**Usage:**
```js
useMessages(dataChannelRef, isHost, security, transfer, uiState, addLog);
```

## Components

### ConnectionSection
Displays WebRTC connection status, QR code, share URL, and detailed connection info (ICE state, RTT, packet loss).

### SecuritySection
Shows TOFU verification status and identity information. Most security UI is integrated into StatusSection badges.

### TransferSection
Main file transfer UI:
- File info (sender)
- Incoming file prompt (receiver)
- Progress bar with pause/resume/cancel
- Transfer complete message
- Send button (appears when ready)

### ActivityLogSection
Displays timestamped activity feed with log types (info, success, warning, error).

## Data Flow

```
User Action (UI)
    ↓
Handler in Room/index.jsx
    ↓
Hook Method (useFileTransfer, useSecurity, etc.)
    ↓
Util/Service (ChunkingEngine, fileReceiver, tofuSecurity)
    ↓
Infrastructure (IndexedDB, File System Access API, WebRTC)
```

**Example: Sending a File**
1. User clicks "Send File" button
2. `handleStartTransfer` calls `transfer.startTransfer()`
3. `startTransfer` sends file-metadata via `sendJSON`
4. Receiver accepts → sends "receiver-ready"
5. `sendFileChunks` called → loops through ChunkingEngine
6. Each chunk: metadata (JSON) + binary data sent
7. Progress callbacks update UI
8. Complete → "transfer-complete" sent

## Message Protocol

| Message Type | Direction | Purpose |
|--------------|-----------|---------|
| `handshake` | Both | Exchange peer UUIDs |
| `tofu-challenge` | One | Send cryptographic challenge |
| `tofu-response` | Other | Respond to challenge |
| `tofu-verified` | One | Confirm verification |
| `file-metadata` | Sender | Announce file details |
| `chunk-metadata` | Sender | Announce chunk details (index, checksum, size) |
| `ArrayBuffer` | Sender | Binary chunk data |
| `receiver-ready` | Receiver | Ready to receive chunks |
| `transfer-complete` | Sender | All chunks sent |
| `request-chunks` | Receiver | Request retransmission |
| `transfer-paused` | Both | Pause transfer |
| `transfer-resumed` | Both | Resume transfer |
| `transfer-cancelled` | Both | Cancel transfer |

## Why This Architecture?

### Before: The Problem
- Single 1,401-line component with everything
- Business logic tightly coupled to UI
- 200+ line message handler switch statement
- Difficult to test without mounting React
- Hard for new developers to understand

### After: The Solution
- **Separation of Concerns:** Each hook has one responsibility
- **Testability:** Hooks can be tested without UI
- **Readability:** Room/index.jsx is just composition (~200 lines)
- **Maintainability:** Change connection logic? Edit useRoomConnection. Change transfer? Edit useFileTransfer.
- **Onboarding:** New developers can read hooks in order: State → Connection → Security → Transfer → Messages

## For New Developers

**Start here:**
1. Read Room/index.jsx to see how everything composes
2. Read useRoomState.js (simplest hook)
3. Read useRoomConnection.js to understand WebRTC setup
4. Read useSecurity.js to understand TOFU verification
5. Read useFileTransfer.js (most complex) to understand transfer flow
6. Read useMessages.js to see message routing

**Common Tasks:**

**Add a new message type:**
1. Add to `constants/messages.constants.js`
2. Add handler in `useMessages.js` switch statement
3. Add method to appropriate hook (security/transfer)

**Change transfer behavior:**
- Edit `useFileTransfer.js`
- Most transfer logic delegates to `ChunkingEngine` or `fileReceiver`

**Add UI element:**
- If simple: Add to existing component in `components/`
- If complex: Create new component and import in `Room/index.jsx`

## Testing Approach

Hooks can be tested with `@testing-library/react-hooks`:

```js
import { renderHook } from '@testing-library/react-hooks';
import { useFileTransfer } from './hooks/useFileTransfer';

test('startTransfer sends file metadata', () => {
  const sendJSON = jest.fn();
  const { result } = renderHook(() => useFileTransfer(/* ... */, sendJSON, /* ... */));
  
  result.current.startTransfer();
  
  expect(sendJSON).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'file-metadata' })
  );
});
```

## Notes

- **Refs vs State:** Security uses refs (`tofuVerifiedRef`) to avoid stale closures in message handlers
- **Queuing:** Chunks received before TOFU verification are queued and processed after
- **Backpressure:** `waitForDrain` prevents data channel buffer overflow
- **Analytics:** Transfer events emitted via socket for server-side tracking
- **Cleanup:** All transfers cleaned up from IndexedDB after completion
