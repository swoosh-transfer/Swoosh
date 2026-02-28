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
      // The last segment might be the filename itself or a directory
      // If relativePath includes the filename, use all-but-last as dirs
      // Convention: relativePath is the directory path, fileName is separate
      for (const dir of parts) {
        currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
      }
    }

    return currentDir.getFileHandle(fileName, { create: true });
  }

  // ─── Chunk handling ───────────────────────────────────────────────

  /**
   * Handle an incoming chunk-metadata message.
   * Prepares to receive the next binary on the same channel.
   * @param {Object} metadata — includes fileIndex, chunkIndex, size, checksum, etc.
   */
  handleChunkMetadata(metadata) {
    const { fileIndex } = metadata;
    this._pendingMeta.set(fileIndex, metadata);
  }

  /**
   * Handle incoming binary data.
   * Pairs with the most recent pending metadata by fileIndex (or uses channel heuristic).
   * @param {ArrayBuffer} data
   * @param {number} [fileIndex] — if known from the channel/context
   */
  async handleBinaryChunk(data, fileIndex) {
    // If fileIndex not provided, try to match with pending metadata
    if (fileIndex === undefined) {
      // Take the first pending metadata (FIFO)
      if (this._pendingMeta.size > 0) {
        const [fIdx] = this._pendingMeta.keys();
        fileIndex = fIdx;
      } else {
        logger.warn('[MultiFileReceiver] Binary chunk with no pending metadata, dropping');
        return;
      }
    }

    const meta = this._pendingMeta.get(fileIndex);
    this._pendingMeta.delete(fileIndex);

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

    // Close writable stream
    if (state.writable) {
      try {
        await state.writable.close();
      } catch (err) {
        logger.warn(`[MultiFileReceiver] Error closing writable for file ${fileIndex}:`, err);
      }
    } else if (state.blobParts.length > 0) {
      // Fallback: trigger download as blob
      this._downloadAsBlob(state);
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

  _downloadAsBlob(fileState) {
    try {
      const blob = new Blob(fileState.blobParts, { type: fileState.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Encode relativePath into filename for fallback
      const safeName = fileState.relativePath
        ? fileState.relativePath.replace(/^\/+/, '').replace(/\//g, '_') + '_' + fileState.name
        : fileState.name;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
    this._manifest = null;
    this._dirHandle = null;
  }
}
