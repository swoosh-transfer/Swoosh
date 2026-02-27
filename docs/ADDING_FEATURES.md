# Adding Features Guide

This guide provides step-by-step instructions for common development tasks. Each example follows our architectural principles and coding conventions.

## Table of Contents

- [Adding a New Message Type](#adding-a-new-message-type)
- [Adding Progress Callbacks](#adding-progress-callbacks)
- [Extending Transfer Functionality](#extending-transfer-functionality)
- [Adding a New UI Section](#adding-a-new-ui-section)
- [Adding Database Persistence](#adding-database-persistence)
- [Adding a New Hook](#adding-a-new-hook)
- [Adding WebRTC Connection Events](#adding-webrtc-connection-events)

---

## Adding a New Message Type

**Example:** Add a "typing indicator" message to show when peer is selecting a file.

### Step 1: Define the Message Constant

Add to [constants/messages.constants.js](../src/constants/messages.constants.js):

```javascript
/**
 * Sent when user is browsing/selecting a file
 * Payload: { isSelecting: boolean }
 */
export const MESSAGE_TYPE_FILE_SELECTING = 'file-selecting';
```

### Step 2: Add Message Builder to MessageService

In [services/MessageService.js](../src/services/MessageService.js):

```javascript
/**
 * Create a file selecting indicator message
 * @param {boolean} isSelecting - Whether user is selecting a file
 * @returns {Object} Formatted message
 */
createFileSelectingMessage(isSelecting) {
  return {
    type: MESSAGE_TYPE_FILE_SELECTING,
    payload: { isSelecting },
    timestamp: Date.now(),
  };
}
```

### Step 3: Add Message Handler

In [services/MessageService.js](../src/services/MessageService.js), update the `handleIncomingMessage` switch:

```javascript
handleIncomingMessage(message) {
  switch (message.type) {
    // ... existing cases
    
    case MESSAGE_TYPE_FILE_SELECTING:
      this.handleFileSelecting(message.payload);
      break;
      
    // ... rest of cases
  }
}

/**
 * Handle file selecting indicator
 * @private
 */
handleFileSelecting(payload) {
  const { isSelecting } = payload;
  
  // Emit event for UI to subscribe to
  this.emit('peerFileSelecting', { isSelecting });
  
  logger.log(`[MessageService] Peer is ${isSelecting ? 'selecting' : 'done selecting'} a file`);
}
```

### Step 4: Emit the Message from UI

In [pages/Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js):

```javascript
const handleFilePickerOpen = useCallback(() => {
  // Notify peer that we're selecting a file
  messageService.send(
    messageService.createFileSelectingMessage(true)
  );
}, [messageService]);

const handleFilePickerClose = useCallback(() => {
  // Notify peer we're done selecting
  messageService.send(
    messageService.createFileSelectingMessage(false)
  );
}, [messageService]);
```

### Step 5: Subscribe to Event in Hook

In [pages/Room/hooks/useMessages.js](../src/pages/Room/hooks/useMessages.js):

```javascript
const [peerSelectingFile, setPeerSelectingFile] = useState(false);

useEffect(() => {
  const handlePeerSelecting = ({ isSelecting }) => {
    setPeerSelectingFile(isSelecting);
  };
  
  messageService.on('peerFileSelecting', handlePeerSelecting);
  
  return () => {
    messageService.off('peerFileSelecting', handlePeerSelecting);
  };
}, [messageService]);

return {
  // ... other state
  peerSelectingFile,
};
```

### Step 6: Display in UI

In [pages/Room/components/TransferSection.jsx](../src/pages/Room/components/TransferSection.jsx):

```javascript
export function TransferSection({ peerSelectingFile, ...rest }) {
  return (
    <div>
      {peerSelectingFile && (
        <div className="status-indicator">
          Peer is selecting a file...
        </div>
      )}
      {/* ... rest of UI */}
    </div>
  );
}
```

**✅ Complete!** You've added a new message type following the proper architecture layers.

---

## Adding Progress Callbacks

**Example:** Add a callback when transfer reaches 50% completion.

### Step 1: Add to ProgressTracker

In [transfer/shared/ProgressTracker.js](../src/transfer/shared/ProgressTracker.js):

```javascript
export class ProgressTracker {
  constructor(totalBytes) {
    this.totalBytes = totalBytes;
    this.currentBytes = 0;
    this.callbacks = {
      onProgress: [],
      onMilestone: [], // NEW: Milestone callbacks
    };
    this.milestones = new Set(); // Track which milestones hit
  }
  
  /**
   * Register a milestone callback (triggered once)
   * @param {number} percentage - Milestone percentage (0-100)
   * @param {Function} callback - Callback when milestone reached
   */
  onMilestone(percentage, callback) {
    this.callbacks.onMilestone.push({ percentage, callback });
  }
  
  updateProgress(bytesTransferred) {
    this.currentBytes += bytesTransferred;
    const percentage = (this.currentBytes / this.totalBytes) * 100;
    
    // Check milestones
    this.callbacks.onMilestone.forEach(({ percentage: targetPercentage, callback }) => {
      const milestoneKey = `milestone-${targetPercentage}`;
      
      if (percentage >= targetPercentage && !this.milestones.has(milestoneKey)) {
        this.milestones.add(milestoneKey);
        callback({ percentage: targetPercentage, currentBytes: this.currentBytes });
      }
    });
    
    // Regular progress callbacks
    this.callbacks.onProgress.forEach(cb => cb(this.getProgress()));
  }
}
```

### Step 2: Use in TransferOrchestrator

In [services/TransferOrchestrator.js](../src/services/TransferOrchestrator.js):

```javascript
async startSending(file, dataChannel) {
  // ... setup code
  
  const progressTracker = new ProgressTracker(file.size);
  
  // Register milestone callbacks
  progressTracker.onMilestone(25, ({ percentage }) => {
    logger.log(`Transfer 25% complete`);
    this.emit('milestone', { percentage, transferId });
  });
  
  progressTracker.onMilestone(50, ({ percentage }) => {
    logger.log(`Transfer halfway complete!`);
    this.emit('milestone', { percentage, transferId });
  });
  
  progressTracker.onMilestone(75, ({ percentage }) => {
    logger.log(`Transfer 75% complete`);
    this.emit('milestone', { percentage, transferId });
  });
  
  // ... rest of sending logic
}
```

### Step 3: Subscribe in Hook

In [pages/Room/hooks/useFileTransfer.js](../src/pages/Room/hooks/useFileTransfer.js):

```javascript
useEffect(() => {
  const handleMilestone = ({ percentage, transferId }) => {
    // Show notification
    showNotification(`Transfer ${percentage}% complete!`);
    
    // Or update UI state
    setMilestones(prev => [...prev, { percentage, timestamp: Date.now() }]);
  };
  
  transferOrchestrator.on('milestone', handleMilestone);
  
  return () => {
    transferOrchestrator.off('milestone', handleMilestone);
  };
}, [transferOrchestrator]);
```

**✅ Done!** Milestone callbacks are now available throughout the app.

---

## Extending Transfer Functionality

**Example:** Add automatic file compression before sending.

### Step 1: Create Compression Module

Create [transfer/preprocessing/FileCompressor.js](../src/transfer/preprocessing/FileCompressor.js):

```javascript
import { logger } from '@/utils/logger';

/**
 * Compresses files before transfer
 */
export class FileCompressor {
  /**
   * Compress a file using CompressionStream API
   * @param {File} file - File to compress
   * @returns {Promise<Blob>} Compressed file blob
   */
  async compress(file) {
    logger.log(`[FileCompressor] Compressing ${file.name}...`);
    
    const stream = file.stream();
    const compressionStream = new CompressionStream('gzip');
    const compressedStream = stream.pipeThrough(compressionStream);
    
    const chunks = [];
    const reader = compressedStream.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    const compressedBlob = new Blob(chunks);
    
    const compressionRatio = ((1 - compressedBlob.size / file.size) * 100).toFixed(2);
    logger.log(`[FileCompressor] Compressed ${file.name}: ${compressionRatio}% reduction`);
    
    return compressedBlob;
  }
  
  /**
   * Decompress a blob
   * @param {Blob} blob - Compressed blob
   * @returns {Promise<Blob>} Decompressed blob
   */
  async decompress(blob) {
    const stream = blob.stream();
    const decompressionStream = new DecompressionStream('gzip');
    const decompressedStream = stream.pipeThrough(decompressionStream);
    
    const chunks = [];
    const reader = decompressedStream.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    return new Blob(chunks);
  }
}
```

### Step 2: Integrate into TransferOrchestrator

In [services/TransferOrchestrator.js](../src/services/TransferOrchestrator.js):

```javascript
import { FileCompressor } from '@/transfer/preprocessing/FileCompressor';

export class TransferOrchestrator {
  constructor(dependencies) {
    // ... existing setup
    this.fileCompressor = new FileCompressor();
    this.compressionEnabled = true; // Add setting
  }
  
  async startSending(file, dataChannel) {
    // Optionally compress before sending
    let fileToSend = file;
    let isCompressed = false;
    
    if (this.compressionEnabled) {
      try {
        fileToSend = await this.fileCompressor.compress(file);
        isCompressed = true;
        
        logger.log(`[TransferOrchestrator] File compressed: ${file.size} → ${fileToSend.size} bytes`);
      } catch (error) {
        logger.warn('[TransferOrchestrator] Compression failed, sending original', error);
      }
    }
    
    // Send metadata with compression flag
    const metadata = {
      fileName: file.name,
      fileSize: fileToSend.size,
      originalSize: file.size,
      fileType: file.type,
      isCompressed,
      transferId,
    };
    
    this.messageService.send(
      this.messageService.createFileMetadataMessage(metadata)
    );
    
    // Continue with normal sending...
    this.chunkingEngine.sendFile(fileToSend, dataChannel);
  }
  
  async startReceiving(metadata, dataChannel) {
    const { isCompressed, fileName, fileSize, originalSize } = metadata;
    
    // ... normal receiving logic
    
    // After file is fully received and assembled
    const onComplete = async (assembledBlob) => {
      let finalBlob = assembledBlob;
      
      // Decompress if needed
      if (isCompressed) {
        logger.log('[TransferOrchestrator] Decompressing received file...');
        finalBlob = await this.fileCompressor.decompress(assembledBlob);
      }
      
      // Write to file system
      await this.fileWriter.writeFile(fileName, finalBlob);
      
      this.emit('transferComplete', { transferId: metadata.transferId });
    };
    
    // ... rest of receiving logic
  }
}
```

### Step 3: Add UI Toggle

In [pages/Room/components/TransferSection.jsx](../src/pages/Room/components/TransferSection.jsx):

```javascript
export function TransferSection({ transferOrchestrator }) {
  const [compressionEnabled, setCompressionEnabled] = useState(true);
  
  const handleCompressionToggle = (enabled) => {
    setCompressionEnabled(enabled);
    transferOrchestrator.setCompressionEnabled(enabled);
  };
  
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={compressionEnabled}
          onChange={(e) => handleCompressionToggle(e.target.checked)}
        />
        Enable file compression
      </label>
      {/* ... rest of UI */}
    </div>
  );
}
```

**✅ Complete!** File compression is now integrated into the transfer pipeline.

---

## Adding a New UI Section

**Example:** Add a "Transfer Statistics" section showing total bytes transferred.

### Step 1: Create Component

Create [pages/Room/components/StatisticsSection.jsx](../src/pages/Room/components/StatisticsSection.jsx):

```javascript
import { formatBytes } from '@/lib/formatters';

/**
 * Displays transfer statistics
 */
export function StatisticsSection({ totalBytesSent, totalBytesReceived, transferCount }) {
  return (
    <section className="statistics-section">
      <h3>Session Statistics</h3>
      
      <div className="stats-grid">
        <div className="stat-item">
          <span className="stat-label">Sent:</span>
          <span className="stat-value">{formatBytes(totalBytesSent)}</span>
        </div>
        
        <div className="stat-item">
          <span className="stat-label">Received:</span>
          <span className="stat-value">{formatBytes(totalBytesReceived)}</span>
        </div>
        
        <div className="stat-item">
          <span className="stat-label">Transfers:</span>
          <span className="stat-value">{transferCount}</span>
        </div>
        
        <div className="stat-item">
          <span className="stat-label">Total:</span>
          <span className="stat-value">
            {formatBytes(totalBytesSent + totalBytesReceived)}
          </span>
        </div>
      </div>
    </section>
  );
}
```

### Step 2: Create Hook for Statistics

Create [pages/Room/hooks/useStatistics.js](../src/pages/Room/hooks/useStatistics.js):

```javascript
import { useState, useEffect } from 'react';

/**
 * Track transfer statistics for the current session
 */
export function useStatistics(transferOrchestrator) {
  const [stats, setStats] = useState({
    totalBytesSent: 0,
    totalBytesReceived: 0,
    transferCount: 0,
  });
  
  useEffect(() => {
    const handleTransferComplete = ({ type, bytesTransferred }) => {
      setStats(prev => ({
        totalBytesSent: prev.totalBytesSent + (type === 'upload' ? bytesTransferred : 0),
        totalBytesReceived: prev.totalBytesReceived + (type === 'download' ? bytesTransferred : 0),
        transferCount: prev.transferCount + 1,
      }));
    };
    
    transferOrchestrator.on('transferComplete', handleTransferComplete);
    
    return () => {
      transferOrchestrator.off('transferComplete', handleTransferComplete);
    };
  }, [transferOrchestrator]);
  
  const resetStats = () => {
    setStats({
      totalBytesSent: 0,
      totalBytesReceived: 0,
      transferCount: 0,
    });
  };
  
  return { ...stats, resetStats };
}
```

### Step 3: Integrate into Room Page

In [pages/Room/index.jsx](../src/pages/Room/index.jsx):

```javascript
import { StatisticsSection } from './components/StatisticsSection';
import { useStatistics } from './hooks/useStatistics';

export default function Room() {
  const connection = useRoomConnection();
  const transfer = useFileTransfer(connection);
  const security = useSecurity(connection);
  const messages = useMessages(connection, transfer, security);
  const statistics = useStatistics(transfer.orchestrator); // NEW
  
  return (
    <div className="room-page">
      <ConnectionSection {...connection} />
      <SecuritySection {...security} />
      <TransferSection {...transfer} />
      <StatisticsSection {...statistics} /> {/* NEW */}
      <ActivityLog {...messages} />
    </div>
  );
}
```

**✅ Done!** New UI section added following component/hook separation.

---

## Adding Database Persistence

**Example:** Persist transfer statistics across sessions.

### Step 1: Create Repository

Create [infrastructure/database/statistics.repository.js](../src/infrastructure/database/statistics.repository.js):

```javascript
import { dbClient } from './client';
import { logger } from '@/utils/logger';

const STORE_NAME = 'statistics';

/**
 * Repository for transfer statistics persistence
 */
export const statisticsRepository = {
  /**
   * Save statistics to database
   * @param {Object} stats - Statistics object
   * @returns {Promise<{success: boolean}>}
   */
  async saveStatistics(stats) {
    try {
      const db = await dbClient.getDatabase();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      
      await store.put({ ...stats, id: 'session-stats', updatedAt: Date.now() });
      await tx.complete;
      
      logger.log('[StatisticsRepository] Statistics saved');
      return { success: true };
    } catch (error) {
      logger.error('[StatisticsRepository] Failed to save statistics', error);
      return { success: false, error };
    }
  },
  
  /**
   * Load statistics from database
   * @returns {Promise<Object|null>}
   */
  async loadStatistics() {
    try {
      const db = await dbClient.getDatabase();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      
      const stats = await store.get('session-stats');
      await tx.complete;
      
      return stats || null;
    } catch (error) {
      logger.error('[StatisticsRepository] Failed to load statistics', error);
      return null;
    }
  },
  
  /**
   * Clear all statistics
   * @returns {Promise<{success: boolean}>}
   */
  async clearStatistics() {
    try {
      const db = await dbClient.getDatabase();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      
      await store.clear();
      await tx.complete;
      
      logger.log('[StatisticsRepository] Statistics cleared');
      return { success: true };
    } catch (error) {
      logger.error('[StatisticsRepository] Failed to clear statistics', error);
      return { success: false, error };
    }
  },
};
```

### Step 2: Update Database Schema

In [infrastructure/database/client.js](../src/infrastructure/database/client.js):

```javascript
async initializeDatabase() {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, transaction) {
      // ... existing object stores
      
      // Add statistics store
      if (!db.objectStoreNames.contains('statistics')) {
        db.createObjectStore('statistics', { keyPath: 'id' });
      }
    },
  });
  
  return db;
}
```

### Step 3: Update Hook to Use Persistence

In [pages/Room/hooks/useStatistics.js](../src/pages/Room/hooks/useStatistics.js):

```javascript
import { statisticsRepository } from '@/infrastructure/database/statistics.repository';

export function useStatistics(transferOrchestrator) {
  const [stats, setStats] = useState({
    totalBytesSent: 0,
    totalBytesReceived: 0,
    transferCount: 0,
  });
  
  // Load persisted stats on mount
  useEffect(() => {
    async function loadStats() {
      const saved = await statisticsRepository.loadStatistics();
      if (saved) {
        setStats(saved);
      }
    }
    loadStats();
  }, []);
  
  // Save stats whenever they change
  useEffect(() => {
    if (stats.transferCount > 0) {
      statisticsRepository.saveStatistics(stats);
    }
  }, [stats]);
  
  // ... rest of hook implementation
}
```

**✅ Complete!** Statistics now persist across browser sessions.

---

## Additional Examples

For more examples, see:
- [examples/custom-transfer-handler.js](../examples/custom-transfer-handler.js)
- [examples/adding-a-message-type.js](../examples/adding-a-message-type.js)

## Best Practices Checklist

When adding new features, ensure:

- ✅ Constants are defined in `constants/` with explanatory comments
- ✅ Pure utilities go in `lib/`, stateful utilities in `utils/`
- ✅ Data persistence uses repository pattern in `infrastructure/`
- ✅ Business logic lives in `services/`, not components
- ✅ UI components are presentational, hooks handle logic
- ✅ No circular dependencies (check import hierarchy)
- ✅ Events used for loose coupling between layers
- ✅ JSDoc comments on all public functions
- ✅ Error handling with proper error classes from `lib/errors.js`
- ✅ Logging with categorized log levels

## Need Help?

- **Architecture Questions:** See [ARCHITECTURE.md](../ARCHITECTURE.md)
- **Understanding Flow:** See [TRANSFER_FLOW.md](TRANSFER_FLOW.md)
- **Debugging:** See [DEBUGGING.md](DEBUGGING.md)
- **Getting Started:** See [NEW_DEVELOPER_GUIDE.md](NEW_DEVELOPER_GUIDE.md)
