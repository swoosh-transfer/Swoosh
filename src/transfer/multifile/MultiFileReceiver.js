/**
 * MultiFileReceiver — coordinates receiving multiple files from a multi-file transfer.
 *
 * Handles:
 *   - Parsing MULTI_FILE_MANIFEST to know what to expect
 *   - Routing incoming chunks by fileIndex to the correct per-file writer
 *   - Creating nested directory structure via File System Access API
 *   - Tracking per-file and aggregate completion
 *   - Fallback: individual blob downloads when directory picker unavailable
 */
import { MESSAGE_TYPE } from '../../constants/messages.constants.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { WriteQueue } from '../../infrastructure/storage/WriteQueue.js';
import logger from '../../utils/logger.js';

export class MultiFileReceiver {
  /**
   * @param {Object} options
   * @param {Function} [options.trackChunkProgress] — track chunk completion in bitmap
   */
  constructor(options = {}) {
    this._trackChunkProgress = options.trackChunkProgress || (() => {});
    this._transferIdsByFileIndex = new Map(); // fileIndex → transferId for tracking

    /** @type {Object|null} parsed manifest */
    this._manifest = null;

    /** @type {FileSystemDirectoryHandle|null} chosen save directory */
    this._dirHandle = null;

    /** Per-file state: Map<fileIndex, { writable, handle, receivedChunks, totalChunks, bytesReceived, bytesWritten, completed }> */
    this._files = new Map();

    /** Map of fileIndex -> Promise that resolves when WriteQueue for that file is ready */
    this._writeQueueReady = new Map();

    /** Pending binary data keyed by fileIndex (when metadata arrives before binary) */
    this._pendingBinary = new Map();

    /** Metadata waiting for its binary partner: fileIndex → metadata */
    this._pendingMeta = new Map();

    /** Sender's chunk size (received in manifest, defaults to STORAGE_CHUNK_SIZE for back-compat) */
    this._senderChunkSize = STORAGE_CHUNK_SIZE;

    /** Callbacks */
    this._onManifest = null;           // (manifest) => void
    this._onProgress = null;           // (progressObj) => void
    this._onFileComplete = null;       // (fileIndex, name) => void
    this._onAllComplete = null;        // () => void
    this._onError = null;              // (error) => void
    this._onNeedDirectory = null;      // () => Promise — prompt user for directory

    this._totalBytesReceived = 0;
    /** Track total bytes actually written to disk (vs received in buffer) */
    this._totalBytesWritten = 0;
    this._startTime = 0;
    
    // Periodic sync to update bytesWritten from WriteQueues
    this._progressSyncInterval = null;
  }

  // ─── Configuration ────────────────────────────────────────────────

  set onManifest(fn) { this._onManifest = fn; }
  set onProgress(fn) { this._onProgress = fn; }
  set onFileComplete(fn) { this._onFileComplete = fn; }
  set onAllComplete(fn) { this._onAllComplete = fn; }
  set onError(fn) { this._onError = fn; }
  set onNeedDirectory(fn) { this._onNeedDirectory = fn; }

  // ─── Manifest handling ────────────────────────────────────────────

  /**
   * Handle an incoming MULTI_FILE_MANIFEST message.
   * @param {Object} manifest
   */
  async handleManifest(manifest) {
    this._manifest = manifest;
    this._startTime = Date.now();
    this._totalBytesReceived = 0;
    this._totalBytesWritten = 0;

    // Use sender's chunk size if provided, otherwise default to STORAGE_CHUNK_SIZE
    if (manifest.chunkSize) {
      this._senderChunkSize = manifest.chunkSize;
    }

    logger.log('[MultiFileReceiver] Received manifest:', manifest.totalFiles, 'files,', manifest.totalSize, 'bytes, chunkSize:', this._senderChunkSize);

    // Initialize per-file state and generate transfer IDs for tracking
    for (const f of manifest.files) {
      const transferId = `multi-recv-${Date.now()}-${f.index}`;
      this._transferIdsByFileIndex.set(f.index, transferId);
      
      // Create a promise that will resolve when WriteQueue is ready
      let resolveWriteQueue;
      const writeQueuePromise = new Promise(resolve => { resolveWriteQueue = resolve; });
      this._writeQueueReady.set(f.index, { promise: writeQueuePromise, resolve: resolveWriteQueue });
      
      this._files.set(f.index, {
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        relativePath: f.relativePath,
        totalChunks: f.totalChunks,
        receivedChunks: new Set(),
        bytesReceived: 0,
        bytesWritten: 0,
        completed: false,
        fileCompleteSent: false,  // Set to true when FILE_COMPLETE message received
        writable: null,
        writeQueue: null,  // WriteQueue to handle out-of-order chunks
        handle: null,
        blobParts: [],  // fallback when no directory handle
      });
    }

    if (this._onManifest) this._onManifest(manifest);
    
    // Start periodic progress sync to track actual write progress
    this._startProgressSync();
  }

