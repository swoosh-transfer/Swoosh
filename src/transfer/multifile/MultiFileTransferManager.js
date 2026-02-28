/**
 * MultiFileTransferManager — orchestrates sending multiple files
 * over multiple WebRTC data channels.
 *
 * Supports two modes:
 *   SEQUENTIAL — one file at a time, all channels contribute chunks
 *   PARALLEL   — multiple files sent concurrently across channels
 *
 * Uses the existing ChunkingEngine per-file and ChannelPool for I/O.
 */
import { FileQueue, FILE_STATE } from './FileQueue.js';
import { ChunkingEngine } from '../../utils/chunkingSystem.js';
import { BandwidthMonitor } from '../multichannel/BandwidthMonitor.js';
import {
  TRANSFER_MODE,
  STORAGE_CHUNK_SIZE,
  CHANNEL_SCALE_INTERVAL,
  MAX_CHANNELS,
  MIN_CHANNELS,
} from '../../constants/transfer.constants.js';
import { MESSAGE_TYPE } from '../../constants/messages.constants.js';
import logger from '../../utils/logger.js';

export class MultiFileTransferManager {
  /**
   * @param {import('../multichannel/ChannelPool.js').ChannelPool} channelPool
   * @param {Object} options
   * @param {Function} options.sendJSON      — send JSON on control channel
   * @param {Function} options.sendBinary    — send binary on a specific channel
   * @param {Function} options.waitForDrain  — wait for backpressure on a channel
   * @param {Function} options.addLog        — UI log helper
   * @param {string}   [options.mode]        — 'sequential' | 'parallel'
   */
  constructor(channelPool, options = {}) {
    this._pool = channelPool;
    this._sendJSON = options.sendJSON;
    this._sendBinary = options.sendBinary;
    this._waitForDrain = options.waitForDrain;
    this._addLog = options.addLog || (() => {});
    this._mode = options.mode || TRANSFER_MODE.SEQUENTIAL;

    /** @type {FileQueue|null} */
    this._queue = null;

    /** Per-file ChunkingEngine instances */
    this._engines = new Map(); // fileIndex → ChunkingEngine

    this._bandwidthMonitor = new BandwidthMonitor();
    this._scaleTimerId = null;

    this._isPaused = false;
    this._isCancelled = false;
    this._startTime = 0;
    this._totalBytesSent = 0;

    /** Callbacks */
    this._onProgress = null;      // (progressObj) => void
    this._onFileStart = null;     // (fileIndex) => void
    this._onFileComplete = null;  // (fileIndex) => void
    this._onAllComplete = null;   // () => void
    this._onError = null;         // (error) => void
  }

  // ─── Configuration ────────────────────────────────────────────────

  set mode(m) { this._mode = m; }
  get mode() { return this._mode; }

  set onProgress(fn) { this._onProgress = fn; }
  set onFileStart(fn) { this._onFileStart = fn; }
  set onFileComplete(fn) { this._onFileComplete = fn; }
  set onAllComplete(fn) { this._onAllComplete = fn; }
  set onError(fn) { this._onError = fn; }

  // ─── Start ────────────────────────────────────────────────────────

  /**
   * Begin the multi-file transfer.
   * @param {Array<{file: File, relativePath: string|null}>} files
   */
  async start(files) {
    this._queue = new FileQueue(files);
    this._isPaused = false;
    this._isCancelled = false;
    this._startTime = Date.now();
    this._totalBytesSent = 0;

    // Wire queue events to external callbacks
    this._queue.on('file-progress', (idx, pct, bytes) => {
      this._emitProgress();
    });

    // Send manifest
    const manifest = this._queue.getManifest();
    this._sendJSON({
      type: MESSAGE_TYPE.MULTI_FILE_MANIFEST,
      ...manifest,
      mode: this._mode,
    });
    this._addLog(`Sending ${manifest.totalFiles} file(s), ${this._formatBytes(manifest.totalSize)} total`, 'info');

    // Start bandwidth monitor & auto-scaling
    this._bandwidthMonitor.start();
    this._startAutoScaling();

    try {
      if (this._mode === TRANSFER_MODE.SEQUENTIAL) {
        await this._runSequential();
      } else {
        await this._runParallel();
      }

      if (!this._isCancelled) {
        // Send overall transfer-complete
        this._sendJSON({ type: MESSAGE_TYPE.TRANSFER_COMPLETE });
        this._addLog('All files sent!', 'success');
        if (this._onAllComplete) this._onAllComplete();
      }
    } catch (err) {
      logger.error('[MultiFileTransferManager] Transfer error:', err);
      this._addLog(`Transfer failed: ${err.message}`, 'error');
      if (this._onError) this._onError(err);
    } finally {
      this._bandwidthMonitor.stop();
      this._stopAutoScaling();
    }
  }

