/**
 * Example: Custom Transfer Handler with Progress Milestones
 * 
 * This example shows how to extend TransferOrchestrator functionality
 * by adding milestone callbacks and custom transfer handling.
 */

// ============ STEP 1: Extend ProgressTracker with Milestones ============
// File: src/transfer/shared/ProgressTracker.js

export class ProgressTrackerWithMilestones extends ProgressTracker {
  constructor(totalBytes) {
    super(totalBytes);

    // Milestone tracking
    this.milestones = [];
    this.reachedMilestones = new Set();
  }

  /**
   * Register a milestone callback
   * Callback fires once when percentage is reached
   * 
   * @param {number} percentage - Milestone percentage (0-100)
   * @param {Function} callback - Callback function
   * @example
   * tracker.addMilestone(50, () => {
   *   console.log('Transfer halfway complete!');
   * });
   */
  addMilestone(percentage, callback) {
    if (percentage < 0 || percentage > 100) {
      throw new Error('Milestone percentage must be between 0 and 100');
    }

    this.milestones.push({
      percentage,
      callback,
      id: `milestone-${percentage}`,
    });
  }

  /**
   * Override updateProgress to check milestones
   */
  updateProgress(bytesTransferred) {
    super.updateProgress(bytesTransferred);

    const currentPercentage = this.getProgress().percentage;

    // Check each milestone
    this.milestones.forEach((milestone) => {
      if (
        currentPercentage >= milestone.percentage &&
        !this.reachedMilestones.has(milestone.id)
      ) {
        this.reachedMilestones.add(milestone.id);

        // Call milestone callback
        milestone.callback({
          percentage: milestone.percentage,
          currentBytes: this.currentBytes,
          totalBytes: this.totalBytes,
          progress: this.getProgress(),
        });
      }
    });
  }

  /**
   * Reset milestones (useful for resume)
   */
  resetMilestones() {
    this.reachedMilestones.clear();
  }
}

// ============ STEP 2: Create Custom Transfer Handler ============
// File: src/services/transfer/CustomTransferHandler.js

import { logger } from '@/utils/logger';
import { ProgressTrackerWithMilestones } from '@/transfer/shared/ProgressTracker';

/**
 * Custom transfer handler with milestone notifications
 * Extends the base transfer functionality with custom callbacks
 */
export class CustomTransferHandler {
  constructor(transferOrchestrator) {
    this.orchestrator = transferOrchestrator;
    this.activeTransfers = new Map();
  }

  /**
   * Start a transfer with custom milestone handling
   * 
   * @param {File} file - File to transfer
   * @param {RTCDataChannel} dataChannel - WebRTC data channel
   * @param {Object} config - Configuration options
   * @param {Array<number>} config.milestones - Milestone percentages [25, 50, 75]
   * @param {Function} config.onMilestone - Callback when milestone reached
   * @param {Function} config.onProgress - Progress callback
   * @param {Function} config.onComplete - Completion callback
   * @param {Function} config.onError - Error callback
   * 
   * @example
   * customHandler.startTransferWithMilestones(file, dataChannel, {
   *   milestones: [25, 50, 75, 100],
   *   onMilestone: ({ percentage }) => {
   *     showNotification(`Transfer ${percentage}% complete`);
   *   },
   *   onProgress: ({ percentage, speed, eta }) => {
   *     updateUI(percentage, speed, eta);
   *   },
   * });
   */
  async startTransferWithMilestones(file, dataChannel, config = {}) {
    const {
      milestones = [25, 50, 75, 100],
      onMilestone = () => {},
      onProgress = () => {},
      onComplete = () => {},
      onError = () => {},
    } = config;

    const transferId = crypto.randomUUID();

    try {
      // Create enhanced progress tracker
      const progressTracker = new ProgressTrackerWithMilestones(file.size);

      // Register milestones
      milestones.forEach((percentage) => {
        progressTracker.addMilestone(percentage, (milestoneData) => {
          logger.log(`[CustomHandler] Milestone ${percentage}% reached`);

          onMilestone({
            transferId,
            ...milestoneData,
          });

          // Could also trigger notifications, analytics, etc.
          this.handleMilestoneReached(transferId, milestoneData);
        });
      });

      // Register progress callback
      progressTracker.onProgress((progressData) => {
        onProgress({
          transferId,
          ...progressData,
        });
      });

      // Store transfer info
      this.activeTransfers.set(transferId, {
        file,
        progressTracker,
        startTime: Date.now(),
        milestones: new Map(), // Track when each milestone was hit
      });

      // Start the actual transfer using orchestrator
      await this.orchestrator.startSending(file, dataChannel, {
        transferId,
        progressTracker, // Pass our custom tracker
      });

      // Transfer complete
      const endTime = Date.now();
      const transferInfo = this.activeTransfers.get(transferId);
      const duration = endTime - transferInfo.startTime;

      logger.log(
        `[CustomHandler] Transfer complete in ${(duration / 1000).toFixed(2)}s`
      );

      onComplete({
        transferId,
        fileName: file.name,
        fileSize: file.size,
        duration,
        milestones: transferInfo.milestones,
      });

      // Cleanup
      this.activeTransfers.delete(transferId);
    } catch (error) {
      logger.error('[CustomHandler] Transfer failed', error);

      onError({
        transferId,
        error,
        fileName: file.name,
      });

      this.activeTransfers.delete(transferId);
      throw error;
    }
  }

