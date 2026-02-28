# Store Architecture Guide

This directory contains Zustand stores for managing **cross-page UI state** in the application. After the Phase 6 refactoring, stores have been simplified to focus solely on UI-level state coordination.

## Core Principle: Store vs Hook State

### **Stores are for:**
- ✅ State that needs to persist across page navigation (room metadata, transfer history)
- ✅ Global UI settings and preferences  
- ✅ Lightweight metadata tracking for UI display
- ✅ Cross-component coordination that doesn't belong in a hook

### **Hooks are for:**
- ✅ Business logic state (connection status, TOFU verification, transfer progress)
- ✅ Component-specific state and lifecycle
- ✅ Real-time data (speed, ETA, chunked progress)
- ✅ State tied to WebRTC connections, IndexedDB operations

## Store Files

### `roomStore.js`
Global room and security state that persists across page navigation.

**What it manages:**
- Room metadata (`roomId`, `isHost`)
- Security payload for TOFU verification
- Currently selected file (for Room UI)
- Global errors

**What it DOESN'T manage (delegated to hooks):**
- Connection state → `useRoomConnection` hook
- TOFU verification status → `useSecurity` hook
- Transfer progress → `useFileTransfer` hook

**Usage example:**
```javascript
import { useRoomStore } from '@/stores/roomStore';

function MyComponent() {
  const { roomId, isHost, securityPayload } = useRoomStore();
  // ...
}
```

### `transferStore.js`
Transfer history for UI display only. Does NOT track active transfers.

**What it manages:**
- Transfer history (completed/failed/cancelled transfers)
- Lightweight metadata for history display

**What it DOESN'T manage (delegated to hooks/services):**
- Upload/download progress → `useFileTransfer` hook + `ProgressTracker`
- Pause/resume functionality → `ResumableTransferManager`
- Speed/ETA calculations → `ProgressTracker`
- Crash recovery → `resumableTransferManager` in utils/

**Usage example:**
```javascript
import { useTransferStore } from '@/stores/transferStore';

function TransferHistory() {
  const { transferHistory, clearHistory } = useTransferStore();
  
  return (
    <div>
      {transferHistory.map(transfer => (
        <div key={transfer.id}>
          {transfer.status}: {transfer.fileName}
        </div>
      ))}
    </div>
  );
}
```

## Deprecated Methods

Both stores include deprecated methods marked with `@deprecated` JSDoc tags. These are **no-op functions** kept for backward compatibility during the refactoring process.

**Examples:**
- `roomStore.setTofuVerified()` → Use `useSecurity` hook instead
- `transferStore.pauseTransfer()` → Use `useFileTransfer` hook instead
- `transferStore.updateUploadProgress()` → Handled by `ProgressTracker`

These will be removed in a future cleanup phase once all components are verified to use the new architecture.

## Migration Guide: When to Use What

### Scenario 1: I need to track transfer progress
**❌ Don't use:** `transferStore.updateUploadProgress()`  
**✅ Do use:** `useFileTransfer` hook from `Room/hooks/useFileTransfer.js`

```javascript
const { uploadProgress, downloadProgress } = useFileTransfer({ ... });
```

### Scenario 2: I need to check connection status
**❌ Don't use:** `roomStore.connectionState`  
**✅ Do use:** `useRoomConnection` hook from `Room/hooks/useRoomConnection.js`

```javascript
const { isConnected, connectionQuality } = useRoomConnection({ ... });
```

### Scenario 3: I need to verify TOFU security
**❌ Don't use:** `roomStore.tofuVerified`  
**✅ Do use:** `useSecurity` hook from `Room/hooks/useSecurity.js`

```javascript
const { isVerified, verificationStatus } = useSecurity({ ... });
```

### Scenario 4: I need the current room ID
**✅ Do use:** `roomStore.roomId`

```javascript
const { roomId } = useRoomStore();
```

### Scenario 5: I need to display transfer history
**✅ Do use:** `transferStore.transferHistory`

```javascript
const { transferHistory } = useTransferStore();
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                   PRESENTATION LAYER                 │
│  (Components in Room/components/ and pages/)        │
└────────────────┬────────────────────────────────────┘
                 │
                 │ Uses hooks & stores
                 │
┌────────────────┴────────────────────────────────────┐
│                     HOOK LAYER                       │
│   useRoomConnection, useSecurity, useFileTransfer   │
│              useP2PConnection, useUI                │
│                                                      │
│  → Manage business logic state                      │
│  → Handle WebRTC, IndexedDB, real-time data         │
│  → Return state + callbacks to components           │
└────────────────┬────────────────────────────────────┘
                 │
                 │ Uses services & stores
                 │
┌────────────────┴──────────┬──────────────────────────┐
│       SERVICE LAYER        │       STORE LAYER         │
│  ConnectionService         │   roomStore.js            │
│  SecurityService           │   transferStore.js        │
│  TransferOrchestrator      │                           │
│  MessageService            │  → Cross-page UI state    │
│                            │  → Lightweight metadata   │
│  → Orchestrate operations  │  → Global settings        │
│  → No state management     │                           │
└────────────────┬───────────┴───────────────────────────┘
                 │
                 │ Uses infrastructure
                 │
┌─────────────────┴───────────────────────────────────┐
│              INFRASTRUCTURE LAYER                    │
│  transfer/, database/, lib/, constants/             │
│                                                      │
│  → Core utilities & helpers                         │
│  → No state, pure functions                         │
└──────────────────────────────────────────────────────┘
```

## Key Takeaways for New Developers

1. **Stores are lightweight** - They only hold global UI state, not business logic
2. **Hooks own business logic** - Connection, security, transfers all managed in hooks
3. **Services are stateless** - They orchestrate operations, hooks manage state
4. **Check deprecation warnings** - If a store method logs a deprecation warning, use the recommended hook instead
5. **When in doubt** - If it's real-time or WebRTC-related, it belongs in a hook, not a store

## Related Documentation

- [Room Architecture](../pages/Room/README.md) - Details on hooks and components
- [ARCHITECTURE.md](../../ARCHITECTURE.md) - Overall project structure
- [Service Layer](../services/README.md) - Service orchestration patterns