  // ─── Sequential mode ──────────────────────────────────────────────

  async _runSequential() {
    for (let i = 0; i < this._queue.length; i++) {
      if (this._isCancelled) break;
      await this._sendFile(i);
    }
  }

  // ─── Parallel mode ────────────────────────────────────────────────

  async _runParallel() {
    // Determine how many parallel slots we have (data channels ≥1, or just channel-0)
    const maxParallel = Math.max(this._pool.openDataCount, 1);
    const tasks = [];
    let nextFileIdx = 0;

    const runNext = async () => {
      while (nextFileIdx < this._queue.length && !this._isCancelled) {
        const idx = nextFileIdx++;
        await this._sendFile(idx);
      }
    };

    // Launch up to maxParallel workers
    const concurrency = Math.min(maxParallel, this._queue.length);
    for (let w = 0; w < concurrency; w++) {
      tasks.push(runNext());
    }
    await Promise.all(tasks);
  }

  // ─── Send a single file ──────────────────────────────────────────

  /**
   * Send one file from the queue.
   * @param {number} fileIndex
   */
  async _sendFile(fileIndex) {
    const item = this._queue.get(fileIndex);
    if (!item) return;

    this._queue.markSending(fileIndex);
    if (this._onFileStart) this._onFileStart(fileIndex);

    // Notify receiver which file is starting
    this._sendJSON({
      type: MESSAGE_TYPE.FILE_START,
      fileIndex,
      name: item.file.name,
      size: item.file.size,
      mimeType: item.file.type || 'application/octet-stream',
      relativePath: item.relativePath,
      totalChunks: Math.ceil(item.file.size / STORAGE_CHUNK_SIZE),
    });

    const engine = new ChunkingEngine();
    this._engines.set(fileIndex, engine);
    const transferId = `multi-${Date.now()}-${fileIndex}`;

    try {
      await engine.startChunking(
        transferId,
        item.file,
        null, // peerId — not used for multi-file path
        async ({ metadata, binaryData }) => {
          if (this._isCancelled) throw new Error('Transfer cancelled');
          await this._waitIfPaused();

          // Pick best channel
          const chIdx = this._pool.getAvailableChannel() ?? 0;
          await this._pool.waitForDrain(chIdx);

          // Send chunk metadata with fileIndex
          this._pool.send(chIdx, JSON.stringify({
            type: MESSAGE_TYPE.CHUNK_METADATA,
            fileIndex,
            channelIndex: chIdx,
            ...metadata,
          }));

          await this._pool.waitForDrain(chIdx);

          // Send binary
          const buffer = binaryData.buffer.slice(
            binaryData.byteOffset,
            binaryData.byteOffset + binaryData.byteLength
          );
          this._pool.send(chIdx, buffer);

          // Track bandwidth
          this._bandwidthMonitor.recordBytes(buffer.byteLength);
          this._totalBytesSent += buffer.byteLength;
        },
        (bytesRead, totalSize) => {
          this._queue.updateProgress(fileIndex, bytesRead);
        }
      );

      this._queue.markCompleted(fileIndex);
      this._sendJSON({ type: MESSAGE_TYPE.FILE_COMPLETE, fileIndex });
      this._addLog(`✓ ${item.file.name}`, 'success');
      if (this._onFileComplete) this._onFileComplete(fileIndex);

      // Cleanup engine
      engine.cleanup(transferId);
      this._engines.delete(fileIndex);

    } catch (err) {
      this._queue.markFailed(fileIndex, err.message);
      logger.error(`[MultiFileTransferManager] File ${fileIndex} failed:`, err);
      this._addLog(`✗ ${item.file.name}: ${err.message}`, 'error');
    }
  }

