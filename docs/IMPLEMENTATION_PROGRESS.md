# Implementation Progress Log

**Started:** March 2, 2026  
**Scope:** Ongoing fixes based on `docs/CODEBASE_ANALYSIS.md`

---

## Completed So Far

### 1) Resume/session wiring fix
- Updated `useMessages` signature to accept room context and sender UUID context.
- Passed `roomId` and local UUID from `Room` into `useMessages`.
- Added `requesterUuid` field to `RESUME_TRANSFER` messages.
- Updated resume acceptance path to verify peer identity using room session data before accepting resume.

**Files changed**
- `src/pages/Room/hooks/useMessages.js`
- `src/pages/Room/index.jsx`

---

### 2) Resume reliability improvements
- Increased resume negotiation timeout from **5s** to **15s**.
- Improved timeout log text for clearer UX.

**Files changed**
- `src/pages/Room/hooks/useResumeTransfer.js`

---

### 3) Resume UX improvements
- Added in-room visual banner during active resume negotiation (`resumeState === 'proposing'`).
- Improved receiver-side prompt to explain file re-selection is required by browser security.

**Files changed**
- `src/pages/Room/index.jsx`

---

### 4) Lint/diagnostic cleanup found during implementation
- Replaced deprecated Tailwind utility: `lg:flex-shrink-0` → `lg:shrink-0`.
- Removed duplicate shrink utility class combinations in `FileDropZone`.

**Files changed**
- `src/pages/Home.jsx`
- `src/components/FileDropZone.jsx`

---

## Validation Completed
- Checked diagnostics for all modified files after changes.
- No errors remained in:
  - `src/pages/Room/hooks/useMessages.js`
  - `src/pages/Room/hooks/useResumeTransfer.js`
  - `src/pages/Room/index.jsx`
  - `src/pages/Home.jsx`
  - `src/components/FileDropZone.jsx`

---

## Next Fixes (In Progress)
1. Enforce file-hash verification during resume acceptance/rejection.
2. Harden WebRTC perfect negotiation retry behavior after polite rollback.
3. Re-run diagnostics and append outcomes here.

---

## Update: New Fixes Implemented

### 5) Resume file-hash verification enforcement
- Added sender-side file fingerprint computation in `useFileTransfer` (`SHA-256` on first 1MB + size + lastModified metadata).
- Exposed `fileHash`, `currentFile`, and `ensureFileHash()` from `useFileTransfer` to resume protocol handlers.
- Updated resume validation in `useMessages` to:
  - reject resume when requester hash is missing,
  - compute/ensure local sender hash,
  - reject on hash mismatch,
  - reject when hash verification cannot be completed.

**Files changed**
- `src/pages/Room/hooks/useFileTransfer.js`
- `src/pages/Room/hooks/useMessages.js`

---

### 6) Perfect negotiation recovery hardening
- Added negotiation recovery retry mechanism in `p2pManager` with exponential backoff.
- Added retry state tracking (`recoveryOfferAttempts`, timer cleanup, max attempts).
- Triggered recovery scheduling when glare causes impolite-offer ignore and when `handleOffer` errors.
- Reset/cleanup recovery timers on successful connection and on peer close.

**Files changed**
- `src/utils/p2pManager.js`

---

## Validation (Latest)
- Checked diagnostics after the new changes.
- No errors in:
  - `src/pages/Room/hooks/useFileTransfer.js`
  - `src/pages/Room/hooks/useMessages.js`
  - `src/utils/p2pManager.js`

---

## Update: Latest Security & Performance Fixes

### 7) Chunk authentication (HMAC auth tags)
- Added chunk authentication key derivation from shared room secret.
- Added per-chunk auth tag generation for outbound chunk metadata (including retransmit paths).
- Enforced auth tag verification on receive path before chunk is accepted for assembly.
- Rejects unauthenticated/tampered chunks early to reduce corruption risk.

**Files changed**
- `src/pages/Room/hooks/useFileTransfer.js`

---

### 8) Bitmap flush write-throttling optimization
- Reduced IndexedDB bitmap write pressure by tuning flush policy from aggressive short-window flushing to configurable threshold/debounce values.
- Added explicit constants:
  - `BITMAP_FLUSH_CHUNK_THRESHOLD = 100`
  - `BITMAP_FLUSH_DEBOUNCE_MS = 5000`
- Ensured scheduled timer is cleared when threshold-based immediate flush occurs to avoid duplicate flush cycles.

**Files changed**
- `src/pages/Room/hooks/useTransferTracking.js`

---

### 9) Resume protocol event bus refactor (eliminated circular dependency)
- Removed circular dependency between `useMessages` ↔ `useResumeTransfer`.
- Created lightweight event bus (`resumeEventBus`) with publish/subscribe pattern.
- `useResumeTransfer` now emits `resumeRequest` events instead of calling callback functions.
- `useMessages` subscribes to `resumeRequest` and emits `resumeAccepted`/`resumeRejected` events.
- Removed fragile callback ref pattern from Room component.
- Cleaner initialization order with no ref mutation dependencies.

**Files changed**
- `src/pages/Room/hooks/resumeEventBus.js` (created)
- `src/pages/Room/hooks/useResumeTransfer.js`
- `src/pages/Room/hooks/useMessages.js`
- `src/pages/Room/index.jsx`

---

### 10) Session token binding for resume replay protection
- Added cryptographic session token generation in `useSecurity` (16 random bytes).
- Session tokens are generated fresh when data channel opens (in `markVerified`).
- Tokens are exchanged during identity handshake between peers.
- Resume requests now include peer's session token for validation.
- Resume handler validates token before processing request (rejects with "replay protection" message on mismatch).
- Prevents replay of old resume messages from previous connections.

**Files changed**
- `src/pages/Room/hooks/useSecurity.js`
- `src/pages/Room/hooks/useMessages.js`
- `src/pages/Room/index.jsx`

---

## Validation (Latest)
- Checked diagnostics after these changes.
- No errors in:
  - `src/pages/Room/hooks/useFileTransfer.js`
  - `src/pages/Room/hooks/useTransferTracking.js`
  - `src/pages/Room/hooks/resumeEventBus.js`
  - `src/pages/Room/hooks/useResumeTransfer.js`
  - `src/pages/Room/hooks/useMessages.js`
  - `src/pages/Room/hooks/useSecurity.js`
  - `src/pages/Room/index.jsx`

---

## Next Recommended Fixes
1. Run targeted transfer/resume test pass and broader regression testing.
2. Consider adding retry/timeout handling for individual chunk delivery (beyond connection-level recovery).
3. Add transfer state persistence checkpointing (periodic bitmap flush during active transfer).