  /**
   * Start periodic sync of bytesWritten from WriteQueues
   * This ensures UI progress reflects actual disk writes, not just buffered chunks
   */
  _startProgressSync() {
    if (this._progressSyncInterval) return;
    
    this._progressSyncInterval = setInterval(() => {
      this._syncWriteProgress();
    }, 200); // Update every 200ms for responsive UI
  }
  
  /**
   * Sync bytesWritten from all WriteQueues and emit progress
   */
  _syncWriteProgress() {
    let totalWritten = 0;
    
    for (const [idx, state] of this._files) {
      if (state.writeQueue && !state.completed) {
        const queueProgress = state.writeQueue.getProgress();
        const newBytesWritten = queueProgress.bytesWritten;
        
        // Only update if WriteQueue has made progress
        if (newBytesWritten > state.bytesWritten) {
          state.bytesWritten = newBytesWritten;
        }
      }
      totalWritten += state.bytesWritten;
    }
    
    if (totalWritten !== this._totalBytesWritten) {
      this._totalBytesWritten = totalWritten;
      this._emitProgress();
    }
  }

  /**
   * Stop periodic progress sync
   */
  _stopProgressSync() {
    if (this._progressSyncInterval) {
      clearInterval(this._progressSyncInterval);
      this._progressSyncInterval = null;
    }
  }

  // ─── Directory setup ──────────────────────────────────────────────

  /**
   * Set the directory handle where files will be saved.
   * Creates subdirectories as needed for files with relativePath.
   * @param {FileSystemDirectoryHandle} dirHandle
   */
  async setDirectoryHandle(dirHandle) {
    this._dirHandle = dirHandle;

    // Pre-create writable streams for each file
    for (const [idx, state] of this._files) {
      try {
        const fileHandle = await this._getOrCreateFileHandle(
          dirHandle,
          state.relativePath,
          state.name
        );
        state.handle = fileHandle;
        const writable = await fileHandle.createWritable();
        state.writable = writable;
        state.writeQueue = new WriteQueue(writable, (chunkIndex, error) => {
          logger.error(`[MultiFileReceiver] WriteQueue error for file ${idx} chunk ${chunkIndex}:`, error);
          state.writeError = true;
          if (this._onError) this._onError(error);
        });
        
        // Resolve the writeQueueReady promise for this file
        const readyInfo = this._writeQueueReady.get(idx);
        if (readyInfo) {
          readyInfo.resolve();
          logger.log(`[MultiFileReceiver] WriteQueue ready for file ${idx}`);
        }
      } catch (err) {
        // Sanitized name still rejected by FSAPI — try a safe fallback name
        logger.warn(`[MultiFileReceiver] Name rejected for file ${idx} ("${state.name}"), trying fallback...`);
        try {
          const ext = state.name.includes('.') ? state.name.slice(state.name.lastIndexOf('.')) : '';
          const fallbackName = `file_${idx}${this._sanitizeFileName(ext) || ''}`;
          const fileHandle = await this._getOrCreateFileHandle(
            dirHandle,
            null,  // skip relativePath — it might also be problematic
            fallbackName
          );
          state.handle = fileHandle;
          const writable = await fileHandle.createWritable();
          state.writable = writable;
          state.writeQueue = new WriteQueue(writable, (chunkIndex, error) => {
            logger.error(`[MultiFileReceiver] WriteQueue error for file ${idx} chunk ${chunkIndex}:`, error);
            state.writeError = true;
            if (this._onError) this._onError(error);
          });
          
          // Resolve the writeQueueReady promise for this file
          const readyInfo = this._writeQueueReady.get(idx);
          if (readyInfo) {
            readyInfo.resolve();
            logger.log(`[MultiFileReceiver] WriteQueue ready for file ${idx} (fallback name)`);
          }
          
          logger.log(`[MultiFileReceiver] Using fallback name: ${fallbackName}`);
        } catch (err2) {
          logger.error(`[MultiFileReceiver] Fallback also failed for file ${idx}:`, err2);
          // Will fall back to blob-based saving
        }
      }
    }
  }

