/**
 * useTransferTracking Hook
 * 
 * Persists transfer progress to IndexedDB and detects recoverable transfers.
 * This is the bridge between the UI transfer state and the infrastructure/database layer.
 * 
 * Responsibilities:
 * - Track active transfer progress in IndexedDB (metadata only, no binary)
 * - Detect and expose recoverable transfers on mount (cross-session resume)
 * - Auto-save transfer state on disconnection
 * - Clean up completed/cancelled transfer records
 * 
 * Uses the infrastructure/database layer (NOT the old utils/indexedDB.js).
 */
import { useEffect, useRef, useCallback } from 'react';
import {
  saveTransfer,
  getTransfer,
  updateTransfer,
  deleteTransfer,
  listTransfers,
  getTransfersByStatus,
} from '../../../infrastructure/database/transfers.repository.js';
import {
  saveChunk,
  getChunksByTransfer,
  deleteChunksByTransfer,
} from '../../../infrastructure/database/chunks.repository.js';
import logger from '../../../utils/logger.js';

/**
 * Transfer tracking statuses (stored in IndexedDB)
 */
const TRACKED_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  INTERRUPTED: 'interrupted',  // Disconnected mid-transfer
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

/**
 * Hook for tracking transfer progress in IndexedDB
 * 
 * @param {Object} params
 * @param {string} params.roomId - Current room ID
 * @param {boolean} params.peerDisconnected - Whether peer has disconnected
 * @param {Function} params.addLog - Logging function
 * @param {Function} params.addRecoverableTransfer - Add to recoverable list in uiState
 * @returns {Object} Transfer tracking methods
 */