  /**
   * Handle when a milestone is reached
   * @private
   */
  handleMilestoneReached(transferId, milestoneData) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;

    // Record milestone timestamp
    transfer.milestones.set(milestoneData.percentage, {
      timestamp: Date.now(),
      bytesTransferred: milestoneData.currentBytes,
    });

    // Could also:
    // - Send analytics event
    // - Trigger browser notification
    // - Update server stats (if applicable)
    // - Auto-save checkpoint for resume
  }

  /**
   * Get statistics for a transfer
   * @param {string} transferId - Transfer ID
   * @returns {Object|null} Transfer statistics
   */
  getTransferStats(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return null;

    const elapsed = (Date.now() - transfer.startTime) / 1000; // seconds
    const progress = transfer.progressTracker.getProgress();

    return {
      fileName: transfer.file.name,
      fileSize: transfer.file.size,
      elapsedSeconds: elapsed,
      progress,
      milestones: Array.from(transfer.milestones.entries()).map(
        ([percentage, data]) => ({
          percentage,
          timestamp: data.timestamp,
          bytesTransferred: data.bytesTransferred,
        })
      ),
    };
  }

  /**
   * Pause a transfer
   * @param {string} transferId - Transfer ID
   */
  async pauseTransfer(transferId) {
    await this.orchestrator.pauseTransfer(transferId);
    logger.log(`[CustomHandler] Transfer paused: ${transferId}`);
  }

  /**
   * Resume a transfer
   * @param {string} transferId - Transfer ID
   */
  async resumeTransfer(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      // Reset milestones if resuming
      transfer.progressTracker.resetMilestones();
    }

    await this.orchestrator.resumeTransfer(transferId);
    logger.log(`[CustomHandler] Transfer resumed: ${transferId}`);
  }

  /**
   * Cancel a transfer
   * @param {string} transferId - Transfer ID
   */
  async cancelTransfer(transferId) {
    await this.orchestrator.cancelTransfer(transferId);
    this.activeTransfers.delete(transferId);
    logger.log(`[CustomHandler] Transfer cancelled: ${transferId}`);
  }
}

// ============ STEP 3: Use in Hook ============
// File: src/pages/Room/hooks/useCustomTransfer.js

import { useState, useCallback, useMemo } from 'react';
import { CustomTransferHandler } from '@/services/transfer/CustomTransferHandler';

/**
 * Hook for using custom transfer handler
 * @param {Object} transferOrchestrator - TransferOrchestrator instance
 * @param {RTCDataChannel} dataChannel - WebRTC data channel
 * @returns {Object} Transfer controls and state
 */
