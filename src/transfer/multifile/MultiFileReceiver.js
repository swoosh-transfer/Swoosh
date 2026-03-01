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
  constructor() {
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

    // Initialize per-file state
    for (const f of manifest.files) {
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
        logger.error(`[MultiFileReceiver] Failed to create handle for file ${idx}:`, err);
        // Will fall back to blob-based saving
      }
    }
  }

  /**
   * Sanitize a filename for File System Access API.
   * Removes characters that are invalid on Windows/macOS/Linux.
   */
  _sanitizeFileName(name) {
    if (!name) return 'unnamed_file';
    // Remove or replace characters invalid in filenames
    let safe = name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Windows-illegal chars
      .replace(/\.+$/, '')                        // Trailing dots
      .replace(/^\s+|\s+$/g, '')                  // Leading/trailing whitespace
      .trim();
    // Ensure non-empty
    return safe || 'unnamed_file';
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
    const { fileIndex } = metadata;

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
      this._pendingMeta.delete(fileIndex);
    } else {
      // Clean up flat map too
      if (!this._pendingMetaQueues?.has(fileIndex)) {
        this._pendingMeta.delete(fileIndex);
      }
    }

    const fileState = this._files.get(fileIndex);
    if (!fileState) {
      logger.warn(`[MultiFileReceiver] Unknown fileIndex ${fileIndex}`);
      return;
    }

    const chunkIndex = meta?.chunkIndex ?? fileState.receivedChunks.size;
    fileState.receivedChunks.add(chunkIndex);
    fileState.bytesReceived += data.byteLength;
    this._totalBytesReceived += data.byteLength;

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
    if (fileState.receivedChunks.size >= fileState.totalChunks) {
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
    if (!state || state.completed) return;

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
          this._downloadAsBlob(state);
        }
      }
    } else if (state.blobParts.length > 0) {
      // No File System handle — try showSaveFilePicker if available, else blob download
      await this._saveFallback(state);
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
}
