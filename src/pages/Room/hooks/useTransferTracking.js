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
import { cleanupTransferData } from '../../../infrastructure/database/index.js';
import {
  createBitmap,
  markChunk,
  serializeBitmap,
  getCompletedCount,
} from '../../../infrastructure/database/chunkBitmap.js';
import { STORAGE_CHUNK_SIZE } from '../../../constants/transfer.constants.js';
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

// Bitmap flush policy
const BITMAP_FLUSH_CHUNK_THRESHOLD = 100;
const BITMAP_FLUSH_DEBOUNCE_MS = 5000;

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
  const fileBitmapsRef = useRef(null); // Map<fileIndex, Uint8Array> for per-file bitmaps
  const fileManifestRef = useRef(null); // Stored file manifest (for per-file totalChunks)

  /** Flush the current in-memory bitmap to IndexedDB (with mutex) */
  const flushBitmap = useCallback(async () => {
    if (!bitmapDirtyRef.current || !activeTransferIdRef.current) return;
    if (flushingRef.current) return; // already flushing — skip to avoid concurrent writes
    
    flushingRef.current = true;
    const transferId = activeTransferIdRef.current;
    
    try {
      const patch = {};

      // Per-file bitmaps (multi-file transfers)
      if (fileBitmapsRef.current && fileBitmapsRef.current.size > 0) {
        const serialized = {};
        let totalCompleted = 0;
        for (const [fileIndex, bitmap] of fileBitmapsRef.current) {
          serialized[fileIndex] = serializeBitmap(bitmap);
          totalCompleted += getCompletedCount(bitmap);
        }
        patch.fileBitmaps = serialized;
        patch.completedChunks = totalCompleted;
      }

      // Single bitmap (single-file transfers)
      if (bitmapRef.current) {
        patch.chunkBitmap = serializeBitmap(bitmapRef.current);
        if (!patch.completedChunks) {
          patch.completedChunks = getCompletedCount(bitmapRef.current);
        }
      }

      if (Object.keys(patch).length > 0) {
        await updateTransfer(transferId, patch);
        bitmapDirtyRef.current = false;
        chunksSinceFlushRef.current = 0;
        logger.log(`[TransferTracking] Bitmap flushed for ${transferId}`);
      }
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

      // Initialize chunk bitmap(s)
      const chunks = totalChunks || 0;
      bitmapDirtyRef.current = false;
      chunksSinceFlushRef.current = 0;

      // Multi-file: create per-file bitmaps from manifest
      if (fileManifest && Array.isArray(fileManifest) && fileManifest.length > 0) {
        fileBitmapsRef.current = new Map();
        fileManifestRef.current = fileManifest;
        for (const entry of fileManifest) {
          const idx = entry.index ?? fileManifest.indexOf(entry);
          const fileChunks = entry.totalChunks || Math.ceil((entry.fileSize || 0) / STORAGE_CHUNK_SIZE);
          fileBitmapsRef.current.set(idx, createBitmap(fileChunks));
        }
        bitmapRef.current = null; // Don't use single bitmap for multi-file
        bitmapTotalChunksRef.current = chunks;
      } else {
        // Single-file: use single bitmap
        bitmapRef.current = createBitmap(chunks);
        bitmapTotalChunksRef.current = chunks;
        fileBitmapsRef.current = null;
        fileManifestRef.current = null;
      }

      // Check if File System Access API is available
      const usedFSAPI = typeof window.showSaveFilePicker === 'function';

      try {
        // Build initial bitmap data for persistence
        const initialBitmapData = {};
        if (fileBitmapsRef.current) {
          // Multi-file: serialize per-file bitmaps
          const serialized = {};
          for (const [idx, bitmap] of fileBitmapsRef.current) {
            serialized[idx] = serializeBitmap(bitmap);
          }
          initialBitmapData.fileBitmaps = serialized;
          initialBitmapData.chunkBitmap = null;
        } else if (bitmapRef.current) {
          // Single-file: serialize single bitmap
          initialBitmapData.chunkBitmap = serializeBitmap(bitmapRef.current);
          initialBitmapData.fileBitmaps = null;
        }

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
          ...initialBitmapData,
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
   * Flushes every BITMAP_FLUSH_CHUNK_THRESHOLD chunks or every
   * BITMAP_FLUSH_DEBOUNCE_MS milliseconds, whichever comes first.
   * 
   * @param {string} transferId - Transfer ID (per-file ID for multi-file)
   * @param {number} chunkIndex - Chunk index within the file
   * @param {number} [fileIndex] - File index for multi-file transfers
   */
  const trackChunkProgress = useCallback((transferId, chunkIndex, fileIndex) => {
    // Per-file bitmap (multi-file transfer)
    if (fileIndex !== undefined && fileBitmapsRef.current) {
      const fileBitmap = fileBitmapsRef.current.get(fileIndex);
      if (fileBitmap) {
        markChunk(fileBitmap, chunkIndex);
        bitmapDirtyRef.current = true;
        chunksSinceFlushRef.current++;
      }
    } else if (bitmapRef.current) {
      // Single bitmap (single-file transfer)
      markChunk(bitmapRef.current, chunkIndex);
      bitmapDirtyRef.current = true;
      chunksSinceFlushRef.current++;
    } else {
      return; // No bitmap initialized
    }

    // Flush by chunk threshold (throughput-driven)
    if (chunksSinceFlushRef.current >= BITMAP_FLUSH_CHUNK_THRESHOLD) {
      if (bitmapFlushTimerRef.current) {
        clearTimeout(bitmapFlushTimerRef.current);
        bitmapFlushTimerRef.current = null;
      }
      flushBitmap();
      return;
    }

    // Flush by debounce window (time-driven)
    if (!bitmapFlushTimerRef.current) {
      bitmapFlushTimerRef.current = setTimeout(() => {
        bitmapFlushTimerRef.current = null;
        flushBitmap();
      }, BITMAP_FLUSH_DEBOUNCE_MS);
    }
  }, [flushBitmap]);

  /**
   * Track transfer completion — marks as completed and cleans up ALL records
   * (chunks, file metadata, and transfer record)
   */
  const trackTransferComplete = useCallback(async (transferId) => {
    activeTransferIdRef.current = null;
    bitmapRef.current = null;
    bitmapDirtyRef.current = false;
    fileBitmapsRef.current = null;
    fileManifestRef.current = null;
    if (bitmapFlushTimerRef.current) {
      clearTimeout(bitmapFlushTimerRef.current);
      bitmapFlushTimerRef.current = null;
    }

    try {
      // Full cleanup: chunks + file metadata + transfer record
      await cleanupTransferData(transferId);
      logger.log(`[TransferTracking] Transfer completed & cleaned: ${transferId}`);
    } catch (err) {
      logger.error('[TransferTracking] Failed to clean completed transfer:', err);
    }
  }, []);

  /**
   * Track transfer cancellation — cleans up ALL records
   */
  const trackTransferCancel = useCallback(async (transferId) => {
    activeTransferIdRef.current = null;
    bitmapRef.current = null;
    bitmapDirtyRef.current = false;
    fileBitmapsRef.current = null;
    fileManifestRef.current = null;
    if (bitmapFlushTimerRef.current) {
      clearTimeout(bitmapFlushTimerRef.current);
      bitmapFlushTimerRef.current = null;
    }

    try {
      await cleanupTransferData(transferId);
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
   * Discard a recoverable transfer — cleans up ALL its records
   */
  const discardRecoverableTransfer = useCallback(async (transferId) => {
    try {
      await cleanupTransferData(transferId);
      logger.log(`[TransferTracking] Discarded recoverable: ${transferId}`);
    } catch (err) {
      logger.error('[TransferTracking] Failed to discard:', err);
    }
  }, []);

  return {
    activeTrackingId: activeTransferIdRef,
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
