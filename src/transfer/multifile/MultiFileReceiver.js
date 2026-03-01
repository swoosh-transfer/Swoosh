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

    /** Per-file state: Map<fileIndex, { writable, handle, receivedChunks, totalChunks, bytesReceived, completed }> */
    this._files = new Map();

    /** Pending binary data keyed by fileIndex (when metadata arrives before binary) */
    this._pendingBinary = new Map();

    /** Metadata waiting for its binary partner: fileIndex → metadata */
    this._pendingMeta = new Map();

    /** Callbacks */
    this._onManifest = null;           // (manifest) => void
    this._onProgress = null;           // (progressObj) => void
    this._onFileComplete = null;       // (fileIndex, name) => void
    this._onAllComplete = null;        // () => void
    this._onError = null;              // (error) => void
    this._onNeedDirectory = null;      // () => Promise — prompt user for directory

    this._totalBytesReceived = 0;
    this._startTime = 0;
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

    logger.log('[MultiFileReceiver] Received manifest:', manifest.totalFiles, 'files,', manifest.totalSize, 'bytes');

    // Initialize per-file state and generate transfer IDs for tracking
    for (const f of manifest.files) {
      const transferId = `multi-recv-${Date.now()}-${f.index}`;
      this._transferIdsByFileIndex.set(f.index, transferId);
      
      this._files.set(f.index, {
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        relativePath: f.relativePath,
        totalChunks: f.totalChunks,
        receivedChunks: new Set(),
        bytesReceived: 0,
        completed: false,
        writable: null,
        handle: null,
        blobParts: [],  // fallback when no directory handle
      });
    }

    if (this._onManifest) this._onManifest(manifest);
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
        state.writable = await fileHandle.createWritable();
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
          state.writable = await fileHandle.createWritable();
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
      state.writable = await fileHandle.createWritable();
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
   * Matches with pending metadata using the arrival order.
   * @param {ArrayBuffer} data
   * @param {number} [fileIndex] — if known from the channel/context
   */
  async handleBinaryChunk(data, fileIndex) {
    // If fileIndex not provided, match with the oldest pending metadata
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

    // Safeguard: verify fileIndex has pending metadata
    if (!this._pendingMeta.has(fileIndex) && 
        (!this._pendingMetaQueues?.has(fileIndex) || this._pendingMetaQueues.get(fileIndex).length === 0)) {
      logger.error(`[MultiFileReceiver] Binary for file ${fileIndex} has no pending metadata, data mismatch!`);
      return;
    }

    // Get metadata from per-file queue
    let meta = null;
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
    } else {
      // Clean up flat map too if we got metadata from the queue
      if (!this._pendingMetaQueues?.has(fileIndex)) {
        this._pendingMeta.delete(fileIndex);
      }
    }

    // Warn if no metadata found, but still try to process (with generic metadata)
    if (!meta) {
      logger.warn(`[MultiFileReceiver] No pending metadata for file ${fileIndex}, using generic chunk index`);
      meta = { fileIndex, chunkIndex: undefined };
    }

    const fileState = this._files.get(fileIndex);
    if (!fileState) {
      logger.error(`[MultiFileReceiver] Unknown fileIndex ${fileIndex}`);
      return;
    }

    const chunkIndex = meta?.chunkIndex ?? fileState.receivedChunks.size;
    
    // Safeguard: warn if we see unexpected chunk indices (indicates metadata mismatch)
    if (fileState.receivedChunks.has(chunkIndex)) {
      logger.warn(`[MultiFileReceiver] File ${fileIndex} chunk ${chunkIndex} received twice (duplicate), skipping`);
      return;
    }
    
    fileState.receivedChunks.add(chunkIndex);
    fileState.bytesReceived += data.byteLength;
    this._totalBytesReceived += data.byteLength;

    // Track chunk completion in bitmap (if tracking callback provided)
    const transferId = this._transferIdsByFileIndex.get(fileIndex);
    if (transferId && this._trackChunkProgress) {
      this._trackChunkProgress(transferId, chunkIndex);
    }

    // Write to disk or accumulate in memory
    if (fileState.writable) {
      try {
        await fileState.writable.write(new Uint8Array(data));
      } catch (err) {
        logger.error(`[MultiFileReceiver] Write error for file ${fileIndex}:`, err);
        // Fallback to blob
        fileState.blobParts.push(new Uint8Array(data));
      }
    } else {
      fileState.blobParts.push(new Uint8Array(data));
    }

    // Progress
    this._emitProgress();

    // Check if this file is complete
    const isComplete = fileState.receivedChunks.size >= fileState.totalChunks;
    if (isComplete) {
      // Sanity check: verify byte count matches expected total
      if (fileState.bytesReceived !== fileState.totalBytes) {
        logger.warn(`[MultiFileReceiver] File ${fileIndex}: chunk count complete but byte mismatch! ` +
                   `Expected ${fileState.totalBytes}, got ${fileState.bytesReceived}`);
      }
      await this._completeFile(fileIndex);
    }
  }

  /**
   * Handle FILE_COMPLETE message from sender.
   * @param {number} fileIndex
   */
  async handleFileComplete(fileIndex) {
    await this._completeFile(fileIndex);
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
    logger.log(`[MultiFileReceiver] File ${fileIndex} complete: ${state.bytesReceived}/${state.totalBytes} bytes, ` +
              `${state.receivedChunks.size}/${state.totalChunks} chunks`);
    state.completed = true;

    // Close writable stream if using File System API
    if (state.writable) {
      try {
        await state.writable.close();
        state.writable = null; // Prevent double-close
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

    const elapsed = (Date.now() - this._startTime) / 1000;
    const speed = elapsed > 0 ? this._totalBytesReceived / elapsed : 0;
    const remaining = this._manifest.totalSize - this._totalBytesReceived;
    const eta = speed > 0 ? remaining / speed : null;

    const perFile = [];
    for (const [idx, state] of this._files) {
      perFile.push({
        index: idx,
        name: state.name,
        size: state.size,
        progress: state.size > 0 ? Math.round((state.bytesReceived / state.size) * 100) : 0,
        bytesReceived: state.bytesReceived,
        completed: state.completed,
        relativePath: state.relativePath,
      });
    }

    this._onProgress({
      overallProgress: this._manifest.totalSize > 0
        ? Math.round((this._totalBytesReceived / this._manifest.totalSize) * 100)
        : 0,
      totalBytes: this._manifest.totalSize,
      receivedBytes: this._totalBytesReceived,
      speed,
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

    const perFileStartChunks = manifest.perFileStartChunks || {};

    logger.log('[MultiFileReceiver] Received resume manifest:', manifest.totalFiles, 'files');

    for (const f of manifest.files) {
      const startChunk = perFileStartChunks[f.index] || 0;
      const alreadyReceivedBytes = startChunk * STORAGE_CHUNK_SIZE;

      // Pre-populate receivedChunks set for chunks already received
      const receivedChunks = new Set();
      for (let i = 0; i < startChunk; i++) {
        receivedChunks.add(i);
      }

      this._files.set(f.index, {
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        relativePath: f.relativePath,
        totalChunks: f.totalChunks,
        receivedChunks,
        bytesReceived: alreadyReceivedBytes,
        completed: startChunk >= f.totalChunks, // Already fully received
        writable: null,
        handle: null,
        blobParts: [],
        resumeOffset: alreadyReceivedBytes,
      });

      this._totalBytesReceived += alreadyReceivedBytes;
    }

    if (this._onManifest) this._onManifest(manifest);
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

        // Seek to the resume offset so we write after existing data
        if (state.resumeOffset > 0) {
          await state.writable.seek(state.resumeOffset);
          logger.log(`[MultiFileReceiver] File ${idx} resumed at byte offset ${state.resumeOffset}`);
        }
      } catch (err) {
        logger.error(`[MultiFileReceiver] Failed to open writable for resume file ${idx}:`, err);
      }
    }
  }
}
