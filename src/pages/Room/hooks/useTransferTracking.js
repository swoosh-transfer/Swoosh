/**
 * useTransferTracking Hook
 * 
 * Persists transfer progress to IndexedDB.
 * This is the bridge between the UI transfer state and the infrastructure/database layer.
 * 
 * Responsibilities:
 * - Track active transfer progress in IndexedDB (metadata only, no binary)
 * - Auto-save transfer state on disconnection
 * - Clean up completed/cancelled transfer records
 * 
 * Recovery detection is handled on the Home page (rooms are disposable).
 * Uses the infrastructure/database layer (NOT the old utils/indexedDB.js).
 */
import { useEffect, useRef, useCallback } from 'react';
import {
  saveTransfer,
  updateTransfer,
  deleteTransfer,
} from '../../../infrastructure/database/transfers.repository.js';
import {
  deleteChunksByTransfer,
} from '../../../infrastructure/database/chunks.repository.js';
import {
  createBitmap,
  markChunk,
  serializeBitmap,
  getCompletedCount,
} from '../../../infrastructure/database/chunkBitmap.js';
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
}) {
  const activeTransferIdRef = useRef(null);
  const lastSavedProgressRef = useRef(0);
  const bitmapRef = useRef(null);
  const bitmapTotalChunksRef = useRef(0);
  const bitmapDirtyRef = useRef(false);
  const bitmapFlushTimerRef = useRef(null);
  const chunksSinceFlushRef = useRef(0);
  const flushingRef = useRef(false); // mutex to prevent concurrent flushes

  /** Flush the current in-memory bitmap to IndexedDB (with mutex) */
  const flushBitmap = useCallback(async () => {
    if (!bitmapDirtyRef.current || !activeTransferIdRef.current || !bitmapRef.current) return;
    if (flushingRef.current) return; // already flushing — skip to avoid concurrent writes
    
    flushingRef.current = true;
    const transferId = activeTransferIdRef.current;
    const bitmap = bitmapRef.current;
    
    try {
      await updateTransfer(transferId, {
        chunkBitmap: serializeBitmap(bitmap),
        completedChunks: getCompletedCount(bitmap),
      });
      bitmapDirtyRef.current = false;
      chunksSinceFlushRef.current = 0;
      logger.log(`[TransferTracking] Bitmap flushed for ${transferId}`);
    } catch (err) {
      logger.warn('[TransferTracking] Failed to flush bitmap:', err.message);
    } finally {
      flushingRef.current = false;
    }
  }, []);

  // NOTE: Recovery detection moved to Home page.
  // Room is disposable — incomplete transfers surface on Home screen.

  // ── Flush bitmap on visibility change / beforeunload ──────────────────────

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushBitmap();
      }
    };

    const handleBeforeUnload = (event) => {
      // Fire-and-forget — browser may allow async IDB writes a brief window
      flushBitmap();
      // If there's a dirty bitmap still in memory, hint the browser to delay unload
      if (bitmapDirtyRef.current && activeTransferIdRef.current) {
        event.preventDefault();
        event.returnValue = ''; // Chrome requires returnValue
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushBitmap]);

  // ── Auto-mark interrupted on peer disconnect ──────────────────────────────

  useEffect(() => {
    if (!peerDisconnected || !activeTransferIdRef.current) return;

    const transferId = activeTransferIdRef.current;
    logger.log(`[TransferTracking] Peer disconnected, marking ${transferId} as interrupted`);

    // Flush bitmap immediately on disconnect then mark interrupted
    flushBitmap().then(() => {
      updateTransfer(transferId, {
        status: TRACKED_STATUS.INTERRUPTED,
        interruptedAt: Date.now(),
      });
    }).catch((err) => {
      logger.error('[TransferTracking] Failed to mark interrupted:', err);
    });
  }, [peerDisconnected, flushBitmap]);

  // ── Tracking methods ──────────────────────────────────────────────────────

  /**
   * Start tracking a new transfer
   */
  const trackTransferStart = useCallback(
    async ({ transferId, fileName, fileSize, totalChunks, direction, fileHash, fileLastModified, fileManifest }) => {
      activeTransferIdRef.current = transferId;
      lastSavedProgressRef.current = 0;

      // Initialize chunk bitmap
      const chunks = totalChunks || 0;
      bitmapRef.current = createBitmap(chunks);
      bitmapTotalChunksRef.current = chunks;
      bitmapDirtyRef.current = false;
      chunksSinceFlushRef.current = 0;

      // Check if File System Access API is available
      const usedFSAPI = typeof window.showSaveFilePicker === 'function';

      try {
        await saveTransfer({
          transferId,
          roomId,
          fileName,
          fileSize,
          totalChunks: chunks,
          direction, // 'sending' or 'receiving'
          status: TRACKED_STATUS.ACTIVE,
          lastChunkIndex: 0,
          usedFSAPI,
          chunkBitmap: serializeBitmap(bitmapRef.current),
          completedChunks: 0,
          fileHash: fileHash || null,
          fileLastModified: fileLastModified || null,
          originalFileName: fileName,
          originalFileSize: fileSize,
          fileManifest: fileManifest || null,
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
   * Updates in-memory bitmap and queues throttled flush to IndexedDB.
   * Flushes every 25 chunks or every 2 seconds, whichever comes first.
   */
  const trackChunkProgress = useCallback((transferId, chunkIndex) => {
    if (!bitmapRef.current) return;
    
    markChunk(bitmapRef.current, chunkIndex);
    bitmapDirtyRef.current = true;
    chunksSinceFlushRef.current++;

    // Flush every 25 chunks
    if (chunksSinceFlushRef.current >= 25) {
      flushBitmap();
    } else if (!bitmapFlushTimerRef.current) {
      // Or schedule a flush in 2 seconds
      bitmapFlushTimerRef.current = setTimeout(() => {
        bitmapFlushTimerRef.current = null;
        flushBitmap();
      }, 2000);
    }
  }, [flushBitmap]);

  /**
   * Track transfer completion — marks as completed and cleans up chunk records
   */
  const trackTransferComplete = useCallback(async (transferId) => {
    activeTransferIdRef.current = null;
    bitmapRef.current = null;
    bitmapDirtyRef.current = false;
    if (bitmapFlushTimerRef.current) {
      clearTimeout(bitmapFlushTimerRef.current);
      bitmapFlushTimerRef.current = null;
    }

    try {
      // Fully purge completed transfer — delete chunks AND transfer record
      await deleteChunksByTransfer(transferId);
      await deleteTransfer(transferId);

      logger.log(`[TransferTracking] Transfer completed & cleaned: ${transferId}`);
    } catch (err) {
      logger.error('[TransferTracking] Failed to clean completed transfer:', err);
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
      // Flush bitmap immediately on pause
      await flushBitmap();
      await updateTransfer(transferId, {
        status: TRACKED_STATUS.PAUSED,
        pausedAt: Date.now(),
      });
    } catch (err) {
      logger.error('[TransferTracking] Failed to mark paused:', err);
    }
  }, [flushBitmap]);

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

  return {
    trackTransferStart,
    trackChunkProgress,
    trackTransferProgress,
    trackTransferComplete,
    trackTransferCancel,
    trackTransferPause,
    trackTransferResume,
    flushBitmap,
    discardRecoverableTransfer,
  };
}