  /**
   * Set a single file handle (for single-file transfers using showSaveFilePicker).
   * @param {FileSystemFileHandle} fileHandle
   */
  async setSingleFileHandle(fileHandle) {
    const state = this._files.get(0);
    if (state) {
      state.handle = fileHandle;
      const writable = await fileHandle.createWritable();
      state.writable = writable;
      state.writeQueue = new WriteQueue(writable, (chunkIndex, error) => {
        logger.error(`[MultiFileReceiver] WriteQueue error for single file chunk ${chunkIndex}:`, error);
        state.writeError = true;
        if (this._onError) this._onError(error);
      });
      
      // Resolve the writeQueueReady promise for this file
      const readyInfo = this._writeQueueReady.get(0);
      if (readyInfo) {
        readyInfo.resolve();
        logger.log(`[MultiFileReceiver] WriteQueue ready for single file`);
      }
    }
  }

  /**
   * Sanitize a filename for File System Access API.
   * The FSAPI is stricter than the OS filesystem — it rejects names that are
   * too long, contain certain patterns, or use Windows-reserved device names.
   */
  _sanitizeFileName(name) {
    if (!name) return 'unnamed_file';

    let safe = name
      // Replace characters illegal on Windows / FSAPI
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      // Replace any remaining control characters, zero-width chars, and surrogates
      .replace(/[\x7F\u200B-\u200F\uFEFF\uD800-\uDFFF]/g, '')
      // Replace any non-BMP characters (emoji, etc.) that might cause issues
      .replace(/[\u{10000}-\u{10FFFF}]/gu, '_')
      // Collapse runs of underscores/spaces into single underscore
      .replace(/[_\s]{2,}/g, '_')
      // Remove trailing dots, spaces, underscores (Windows / FSAPI rejects trailing . and space)
      .replace(/[\s._]+$/, '')
      // Remove leading dots, spaces, underscores
      .replace(/^[\s._]+/, '')
      .trim();

    // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    const stem = safe.split('.')[0];
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem)) {
      safe = '_' + safe;
    }

    // Ensure non-empty after all stripping
    if (!safe || safe === '_') return 'unnamed_file';

    // FSAPI / NTFS limit: 255 characters max for a single name component.
    // Truncate to 180 with extension preserved (leaves room for dedup suffixes).
    if (safe.length > 180) {
      const dotIdx = safe.lastIndexOf('.');
      if (dotIdx > 0 && dotIdx > safe.length - 20) {
        // Extension is within last 20 chars — preserve it
        const ext = safe.slice(dotIdx);
        const stem = safe.slice(0, 180 - ext.length);
        safe = stem + ext;
      } else {
        safe = safe.slice(0, 180);
      }
      // Re-strip any trailing dots/spaces from truncation
      safe = safe.replace(/[\s._]+$/, '') || 'unnamed_file';
    }

    return safe;
  }

  /**
   * Navigate/create subdirectories and return a file handle.
   * @param {FileSystemDirectoryHandle} rootDir
   * @param {string|null} relativePath — e.g. "/folder/subfolder"
   * @param {string} fileName
   * @returns {Promise<FileSystemFileHandle>}
   */
  async _getOrCreateFileHandle(rootDir, relativePath, fileName) {
    let currentDir = rootDir;

    if (relativePath) {
      // Remove leading slash, split into segments
      const parts = relativePath.replace(/^\/+/, '').split('/').filter(Boolean);
      for (const dir of parts) {
        const safeDir = this._sanitizeFileName(dir);
        currentDir = await currentDir.getDirectoryHandle(safeDir, { create: true });
      }
    }

    const safeName = this._sanitizeFileName(fileName);
    return currentDir.getFileHandle(safeName, { create: true });
  }

  // ─── Chunk handling ───────────────────────────────────────────────

  /**
   * Handle an incoming chunk-metadata message.
   * Stores metadata keyed by fileIndex. In parallel mode, multiple files
   * can have pending metadata simultaneously.
   * @param {Object} metadata — includes fileIndex, chunkIndex, size, checksum, etc.
   */
  handleChunkMetadata(metadata) {
    const { fileIndex, chunkIndex } = metadata;

    // Use a per-file queue of pending metadata to handle interleaving
    if (!this._pendingMetaQueues) this._pendingMetaQueues = new Map();
    if (!this._pendingMetaQueues.has(fileIndex)) {
      this._pendingMetaQueues.set(fileIndex, []);
    }
    this._pendingMetaQueues.get(fileIndex).push(metadata);

    // Also store in the flat map for FIFO fallback (backward compat)
    this._pendingMeta.set(fileIndex, metadata);
    // Track the order of metadata arrivals for binary matching
    if (!this._metaOrder) this._metaOrder = [];
    this._metaOrder.push(fileIndex);
    
    // Log chunk arrivals for sequential mode debugging
    if (chunkIndex === 0) {
      logger.log(`[MultiFileReceiver] File ${fileIndex} chunk 0 metadata received (transfer started)`);
    }
  }

  /**
   * Handle incoming binary data.
   * Uses the pre-matched metadata from per-channel queue (matched in useMessages.js)
   * to ensure correct chunkIndex even with multi-channel delivery.
   * @param {ArrayBuffer} data
   * @param {number} [fileIndex] — if known from the channel/context
   * @param {Object} [matchedMeta] — pre-matched metadata from per-channel queue
   */
  async handleBinaryChunk(data, fileIndex, matchedMeta) {
    // Use pre-matched metadata if provided (preferred — avoids cross-channel mismatch)
    let meta = matchedMeta || null;

    // If no pre-matched metadata, try to determine fileIndex and metadata
    if (!meta) {
      if (fileIndex === undefined) {
        if (this._metaOrder && this._metaOrder.length > 0) {
          fileIndex = this._metaOrder.shift();
        } else if (this._pendingMeta.size > 0) {
          const [fIdx] = this._pendingMeta.keys();
          fileIndex = fIdx;
        } else {
          logger.warn('[MultiFileReceiver] Binary chunk with no pending metadata, dropping');
          return;
        }
      }

      // Get metadata from per-file queue (fallback for non-channel-matched calls)
      if (this._pendingMetaQueues?.has(fileIndex)) {
        const queue = this._pendingMetaQueues.get(fileIndex);
        if (queue.length > 0) {
          meta = queue.shift();
        }
        if (queue.length === 0) {
          this._pendingMetaQueues.delete(fileIndex);
        }
      }

      // Fallback to flat map
      if (!meta) {
        meta = this._pendingMeta.get(fileIndex);
        if (meta) {
          this._pendingMeta.delete(fileIndex);
        }
      }

      if (!meta) {
        logger.warn(`[MultiFileReceiver] No pending metadata for file ${fileIndex}, using generic chunk index`);
        meta = { fileIndex, chunkIndex: undefined };
      }
    } else {
      // Pre-matched metadata provided — also drain it from the internal queues
      // so they don't accumulate stale entries
      if (this._pendingMetaQueues?.has(fileIndex)) {
        const queue = this._pendingMetaQueues.get(fileIndex);
        // Remove the matching entry (by chunkIndex) from the queue
        const idx = queue.findIndex(m => m.chunkIndex === meta.chunkIndex);
        if (idx !== -1) queue.splice(idx, 1);
        if (queue.length === 0) this._pendingMetaQueues.delete(fileIndex);
      }
      // Clean up flat map
      if (this._pendingMeta.has(fileIndex) && this._pendingMeta.get(fileIndex)?.chunkIndex === meta.chunkIndex) {
        this._pendingMeta.delete(fileIndex);
      }
    }

    const fileState = this._files.get(fileIndex);
    if (!fileState) {
      logger.error(`[MultiFileReceiver] Unknown fileIndex ${fileIndex}`);
      return;
    }

    // Skip chunks for files that already have a write error — avoids cascading failures
    if (fileState.writeError) {
      return;
    }

    const chunkIndex = meta?.chunkIndex ?? fileState.receivedChunks.size;
    
    // Safeguard: warn if we see unexpected chunk indices (indicates metadata mismatch)
    if (fileState.receivedChunks.has(chunkIndex)) {
      logger.warn(`[MultiFileReceiver] File ${fileIndex} chunk ${chunkIndex} received twice (duplicate), skipping`);
      return;
    }
    
    // Track early/late arrivals for diagnostics
    const earlyChunks = chunkIndex < 10;
    if (earlyChunks) {
      logger.log(`[MultiFileReceiver] Early chunk ${chunkIndex} arrived (data: ${data.byteLength} bytes)`);
    }
    
    fileState.receivedChunks.add(chunkIndex);
    fileState.bytesReceived += data.byteLength;
    this._totalBytesReceived += data.byteLength;

    // Verify chunk integrity via SHA-256 checksum (non-blocking).
    // Runs in parallel with disk write — does NOT stall the receive pipeline.
    if (meta?.checksum) {
      crypto.subtle.digest('SHA-256', data).then(hashBuffer => {
        const bytes = new Uint8Array(hashBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const actual = btoa(binary);
        if (actual !== meta.checksum) {
          logger.error(
            `[MultiFileReceiver] CHECKSUM MISMATCH file ${fileIndex} chunk ${chunkIndex}: ` +
            `expected=${meta.checksum} actual=${actual}`
          );
        }
      }).catch(err => {
        logger.warn(`[MultiFileReceiver] Checksum verification failed for file ${fileIndex} chunk ${chunkIndex}:`, err);
      });
    }

    // Track chunk completion in per-file bitmap (if tracking callback provided)
    const transferId = this._transferIdsByFileIndex.get(fileIndex);
    if (transferId && this._trackChunkProgress) {
      this._trackChunkProgress(transferId, chunkIndex, fileIndex);
    }

    // Write to disk or accumulate in memory
    // First, wait for WriteQueue to be ready (avoids early chunks going to blobParts)
    const readyInfo = this._writeQueueReady.get(fileIndex);
    if (readyInfo) {
      await Promise.race([
        readyInfo.promise,
        new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
      ]);
    }
    
    if (fileState.writeQueue) {
      try {
        // Use WriteQueue to handle out-of-order chunk arrival
        // WriteQueue buffers chunks and writes them sequentially, even if they arrive out of order
        const writeResult = await fileState.writeQueue.add(chunkIndex, data);
        
        // Track actual bytes written to disk (not just buffered)
        const queueProgress = fileState.writeQueue.getProgress();
        const newBytesWritten = queueProgress.bytesWritten;
        const deltaWritten = newBytesWritten - fileState.bytesWritten;
        if (deltaWritten > 0) {
          fileState.bytesWritten = newBytesWritten;
          this._totalBytesWritten += deltaWritten;
        }
      } catch (err) {
        logger.error(`[MultiFileReceiver] Write error for file ${fileIndex} chunk ${chunkIndex}:`, err);
        // Re-throw — do NOT silently buffer to blobParts (wastes RAM and corrupts output)
        throw err;
      }
    } else if (fileState.writable) {
      logger.warn(`[MultiFileReceiver] File ${fileIndex} chunk ${chunkIndex} using direct write (no WriteQueue)`);
      try {
        await fileState.writable.write(new Uint8Array(data));
      } catch (err) {
        logger.error(`[MultiFileReceiver] Direct write error for file ${fileIndex} chunk ${chunkIndex}:`, err);
        throw err;
      }
    } else {
      // WriteQueue not ready yet — only accumulate in blobParts as a last resort
      // (this path is only hit when directory picker wasn't used at all)
      if (!this._dirHandle) {
        fileState.blobParts.push(new Uint8Array(data));
      } else {
        // We have a directory handle but WriteQueue still isn't ready — something is wrong
        logger.error(`[MultiFileReceiver] File ${fileIndex} chunk ${chunkIndex}: WriteQueue not ready despite directory handle being set`);
        throw new Error(`WriteQueue not initialized for file ${fileIndex}`);
      }
    }

    // Progress
    this._emitProgress();
    
    // Mobile-specific: Check if WriteQueue is falling behind
    // If buffered chunks exceed 20 (300KB+ in memory), warn about backpressure
    if (fileState.writeQueue) {
      const queueProgress = fileState.writeQueue.getProgress();
      if (queueProgress.pending > 20) {
        logger.warn(`[MultiFileReceiver] File ${fileIndex}: WriteQueue backpressure - ${queueProgress.pending} chunks buffered, ${queueProgress.written} written`);
      }
    }

    // Check if this file is complete: all chunks received AND all written to disk
    // This handles late arrivals after FILE_COMPLETE was already sent
    const allChunksReceived = fileState.receivedChunks.size >= fileState.totalChunks;
    
    if (allChunksReceived && fileState.fileCompleteSent && !fileState.completed && fileState.writeQueue) {
      // FILE_COMPLETE already sent and now all chunks have finally arrived
      // Flush and complete the file
      const timeoutMs = 10000;
      await fileState.writeQueue.flush(timeoutMs);
      
      const queueProgress = fileState.writeQueue.getProgress();
      const allChunksWritten = queueProgress.written >= fileState.totalChunks && queueProgress.pending === 0;
      
      if (allChunksWritten && queueProgress.bytesWritten === fileState.size) {
        // All late chunks written successfully
        await this._completeFile(fileIndex);
      }
    }
  }

  /**
   * Handle FILE_COMPLETE message from sender.
   * Signals that sender has finished sending chunks.
   * Checks if all chunks have arrived and completes the file.
   * @param {number} fileIndex
   */
  async handleFileComplete(fileIndex) {
    const state = this._files.get(fileIndex);
    if (!state || state.completed) return;
    
    // Mark that sender has finished (may have late-arriving chunks)
    state.fileCompleteSent = true;
    
    const missingCount = state.totalChunks - state.receivedChunks.size;
    if (missingCount > 0) {
      logger.log(`[MultiFileReceiver] FILE_COMPLETE for file ${fileIndex}: waiting for ${missingCount} late chunks`);
      return; // Wait for late chunks to arrive
    }
    
    logger.log(`[MultiFileReceiver] FILE_COMPLETE for file ${fileIndex}: all chunks present`);
    
    // All chunks have arrived - complete the file
    if (state.writeQueue) {
      // Flush writeQueue with generous timeout for mobile
      const timeoutMs = 10000;
      await state.writeQueue.flush(timeoutMs);
      
      const queueProgress = state.writeQueue.getProgress();
      
      // Log final state for debugging
      if (queueProgress.pending > 0) {
        logger.warn(`[MultiFileReceiver] File ${fileIndex}: ${queueProgress.pending} chunks still in WriteQueue after flush timeout`);
        logger.warn(`[MultiFileReceiver] Written: ${queueProgress.written}/${state.totalChunks}, Bytes: ${queueProgress.bytesWritten}/${state.size}`);
      }
      
      // Check if all chunks were successfully written
      const allChunksWritten = queueProgress.written >= state.totalChunks && queueProgress.pending === 0;
      
      if (allChunksWritten) {
        // All chunks written successfully
        await this._completeFile(fileIndex);
      } else {
        // Not all chunks written — retry flush once more with extended timeout
        logger.warn(`[MultiFileReceiver] File ${fileIndex}: retrying flush (${queueProgress.pending} pending)`);
        await state.writeQueue.flush(15000);
        const retryProgress = state.writeQueue.getProgress();
        if (retryProgress.pending === 0) {
          await this._completeFile(fileIndex);
        } else {
          logger.error(`[MultiFileReceiver] File ${fileIndex}: could not flush all chunks, ${retryProgress.pending} lost`);
          // Complete anyway to avoid zombie files — some data is better than hanging
          await this._completeFile(fileIndex);
        }
      }
    }
  }

  // ─── File completion ──────────────────────────────────────────────

  async _completeFile(fileIndex) {
    const state = this._files.get(fileIndex);
    if (!state) return;
    if (state.completed) {
      logger.warn(`[MultiFileReceiver] File ${fileIndex} completion called twice`);
      return;
    }

    // Log completion with diagnostic info for sequential debugging
    logger.log(`[MultiFileReceiver] File ${fileIndex} complete: ${state.bytesReceived}/${state.size} bytes, ` +
              `${state.receivedChunks.size}/${state.totalChunks} chunks`);
    state.completed = true;

    // Close writable stream if using File System API
    if (state.writable) {
      try {
        // If some chunks ended up in blobParts before WriteQueue was ready,
        // write them to the writable stream BEFORE flushing the WriteQueue.
        // This prevents data loss when WriteQueue initialization was slow.
        if (state.blobParts.length > 0 && state.writeQueue) {
          logger.warn(`[MultiFileReceiver] File ${fileIndex}: ${state.blobParts.length} chunks in blobParts + WriteQueue — writing blobParts first`);
          // BlobParts contain early chunks (indices 0, 1, 2...) that arrived before WriteQueue.
          // These need to be written at the beginning of the file.
          // Since WriteQueue writes sequentially from nextExpected, and blobParts chunks
          // would have been the earliest chunks, the WriteQueue should start after them.
          // However, we can't insert data before what WriteQueue already wrote.
          // Best approach: if WriteQueue hasn't written anything yet, write blobParts first.
          const qp = state.writeQueue.getProgress();
          if (qp.written === 0) {
            // WriteQueue hasn't written anything — safe to write blobParts first
            for (const part of state.blobParts) {
              await state.writable.write(part);
            }
            logger.log(`[MultiFileReceiver] File ${fileIndex}: wrote ${state.blobParts.length} early blobParts before WriteQueue data`);
          } else {
            logger.warn(`[MultiFileReceiver] File ${fileIndex}: WriteQueue already started (${qp.written} chunks written), blobParts data may cause corruption — skipping blobParts`);
          }
          state.blobParts = [];
        }
        
        // Flush any pending writes in WriteQueue before closing
        if (state.writeQueue) {
          await state.writeQueue.flush();
        }
        await state.writable.close();
        state.writable = null; // Prevent double-close
        state.writeQueue = null; // Clear write queue
      } catch (err) {
        logger.warn(`[MultiFileReceiver] Error closing writable for file ${fileIndex}:`, err);
        // If writable close fails but we have blob data, fall back to download
        if (state.blobParts.length > 0) {
          await this._saveFallback(state);
        }
      }
    } else if (state.blobParts.length > 0) {
      // No writable stream — but if we have a directory handle, write there
      // This handles cases where writable creation failed during setDirectoryHandle
      if (this._dirHandle) {
        try {
          const fileHandle = await this._getOrCreateFileHandle(
            this._dirHandle,
            state.relativePath,
            state.name
          );
          const writable = await fileHandle.createWritable();
          const blob = new Blob(state.blobParts, { type: state.mimeType });
          await writable.write(blob);
          await writable.close();
          logger.log(`[MultiFileReceiver] Saved to directory: ${state.name}`);
        } catch (err) {
          logger.warn(`[MultiFileReceiver] Directory write fallback failed for ${state.name}:`, err);
          await this._saveFallback(state);
        }
      } else {
        // No directory handle at all — try per-file save picker or blob download
        await this._saveFallback(state);
      }
    }

    logger.log(`[MultiFileReceiver] File ${fileIndex} complete: ${state.name}`);
    if (this._onFileComplete) this._onFileComplete(fileIndex, state.name);

    // Check if all files done
    if (this._allFilesComplete()) {
      this._stopProgressSync(); // Stop periodic sync when all complete
      logger.log('[MultiFileReceiver] All files received!');
      if (this._onAllComplete) this._onAllComplete();
    }
  }

  // ─── Blob fallback ────────────────────────────────────────────────

  /**
   * Try showSaveFilePicker for a single file, then fall back to blob download.
   * showSaveFilePicker may fail without user gesture — that's OK, we fall back.
   */
  async _saveFallback(fileState) {
    const blob = new Blob(fileState.blobParts, { type: fileState.mimeType });

    // Try File System API's showSaveFilePicker (may work in some contexts)
    if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileState.name,
          types: [{
            description: 'File',
            accept: { [fileState.mimeType || 'application/octet-stream']: [] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        logger.log(`[MultiFileReceiver] Saved via showSaveFilePicker: ${fileState.name}`);
        return;
      } catch (err) {
        // Expected: user gesture required or user cancelled
        logger.log(`[MultiFileReceiver] showSaveFilePicker fallback failed, using blob download:`, err.message);
      }
    }

    // Final fallback: browser download
    this._downloadAsBlob(fileState, blob);
  }

  _downloadAsBlob(fileState, existingBlob) {
    try {
      const blob = existingBlob || new Blob(fileState.blobParts, { type: fileState.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Use clean filename, preserve relative path info
      const safeName = fileState.relativePath
        ? fileState.relativePath.replace(/^\/+/, '').replace(/\//g, '_') + '_' + fileState.name
        : fileState.name;
      a.download = this._sanitizeFileName(safeName);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a delay to ensure download starts
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      logger.error('[MultiFileReceiver] Blob download failed:', err);
    }
  }

  // ─── Progress ─────────────────────────────────────────────────────

  _emitProgress() {
    if (!this._onProgress || !this._manifest) return;

    // Throttle to max 5 updates/second to avoid flooding the UI with re-renders
    const now = Date.now();
    if (now - (this._lastProgressEmit || 0) < 200) return;
    this._lastProgressEmit = now;

    const elapsed = (now - this._startTime) / 1000;
    // Use bytes actually written for speed calculation (more accurate than buffered bytes)
    const speed = elapsed > 0 ? this._totalBytesWritten / elapsed : 0;
    const remaining = this._manifest.totalSize - this._totalBytesWritten;
    const eta = speed > 0 ? remaining / speed : null;

    const perFile = [];
    for (const [idx, state] of this._files) {
      // Calculate progress based on WRITTEN bytes, not just received
      // This ensures UI shows actual disk write progress, not just buffer arrivals
      const writtenProgress = state.size > 0 ? Math.round((state.bytesWritten / state.size) * 100) : 0;
      
      perFile.push({
        index: idx,
        name: state.name,
        size: state.size,
        progress: writtenProgress, // 🔧 Changed from bytesReceived to bytesWritten
        bytesReceived: state.bytesReceived,
        bytesWritten: state.bytesWritten, // Include both for diagnostics
        completed: state.completed,
        relativePath: state.relativePath,
      });
    }

    this._onProgress({
      overallProgress: this._manifest.totalSize > 0
        ? Math.round((this._totalBytesWritten / this._manifest.totalSize) * 100) // 🔧 Changed to bytesWritten
        : 0,
      totalBytes: this._manifest.totalSize,
      receivedBytes: this._totalBytesReceived,
      writtenBytes: this._totalBytesWritten, // Include for diagnostics
      speed, // Now based on actual disk writes
      eta,
      perFile,
    });
  }

  // ─── Queries ──────────────────────────────────────────────────────

  _allFilesComplete() {
    for (const [, state] of this._files) {
      if (!state.completed) return false;
    }
    return this._files.size > 0;
  }

  /** @returns {Object|null} */
  get manifest() {
    return this._manifest;
  }

  /** @returns {boolean} */
  get hasRelativePaths() {
    if (!this._manifest) return false;
    return this._manifest.files.some((f) => f.relativePath);
  }

  /** @returns {boolean} */
  get supportsDirectoryPicker() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  async destroy() {
    // Stop progress sync
    this._stopProgressSync();
    
    // Close any open writable streams
    for (const [, state] of this._files) {
      if (state.writable) {
        try { await state.writable.close(); } catch (_) { /* ignore */ }
      }
    }
    this._files.clear();
    this._pendingMeta.clear();
    if (this._pendingMetaQueues) this._pendingMetaQueues.clear();
    if (this._metaOrder) this._metaOrder.length = 0;
    this._manifest = null;
    this._totalBytesReceived = 0;
    this._totalBytesWritten = 0;
    this._dirHandle = null;
  }

  // ─── Resume manifest handling ─────────────────────────────────────

  /**
   * Handle a resume manifest — a manifest with isResume: true.
   * Skips completed files, re-opens writable streams for partial files
   * at the correct byte offset, and initializes pending files normally.
   * 
   * @param {Object} manifest - Manifest with isResume flag and perFileStartChunks
   */
  async handleResumeManifest(manifest) {
    this._manifest = manifest;
    this._startTime = Date.now();
    this._totalBytesReceived = 0;
    this._totalBytesWritten = 0;

    // Use sender's chunk size if provided
    if (manifest.chunkSize) {
      this._senderChunkSize = manifest.chunkSize;
    }

    const perFileStartChunks = manifest.perFileStartChunks || {};

    logger.log('[MultiFileReceiver] Received resume manifest:', manifest.totalFiles, 'files, chunkSize:', this._senderChunkSize);

    for (const f of manifest.files) {
      const startChunk = perFileStartChunks[f.index] || 0;
      const alreadyReceivedBytes = startChunk * this._senderChunkSize;

      // Pre-populate receivedChunks set for chunks already received
      const receivedChunks = new Set();
      for (let i = 0; i < startChunk; i++) {
        receivedChunks.add(i);
      }

      // Create a promise that will resolve when WriteQueue is ready
      let resolveWriteQueue;
      const writeQueuePromise = new Promise(resolve => { resolveWriteQueue = resolve; });
      this._writeQueueReady.set(f.index, { promise: writeQueuePromise, resolve: resolveWriteQueue });

      this._files.set(f.index, {
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        relativePath: f.relativePath,
        totalChunks: f.totalChunks,
        receivedChunks,
        bytesReceived: alreadyReceivedBytes,
        bytesWritten: 0, // Will be synced when WriteQueue initializes
        completed: startChunk >= f.totalChunks, // Already fully received
        fileCompleteSent: false,  // Set to true when FILE_COMPLETE message received
        writable: null,
        writeQueue: null,  // WriteQueue to handle out-of-order chunks
        handle: null,
        blobParts: [],
        resumeOffset: alreadyReceivedBytes,
      });

      this._totalBytesReceived += alreadyReceivedBytes;
    }

    if (this._onManifest) this._onManifest(manifest);
    
    // Start periodic progress sync
    this._startProgressSync();
  }

  /**
   * Set directory handle for resume — opens writable streams at correct offsets
   * for partially received files using seek().
   * 
   * @param {FileSystemDirectoryHandle} dirHandle
   */
  async setDirectoryHandleForResume(dirHandle) {
    this._dirHandle = dirHandle;

    for (const [idx, state] of this._files) {
      if (state.completed) continue; // Skip fully completed files

      try {
        const fileHandle = await this._getOrCreateFileHandle(
          dirHandle,
          state.relativePath,
          state.name
        );
        state.handle = fileHandle;
        state.writable = await fileHandle.createWritable({ keepExistingData: true });
        
        // Create WriteQueue for this file
        state.writeQueue = new WriteQueue(state.writable, (chunkIndex, error) => {
          logger.error(`[MultiFileReceiver] WriteQueue error for resume file ${idx} chunk ${chunkIndex}:`, error);
          state.writeError = true;
          if (this._onError) this._onError(error);
        });

        // Seek to the resume offset so we write after existing data
        if (state.resumeOffset > 0) {
          await state.writable.seek(state.resumeOffset);
          logger.log(`[MultiFileReceiver] File ${idx} resumed at byte offset ${state.resumeOffset}`);
        }
        
        // Resolve the writeQueueReady promise for this file
        const readyInfo = this._writeQueueReady.get(idx);
        if (readyInfo) {
          readyInfo.resolve();
          logger.log(`[MultiFileReceiver] WriteQueue ready for resume file ${idx}`);
        }
      } catch (err) {
        logger.error(`[MultiFileReceiver] Failed to open writable for resume file ${idx}:`, err);
      }
    }
  }
}