  // ─── Pause / Resume / Cancel ──────────────────────────────────────

  pause() {
    this._isPaused = true;
    for (const [, engine] of this._engines) {
      engine.pause?.();
    }
    this._addLog('Transfer paused', 'info');
  }

  resume() {
    this._isPaused = false;
    this._pauseResolve?.();
    for (const [, engine] of this._engines) {
      engine.resume?.();
    }
    this._addLog('Transfer resumed', 'info');
  }

  cancel() {
    this._isCancelled = true;
    this._isPaused = false;
    this._pauseResolve?.();
    for (const [, engine] of this._engines) {
      engine.cancel?.();
    }
    this._sendJSON({ type: MESSAGE_TYPE.TRANSFER_CANCELLED });
    this._addLog('Transfer cancelled', 'info');
  }

  get isPaused() { return this._isPaused; }
  get isCancelled() { return this._isCancelled; }

  /** @returns {FileQueue|null} */
  get queue() { return this._queue; }

  // ─── Auto-scaling ─────────────────────────────────────────────────

  _startAutoScaling() {
    this._scaleTimerId = setInterval(() => {
      if (this._isPaused || this._isCancelled) return;

      const currentCount = this._pool.openCount;
      const recommended = this._bandwidthMonitor.getRecommendedChannelCount(currentCount);

      if (recommended > currentCount && currentCount < MAX_CHANNELS) {
        // Scale up — add a data channel
        const newIdx = this._pool.size; // next index
        this._pool.addChannel(newIdx);
        this._addLog(`↑ Scaled to ${currentCount + 1} channels`, 'info');
        logger.log(`[MultiFileTransferManager] Scaled UP to ${currentCount + 1} channels`);
      } else if (recommended < currentCount && currentCount > MIN_CHANNELS) {
        // Scale down — remove the highest-indexed data channel
        const indices = this._pool.indices.filter((i) => i >= 1);
        if (indices.length > 0) {
          const remove = indices[indices.length - 1];
          this._pool.removeChannel(remove);
          this._addLog(`↓ Scaled to ${currentCount - 1} channels`, 'info');
          logger.log(`[MultiFileTransferManager] Scaled DOWN to ${currentCount - 1} channels`);
        }
      }
    }, CHANNEL_SCALE_INTERVAL);
  }

  _stopAutoScaling() {
    if (this._scaleTimerId) {
      clearInterval(this._scaleTimerId);
      this._scaleTimerId = null;
    }
  }

  // ─── Progress emission ────────────────────────────────────────────

  _emitProgress() {
    if (!this._onProgress || !this._queue) return;

    const elapsed = (Date.now() - this._startTime) / 1000;
    const speed = elapsed > 0 ? this._totalBytesSent / elapsed : 0;
    const queueProgress = this._queue.getProgress();
    const remaining = queueProgress.totalBytes - queueProgress.sentBytes;
    const eta = speed > 0 ? remaining / speed : null;

    this._onProgress({
      ...queueProgress,
      speed,
      eta,
      channelCount: this._pool.openCount,
      mode: this._mode,
      elapsed,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  _waitIfPaused() {
    if (!this._isPaused) return Promise.resolve();
    return new Promise((resolve) => {
      this._pauseResolve = resolve;
    });
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  /** Cleanup all state. */
  destroy() {
    this._stopAutoScaling();
    this._bandwidthMonitor.stop();
    for (const [tid, engine] of this._engines) {
      engine.cleanup?.(tid);
    }
    this._engines.clear();
    this._queue = null;
  }
}