export function useCustomTransfer(transferOrchestrator, dataChannel) {
  const [transfers, setTransfers] = useState({});
  const [notifications, setNotifications] = useState([]);

  // Create handler instance (memoized)
  const handler = useMemo(
    () => new CustomTransferHandler(transferOrchestrator),
    [transferOrchestrator]
  );

  /**
   * Start a transfer with milestone notifications
   */
  const startTransfer = useCallback(
    async (file) => {
      const transferId = crypto.randomUUID();

      // Initialize transfer state
      setTransfers((prev) => ({
        ...prev,
        [transferId]: {
          fileName: file.name,
          fileSize: file.size,
          progress: 0,
          speed: 0,
          eta: null,
          status: 'active',
          milestones: [],
        },
      }));

      await handler.startTransferWithMilestones(file, dataChannel, {
        // Milestones at 25%, 50%, 75%, 100%
        milestones: [25, 50, 75, 100],

        // Milestone callback
        onMilestone: ({ transferId, percentage, currentBytes }) => {
          setTransfers((prev) => ({
            ...prev,
            [transferId]: {
              ...prev[transferId],
              milestones: [
                ...prev[transferId].milestones,
                { percentage, bytes: currentBytes, timestamp: Date.now() },
              ],
            },
          }));

          // Show notification
          setNotifications((prev) => [
            ...prev,
            {
              id: Date.now(),
              message: `${file.name}: ${percentage}% complete`,
              timestamp: Date.now(),
            },
          ]);
        },

        // Progress callback
        onProgress: ({ transferId, percentage, speed, eta }) => {
          setTransfers((prev) => ({
            ...prev,
            [transferId]: {
              ...prev[transferId],
              progress: percentage,
              speed,
              eta,
            },
          }));
        },

        // Completion callback
        onComplete: ({ transferId, duration }) => {
          setTransfers((prev) => ({
            ...prev,
            [transferId]: {
              ...prev[transferId],
              status: 'completed',
              duration,
            },
          }));

          setNotifications((prev) => [
            ...prev,
            {
              id: Date.now(),
              message: `✓ ${file.name} transferred successfully!`,
              timestamp: Date.now(),
            },
          ]);
        },

        // Error callback
        onError: ({ transferId, error }) => {
          setTransfers((prev) => ({
            ...prev,
            [transferId]: {
              ...prev[transferId],
              status: 'failed',
              error: error.message,
            },
          }));

          setNotifications((prev) => [
            ...prev,
            {
              id: Date.now(),
              message: `✗ ${file.name} failed: ${error.message}`,
              timestamp: Date.now(),
              type: 'error',
            },
          ]);
        },
      });
    },
    [handler, dataChannel]
  );

  /**
   * Clear old notifications
   */
  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  return {
    startTransfer,
    transfers,
    notifications,
    clearNotifications,
    pauseTransfer: handler.pauseTransfer.bind(handler),
    resumeTransfer: handler.resumeTransfer.bind(handler),
    cancelTransfer: handler.cancelTransfer.bind(handler),
    getStats: handler.getTransferStats.bind(handler),
  };
}

// ============ STEP 4: Use in Component ============
// File: src/pages/Room/components/CustomTransferSection.jsx

import React from 'react';
import { useCustomTransfer } from '../hooks/useCustomTransfer';
import { formatBytes } from '@/lib/formatters';

export function CustomTransferSection({ transferOrchestrator, dataChannel }) {
  const { startTransfer, transfers, notifications, clearNotifications } =
    useCustomTransfer(transferOrchestrator, dataChannel);

  const handleFileSelect = async () => {
    const [fileHandle] = await window.showOpenFilePicker();
    const file = await fileHandle.getFile();

    await startTransfer(file);
  };

  return (
    <div className="custom-transfer-section">
      <h3>Transfers with Milestone Tracking</h3>

      <button onClick={handleFileSelect}>Select File to Send</button>

      {/* Active transfers */}
      <div className="transfers">
        {Object.entries(transfers).map(([id, transfer]) => (
          <div key={id} className="transfer-item">
            <h4>{transfer.fileName}</h4>
            <div className="progress-bar">
              <div style={{ width: `${transfer.progress}%` }} />
            </div>
            <p>
              {transfer.progress.toFixed(2)}% - {formatBytes(transfer.speed)}/s
              {transfer.eta && ` - ETA: ${transfer.eta.toFixed(0)}s`}
            </p>

            {/* Milestone indicators */}
            {transfer.milestones.length > 0 && (
              <div className="milestones">
                {transfer.milestones.map((milestone, i) => (
                  <span key={i} className="milestone-badge">
                    {milestone.percentage}% ✓
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Notifications */}
      {notifications.length > 0 && (
        <div className="notifications">
          {notifications.map((notif) => (
            <div
              key={notif.id}
              className={`notification ${notif.type || 'info'}`}
            >
              {notif.message}
            </div>
          ))}
          <button onClick={clearNotifications}>Clear</button>
        </div>
      )}
    </div>
  );
}

// ============ USAGE SUMMARY ============
/*
This example demonstrates:

1. ✅ Extending base classes (ProgressTracker → ProgressTrackerWithMilestones)
2. ✅ Creating wrapper services (CustomTransferHandler)
3. ✅ Using dependency injection (passing orchestrator to handler)
4. ✅ Event-driven architecture (callbacks for milestones, progress, etc.)
5. ✅ Proper separation of concerns (handler doesn't know about UI)
6. ✅ Custom hooks for React integration
7. ✅ State management for multiple concurrent transfers

Benefits:
- Non-intrusive: Doesn't modify core TransferOrchestrator
- Reusable: CustomTransferHandler can be used anywhere
- Testable: Pure functions, clear dependencies
- Flexible: Easy to add more features (analytics, retry logic, etc.)

Extensions you could add:
- Automatic retry on failure with exponential backoff
- Transfer queue management (limit concurrent transfers)
- Bandwidth throttling based on network conditions
- Analytics and performance metrics collection
- Custom checkpoint saving for crash recovery
*/