export function useTransferTracking({
  roomId,
  peerDisconnected,
  addLog,
  addRecoverableTransfer,
}) {
  const activeTransferIdRef = useRef(null);
  const lastSavedProgressRef = useRef(0);

  // ── Check for recoverable transfers on mount ──────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function checkRecoverable() {
      try {
        const transfers = await listTransfers();
        const recoverable = transfers.filter(
          (t) =>
            t.status === TRACKED_STATUS.ACTIVE ||
            t.status === TRACKED_STATUS.PAUSED ||
            t.status === TRACKED_STATUS.INTERRUPTED
        );

        if (cancelled) return;

        for (const transfer of recoverable) {
          // Only surface transfers that have meaningful progress
          if (transfer.lastChunkIndex > 0) {
            const chunks = await getChunksByTransfer(transfer.transferId);
            const progress = transfer.totalChunks
              ? Math.round((chunks.length / transfer.totalChunks) * 100)
              : 0;

            if (cancelled) return;

            addRecoverableTransfer?.({
              transferId: transfer.transferId,
              fileName: transfer.fileName,
              fileSize: transfer.fileSize,
              direction: transfer.direction,
              progress,
              receivedChunks: chunks.length,
              totalChunks: transfer.totalChunks,
              createdAt: transfer.createdAt,
              roomId: transfer.roomId,
              usedFSAPI: transfer.usedFSAPI ?? false,
            });

            logger.log(
              `[TransferTracking] Found recoverable: ${transfer.fileName} (${progress}%)`
            );
          }
        }
      } catch (err) {
        logger.error('[TransferTracking] Failed to check recoverable transfers:', err);
      }
    }

    checkRecoverable();
    return () => { cancelled = true; };
  }, []); // Only on mount

  // ── Auto-mark interrupted on peer disconnect ──────────────────────────────

  useEffect(() => {
    if (!peerDisconnected || !activeTransferIdRef.current) return;

    const transferId = activeTransferIdRef.current;
    logger.log(`[TransferTracking] Peer disconnected, marking ${transferId} as interrupted`);

    updateTransfer(transferId, {
      status: TRACKED_STATUS.INTERRUPTED,
      interruptedAt: Date.now(),
    }).catch((err) => {
      logger.error('[TransferTracking] Failed to mark interrupted:', err);
    });
  }, [peerDisconnected]);

  // ── Tracking methods ──────────────────────────────────────────────────────

  /**
   * Start tracking a new transfer
   */
  const trackTransferStart = useCallback(
    async ({ transferId, fileName, fileSize, totalChunks, direction }) => {
      activeTransferIdRef.current = transferId;
      lastSavedProgressRef.current = 0;

      // Check if File System Access API is available
      const usedFSAPI = typeof window.showSaveFilePicker === 'function';

      try {
        await saveTransfer({
          transferId,
          roomId,
          fileName,
          fileSize,
          totalChunks: totalChunks || 0,
          direction, // 'sending' or 'receiving'
          status: TRACKED_STATUS.ACTIVE,
          lastChunkIndex: 0,
          usedFSAPI,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        logger.log(`[TransferTracking] Started tracking: ${fileName}`);
      } catch (err) {
        logger.error('[TransferTracking] Failed to save transfer start:', err);
      }
    },
    [roomId]
  );

  /**
   * Track a chunk being sent or received (metadata only — no binary in IDB).
   * Throttled: only writes to IDB every 50 chunks to reduce overhead.
   */
  const trackChunk = useCallback(
    async ({ transferId, chunkIndex, size, checksum }) => {
      try {
        // Save individual chunk metadata
        await saveChunk({
          transferId,
          chunkIndex,
          size,
          checksum: checksum || null,
          status: 'received',
          receivedAt: Date.now(),
        });

        // Throttle transfer record updates (every 50 chunks)
        if (chunkIndex - lastSavedProgressRef.current >= 50 || chunkIndex === 0) {
          lastSavedProgressRef.current = chunkIndex;
          await updateTransfer(transferId, {
            lastChunkIndex: chunkIndex,
            status: TRACKED_STATUS.ACTIVE,
          });
        }
      } catch (err) {
        // Non-fatal: chunk tracking failure shouldn't break transfer
        logger.warn('[TransferTracking] Failed to track chunk:', chunkIndex, err.message);
      }
    },
    []
  );

  /**
   * Track transfer completion — marks as completed and cleans up chunk records
   */
  const trackTransferComplete = useCallback(async (transferId) => {
    activeTransferIdRef.current = null;

    try {
      await updateTransfer(transferId, {
        status: TRACKED_STATUS.COMPLETED,
        completedAt: Date.now(),
      });

      // Clean up chunk metadata (no need to keep once complete)
      await deleteChunksByTransfer(transferId);

      logger.log(`[TransferTracking] Transfer completed: ${transferId}`);
    } catch (err) {
      logger.error('[TransferTracking] Failed to mark complete:', err);
    }
  }, []);

  /**
   * Track transfer cancellation — cleans up all records
   */
  const trackTransferCancel = useCallback(async (transferId) => {
    activeTransferIdRef.current = null;

    try {
      await deleteChunksByTransfer(transferId);
      await deleteTransfer(transferId);
      logger.log(`[TransferTracking] Transfer cancelled and cleaned: ${transferId}`);
    } catch (err) {
      logger.error('[TransferTracking] Failed to clean cancelled transfer:', err);
    }
  }, []);

  /**
   * Track pause — persists current progress
   */
  const trackTransferPause = useCallback(async (transferId) => {
    try {
      await updateTransfer(transferId, {
        status: TRACKED_STATUS.PAUSED,
        pausedAt: Date.now(),
      });
    } catch (err) {
      logger.error('[TransferTracking] Failed to mark paused:', err);
    }
  }, []);

  /**
   * Track resume — restores active status
   */
  const trackTransferResume = useCallback(async (transferId) => {
    try {
      await updateTransfer(transferId, {
        status: TRACKED_STATUS.ACTIVE,
        resumedAt: Date.now(),
      });
    } catch (err) {
      logger.error('[TransferTracking] Failed to mark resumed:', err);
    }
  }, []);

  /**
   * Track transfer progress (lightweight — just updates the transfer record).
   * Called periodically from Room component when transferProgress changes.
   * Throttled to avoid excessive IDB writes.
   */
  const trackTransferProgress = useCallback(
    async ({ transferId, progress, bytesTransferred }) => {
      // Throttle: only write if progress moved by at least 5%
      if (Math.abs(progress - lastSavedProgressRef.current) < 5) return;
      lastSavedProgressRef.current = progress;

      try {
        await updateTransfer(transferId, {
          lastProgress: progress,
          bytesTransferred: bytesTransferred || 0,
          status: TRACKED_STATUS.ACTIVE,
        });
      } catch (err) {
        // Non-fatal
        logger.warn('[TransferTracking] Failed to track progress:', err.message);
      }
    },
    []
  );

  /**
   * Discard a recoverable transfer — cleans up its records
   */
  const discardRecoverableTransfer = useCallback(async (transferId) => {
    try {
      await deleteChunksByTransfer(transferId);
      await deleteTransfer(transferId);
      logger.log(`[TransferTracking] Discarded recoverable: ${transferId}`);
    } catch (err) {
      logger.error('[TransferTracking] Failed to discard:', err);
    }
  }, []);

  /**
   * Get detailed info about a recoverable transfer (for resume)
   */
  const getRecoverableTransferInfo = useCallback(async (transferId) => {
    try {
      const transfer = await getTransfer(transferId);
      if (!transfer) return null;

      const chunks = await getChunksByTransfer(transferId);
      const receivedIndices = chunks.map((c) => c.chunkIndex).sort((a, b) => a - b);

      return {
        ...transfer,
        receivedChunks: receivedIndices,
        receivedCount: receivedIndices.length,
        progress: transfer.totalChunks
          ? Math.round((receivedIndices.length / transfer.totalChunks) * 100)
          : 0,
      };
    } catch (err) {
      logger.error('[TransferTracking] Failed to get recoverable info:', err);
      return null;
    }
  }, []);

  return {
    trackTransferStart,
    trackChunk,
    trackTransferProgress,
    trackTransferComplete,
    trackTransferCancel,
    trackTransferPause,
    trackTransferResume,
    discardRecoverableTransfer,
    getRecoverableTransferInfo,
  };
}
