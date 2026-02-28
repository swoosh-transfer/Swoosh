/**
 * FileQueue — ordered queue of files to transfer.
 *
 * Each entry: { file: File, relativePath: string | null }
 * Tracks per-file state and provides manifest generation / progress queries.
 */
import logger from '../../utils/logger.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';

/**
 * Per-file states
 */
export const FILE_STATE = {
  PENDING: 'pending',
  SENDING: 'sending',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

export class FileQueue {
  /**
   * @param {Array<{file: File, relativePath: string|null}>} entries
   */
  constructor(entries = []) {
    /** @type {Array<{file: File, relativePath: string|null, state: string, progress: number, error: string|null}>} */
    this._items = entries.map((e) => ({
      file: e.file,
      relativePath: e.relativePath || null,
      state: FILE_STATE.PENDING,
      progress: 0,       // 0-100
      bytesSent: 0,
      error: null,
    }));

    /** Current index pointer */
    this._currentIndex = 0;

    /** Event listeners: event → Set<Function> */
    this._listeners = {};
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /** @returns {number} */
  get length() {
    return this._items.length;
  }

  /** @returns {boolean} */
  get isEmpty() {
    return this._items.length === 0;
  }

  /** @returns {number} */
  get currentIndex() {
    return this._currentIndex;
  }

  /**
   * Get the current item (or null if exhausted).
   */
  current() {
    return this._currentIndex < this._items.length
      ? this._items[this._currentIndex]
      : null;
  }

  /**
   * Advance to the next file. Returns the new current item or null.
   */
  next() {
    if (this._currentIndex < this._items.length) {
      this._currentIndex++;
    }
    return this.current();
  }

  /** @returns {boolean} all files completed or failed */
  get allDone() {
    return this._items.every(
      (it) => it.state === FILE_STATE.COMPLETED || it.state === FILE_STATE.FAILED
    );
  }

  /** Get item by index */
  get(index) {
    return this._items[index] ?? null;
  }

  /** Get all items (read-only snapshot). */
  getAll() {
    return this._items.map((it) => ({ ...it }));
  }

  // ─── State mutations ──────────────────────────────────────────────

  /**
   * Mark a file as sending.
   * @param {number} index
   */
  markSending(index) {
    const it = this._items[index];
    if (!it) return;
    it.state = FILE_STATE.SENDING;
    this._emit('file-state', index, FILE_STATE.SENDING);
  }

  /**
   * Update progress for a file.
   * @param {number} index
   * @param {number} bytesSent
   */
  updateProgress(index, bytesSent) {
    const it = this._items[index];
    if (!it) return;
    it.bytesSent = bytesSent;
    it.progress = Math.round((bytesSent / it.file.size) * 100);
    this._emit('file-progress', index, it.progress, bytesSent);
  }

  /**
   * Mark a file as completed.
   * @param {number} index
   */
  markCompleted(index) {
    const it = this._items[index];
    if (!it) return;
    it.state = FILE_STATE.COMPLETED;
    it.progress = 100;
    it.bytesSent = it.file.size;
    this._emit('file-state', index, FILE_STATE.COMPLETED);
  }

  /**
   * Mark a file as failed.
   * @param {number} index
   * @param {string} error
   */
  markFailed(index, error) {
    const it = this._items[index];
    if (!it) return;
    it.state = FILE_STATE.FAILED;
    it.error = error;
    this._emit('file-state', index, FILE_STATE.FAILED);
  }

  // ─── Manifest ─────────────────────────────────────────────────────

  /**
   * Generate a manifest suitable for the MULTI_FILE_MANIFEST message.
   * @returns {Object}
   */
  getManifest() {
    return {
      totalFiles: this._items.length,
      totalSize: this._items.reduce((sum, it) => sum + it.file.size, 0),
      files: this._items.map((it, idx) => ({
        index: idx,
        name: it.file.name,
        size: it.file.size,
        mimeType: it.file.type || 'application/octet-stream',
        relativePath: it.relativePath,
        totalChunks: Math.ceil(it.file.size / STORAGE_CHUNK_SIZE),
      })),
    };
  }

  // ─── Aggregate progress ───────────────────────────────────────────

  /**
   * @returns {{ overallProgress: number, totalBytes: number, sentBytes: number, perFile: Array }}
   */
  getProgress() {
    const totalBytes = this._items.reduce((s, it) => s + it.file.size, 0);
    const sentBytes = this._items.reduce((s, it) => s + it.bytesSent, 0);
    const overallProgress = totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : 0;

    return {
      overallProgress,
      totalBytes,
      sentBytes,
      perFile: this._items.map((it, idx) => ({
        index: idx,
        name: it.file.name,
        size: it.file.size,
        state: it.state,
        progress: it.progress,
        bytesSent: it.bytesSent,
        error: it.error,
      })),
    };
  }

  // ─── Events ───────────────────────────────────────────────────────

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = new Set();
    this._listeners[event].add(fn);
  }

  off(event, fn) {
    this._listeners[event]?.delete(fn);
  }

  _emit(event, ...args) {
    if (this._listeners[event]) {
      for (const fn of this._listeners[event]) {
        try { fn(...args); } catch (e) { logger.error('[FileQueue] listener error:', e); }
      }
    }
  }
}
