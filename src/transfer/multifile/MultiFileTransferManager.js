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
import { ChunkingEngine } from '../sending/ChunkingEngine.js';
import { BandwidthMonitor } from '../multichannel/BandwidthMonitor.js';
import { formatBytes } from '../../lib/formatters.js';
import {
  TRANSFER_MODE,
  STORAGE_CHUNK_SIZE,
  NETWORK_CHUNK_SIZE,
  CHANNEL_SCALE_INTERVAL,
  MAX_CHANNELS,
  MIN_CHANNELS,
  getTransferReliabilityProfile,
} from '../../constants/transfer.constants.js';
import { MESSAGE_TYPE } from '../../constants/messages.constants.js';
import {
  deserializeBitmap,
  getFirstMissingChunk,
} from '../../infrastructure/database/chunkBitmap.js';
import logger from '../../utils/logger.js';

export class MultiFileTransferManager {
  /**
   * @param {import('../multichannel/ChannelPool.js').ChannelPool} channelPool
   * @param {Object} options
   * @param {Function} options.sendJSON          — send JSON on control channel
   * @param {Function} options.sendBinary        — send binary on a specific channel
   * @param {Function} options.waitForDrain      — wait for backpressure on a channel
   * @param {Function} options.addLog            — UI log helper
   * @param {Function} [options.trackChunkProgress] — track chunk completion in bitmap
   * @param {string}   [options.mode]            — 'sequential' | 'parallel'
   */
  constructor(channelPool, options = {}) {
    this._pool = channelPool;
    this._sendJSON = options.sendJSON;
    this._sendBinary = options.sendBinary;
    this._waitForDrain = options.waitForDrain;
    this._addLog = options.addLog || (() => {});
    this._trackChunkProgress = options.trackChunkProgress || (() => {});
    this._mode = options.mode || TRANSFER_MODE.SEQUENTIAL;
    this._profile = getTransferReliabilityProfile();
    this._maxAutoChannels = Math.max(
      MIN_CHANNELS,
      Math.min(MAX_CHANNELS, this._profile.maxChannels)
    );
    this._maxParallelWorkers = this._profile.minParallelWorkers;
    this._channelScaleInterval = this._profile.channelScaleInterval;

    /** Effective chunk size: 16KB on mobile, 64KB on desktop */
    this._chunkSize = this._profile.constrained ? NETWORK_CHUNK_SIZE : STORAGE_CHUNK_SIZE;

    /** @type {FileQueue|null} */
    this._queue = null;

    /** Per-file ChunkingEngine instances */
    this._engines = new Map(); // fileIndex → ChunkingEngine

    this._bandwidthMonitor = new BandwidthMonitor();
    this._scaleTimerId = null;

    this._isPaused = false;
    this._isCancelled = false;
    this._isChannelDead = false;
    this._startTime = 0;
    this._totalBytesSent = 0;    this._lastProgressEmit = 0; // Throttle progress emission
    /** Per-channel send locks — prevents metadata/binary interleaving in parallel mode */
    this._channelLocks = new Map(); // channelIndex → Promise

    /** Resume support: per-file bitmaps of chunks the receiver has */
    this._fileBitmaps = new Map(); // fileIndex → base64 bitmap

    /** Promise resolved when receiver sends receiver-ready */
    this._receiverReadyResolve = null;
    this._receiverReady = false;

    /** Callbacks */
    this._onProgress = null;      // (progressObj) => void
    this._onFileStart = null;     // (fileIndex) => void
    this._onFileComplete = null;  // (fileIndex) => void
    this._onAllComplete = null;   // () => void
    this._onError = null;         // (error) => void

    if (this._profile.constrained) {
      this._addLog('Using mobile reliability transfer profile', 'info');
    }
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
    const manifest = this._queue.getManifest(this._chunkSize);
    this._sendJSON({
      type: MESSAGE_TYPE.MULTI_FILE_MANIFEST,
      ...manifest,
      chunkSize: this._chunkSize,
      mode: this._mode,
    });
    this._addLog(`Sending ${manifest.totalFiles} file(s), ${this._formatBytes(manifest.totalSize)} total`, 'info');

    // Wait for receiver to accept and send receiver-ready
    this._addLog('Waiting for receiver to accept...', 'info');
    await this._waitForReceiverReady();

    if (this._isCancelled) return;

    this._warmupDataChannels();

    // Start bandwidth monitor and auto-scaling for multi-channel support
    this._bandwidthMonitor.start();
    this._startAutoScaling();

    try {
      if (this._mode === TRANSFER_MODE.SEQUENTIAL) {
        await this._runSequential();
      } else {
        await this._runParallel();
      }

      if (!this._isCancelled) {
        // Check if any files actually succeeded
        const progress = this._queue.getProgress();
        const succeeded = progress.perFile.filter(f => f.state === 'completed').length;
        const failed = progress.perFile.filter(f => f.state === 'failed').length;

        // Only send transfer-complete if at least one file succeeded and channels alive
        if (succeeded > 0 && !this._isChannelDead && this._pool.openCount > 0) {
          this._sendJSON({ type: MESSAGE_TYPE.TRANSFER_COMPLETE });
        }

        if (failed === 0) {
          this._addLog('All files sent!', 'success');
        } else if (this._isChannelDead) {
          this._addLog(`Transfer interrupted — peer disconnected (${succeeded} sent, ${failed} failed)`, 'warning');
        } else if (succeeded > 0) {
          this._addLog(`${succeeded} file(s) sent, ${failed} failed`, 'warning');
        } else {
          this._addLog(`All ${failed} file(s) failed to send`, 'error');
        }

        if (this._isChannelDead) {
          if (this._onError) this._onError(new Error('Peer disconnected during transfer'));
        } else if (failed > 0 && succeeded === 0) {
          // All files failed — surface as error, not completion
          if (this._onError) this._onError(new Error(`All ${failed} file(s) failed to send`));
        } else {
          if (this._onAllComplete) this._onAllComplete();
        }
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
      if (this._isCancelled || this._isChannelDead) break;
      await this._sendFile(i);
    }
  }

  // ─── Parallel mode ────────────────────────────────────────────────

  async _runParallel() {
    // Use at least 3 concurrent file workers regardless of channel count.
    // Even on a single channel, interleaving chunks from multiple files
    // gives the user visible parallel progress and overlaps I/O.
    const maxParallel = Math.max(this._pool.openDataCount, this._maxParallelWorkers);
    const tasks = [];
    let nextFileIdx = 0;

    const runNext = async () => {
      while (nextFileIdx < this._queue.length && !this._isCancelled && !this._isChannelDead) {
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

    // Check channels are alive before starting
    if (this._pool.openCount === 0) {
      this._isChannelDead = true;
      this._queue.markFailed(fileIndex, 'Channels closed');
      this._addLog(`✗ ${item.file.name}: peer disconnected`, 'error');
      return;
    }

    // Notify receiver which file is starting
    this._sendJSON({
      type: MESSAGE_TYPE.FILE_START,
      fileIndex,
      name: item.file.name,
      size: item.file.size,
      mimeType: item.file.type || 'application/octet-stream',
      relativePath: item.relativePath,
      totalChunks: Math.ceil(item.file.size / this._chunkSize),
      chunkSize: this._chunkSize,
    });

    const engine = new ChunkingEngine();
    this._engines.set(fileIndex, engine);
    const transferId = `multi-${Date.now()}-${fileIndex}`;

    // Check if receiver has already completed this file (resume scenario)
    let resumeFromChunk = 0;
    const fileBitmap = this._fileBitmaps.get(fileIndex);
    if (fileBitmap) {
      const totalChunks = Math.ceil(item.file.size / this._chunkSize);
      const decodedBitmap = deserializeBitmap(fileBitmap);
      resumeFromChunk = getFirstMissingChunk(decodedBitmap, totalChunks);
      
      if (resumeFromChunk === -1) {
        // All chunks already received — skip this file
        this._addLog(`✓ ${item.file.name}: already complete on receiver`, 'info');
        this._queue.markCompleted(fileIndex);
        if (this._onFileComplete) this._onFileComplete(fileIndex);
        return;
      }
      
      if (resumeFromChunk > 0) {
        this._addLog(`Resuming ${item.file.name} from chunk ${resumeFromChunk}`, 'info');
      }
    }

    try {
      await engine.startChunking(
        transferId,
        item.file,
        null, // peerId — not used for multi-file path
        async ({ metadata, binaryData }) => {
          if (this._isCancelled) throw new Error('Transfer cancelled');
          if (this._isChannelDead || this._pool.openCount === 0) {
            throw new Error('Channels closed — peer disconnected');
          }
          await this._waitIfPaused();

          // Pick best data channel (never use channel-0 for chunks)
          let chIdx = this._pool.getAvailableChannel();
          
          // Wait for data channels to open if needed
          let retries = 0;
          while (chIdx === null && retries < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            chIdx = this._pool.getAvailableChannel();
            retries++;
          }
          
          if (chIdx === null) {
            throw new Error('No data channels available — transfer failed');
          }

          // Acquire per-channel lock to prevent metadata/binary interleaving
          // in parallel mode (two workers could pick the same channel)
          while (this._channelLocks.has(chIdx)) {
            await this._channelLocks.get(chIdx);
          }

          // Set lock before sending metadata+binary pair
          let releaseLock;
          const lockPromise = new Promise(resolve => { releaseLock = resolve; });
          this._channelLocks.set(chIdx, lockPromise);

          let bytesSent = 0;
          try {
            // Only wait for drain once — before the binary payload.
            // Metadata JSON is tiny (~200 bytes), no need to wait before it.
            await this._pool.waitForDrain(chIdx);

            // Send chunk metadata with fileIndex
            this._pool.send(chIdx, JSON.stringify({
              type: MESSAGE_TYPE.CHUNK_METADATA,
              fileIndex,
              channelIndex: chIdx,
              ...metadata,
            }));

            // Send binary — use the Uint8Array directly (avoid copying via .buffer.slice)
            this._pool.send(chIdx, binaryData);
            bytesSent = binaryData.byteLength;
          } finally {
            // Release the channel lock
            this._channelLocks.delete(chIdx);
            releaseLock();
          }

          // Track bandwidth and progress
          this._bandwidthMonitor.recordBytes(bytesSent);
          this._totalBytesSent += bytesSent;

          // Track chunk completion in per-file bitmap
          if (this._trackChunkProgress) {
            this._trackChunkProgress(transferId, metadata.chunkIndex, fileIndex);
          }

          // Emit progress immediately per-chunk for responsive UI
          this._emitProgress();
        },
        // onProgress — update FileQueue per-file progress
        (bytesRead, _totalSize) => {
          this._queue.updateProgress(fileIndex, bytesRead);
        },
        resumeFromChunk // Resume from chunk if applicable
      );

      // CRITICAL: Flush all channels to ensure all chunks are sent before marking complete
      // This ensures the receiver has time to receive all chunks before FILE_COMPLETE message
      for (let chIdx = 0; chIdx < this._pool.size; chIdx++) {
        const ch = this._pool.getChannel(chIdx);
        if (ch && ch.readyState === 'open') {
          await this._pool.waitForDrain(chIdx);
        }
      }

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

      // If the error is a channel/connection failure, stop sending more files
      if (err.message?.includes('not open') || err.message?.includes('Channel') ||
          this._pool.openCount === 0) {
        this._isChannelDead = true;
        logger.log('[MultiFileTransferManager] Channels dead — stopping queue');
      }
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
    // Unblock receiver-ready wait if still pending
    this._receiverReadyResolve?.();
    this._receiverReadyResolve = null;
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
    this._scaleTimerId = setInterval(async () => {
      if (this._isPaused || this._isCancelled) return;

      const currentDataCount = Math.max(this._pool.openDataCount, 1);
      const recommended = this._bandwidthMonitor.getRecommendedChannelCount(currentDataCount);

      if (recommended > currentDataCount && currentDataCount < this._maxAutoChannels) {
        // Scale up — add a data channel
        const newIdx = this._pool.size; // next index
        this._pool.addChannel(newIdx);
        this._addLog(`↑ Scaled to ${currentDataCount + 1} channels`, 'info');
        logger.log(`[MultiFileTransferManager] Scaled UP to ${currentDataCount + 1} channels`);
      } else if (recommended < currentDataCount && currentDataCount > MIN_CHANNELS) {
        // Scale down — remove the highest-indexed data channel ONLY if idle
        const indices = this._pool.indices.filter((i) => i >= 1);
        if (indices.length > 0) {
          const remove = indices[indices.length - 1];
          const ch = this._pool.getChannel(remove);
          // Only remove if channel has no buffered data and no active lock
          if (ch && ch.bufferedAmount === 0 && !this._channelLocks.has(remove)) {
            // Wait for any in-flight drain before removing
            await this._pool.waitForDrain(remove);
            this._pool.removeChannel(remove);
            this._addLog(`↓ Scaled to ${currentDataCount - 1} channels`, 'info');
            logger.log(`[MultiFileTransferManager] Scaled DOWN to ${currentDataCount - 1} channels`);
          } else {
            logger.log(`[MultiFileTransferManager] Skipping scale-down: channel ${remove} still in use`);
          }
        }
      }
    }, this._channelScaleInterval || CHANNEL_SCALE_INTERVAL);
  }

  _stopAutoScaling() {
    if (this._scaleTimerId) {
      clearInterval(this._scaleTimerId);
      this._scaleTimerId = null;
    }
  }

  _warmupDataChannels() {
    // Start with enough channels to saturate the link immediately
    // instead of waiting for auto-scaling (which takes 9+ seconds)
    const targetDataChannels = this._profile.constrained ? 2 : 3;

    for (let i = 1; i <= targetDataChannels; i++) {
      if (!this._pool.getChannel(i)) {
        this._pool.addChannel(i);
      }
    }
  }

  // ─── Progress emission ────────────────────────────────────────────

  _emitProgress() {
    if (!this._onProgress || !this._queue) return;

    // Throttle to max 5 updates/second (200ms) — React re-renders per chunk kills mobile perf
    const now = Date.now();
    if (now - this._lastProgressEmit < 200) return;
    this._lastProgressEmit = now;

    const elapsed = (now - this._startTime) / 1000;
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

  /**
   * Wait for the receiver to accept and send receiver-ready.
   * Resolves when receiverReady() is called externally.
   */
  _waitForReceiverReady() {
    if (this._receiverReady) return Promise.resolve();
    return new Promise((resolve) => {
      this._receiverReadyResolve = resolve;
      // Timeout after 60 seconds to prevent hanging forever
      setTimeout(() => {
        if (!this._receiverReady) {
          logger.warn('[MultiFileTransferManager] Receiver-ready timeout after 60s');
          this._addLog('Receiver did not respond in time', 'warning');
          resolve();
        }
      }, 60_000);
    });
  }

  /**
   * Called externally when receiver-ready signal arrives.
   * Unblocks the start() flow to begin sending data.
   */
  receiverReady() {
    this._receiverReady = true;
    if (this._receiverReadyResolve) {
      this._receiverReadyResolve();
    }
  }

  /**
   * Resume multi-file transfer with per-file bitmaps.
   * Used when transferring the same set of files and receiver has partially completed.
   * 
   * @param {Array<{file: File, relativePath: string|null}>} files
   * @param {Map<number, string>} fileBitmaps - fileIndex → base64 bitmap of completed chunks
   */
  async resumeWithBitmaps(files, fileBitmaps = new Map()) {
    this._fileBitmaps = fileBitmaps;
    logger.log('[MultiFileTransferManager] Resuming with per-file bitmaps:', fileBitmaps.size, 'files');
    
    // Start normal transfer, but with bitmaps available for skip logic
    return this.start(files);
  }

  _waitIfPaused() {
    if (!this._isPaused) return Promise.resolve();
    return new Promise((resolve) => {
      this._pauseResolve = resolve;
    });
  }

  _formatBytes(bytes) {
    return formatBytes(bytes);
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

  // ─── Resume from saved manifest ──────────────────────────────────

  /**
   * Resume a multi-file transfer from a saved manifest.
   * Validates each file against the saved manifest and skips completed files.
   * For partially-sent files, creates ChunkingEngine with startFromChunk offset.
   * 
   * @param {Array<{file: File, relativePath: string|null}>} files - Re-selected files
   * @param {Array<Object>} savedManifest - Saved per-file manifest entries
   *   Each entry: { fileName, fileSize, totalChunks, status, chunkBitmap }
   * @returns {{ valid: boolean, errors: string[], resumePlan: Object[] }}
   */
  validateAndPlanResume(files, savedManifest) {
    const errors = [];
    const resumePlan = [];

    for (let i = 0; i < savedManifest.length; i++) {
      const saved = savedManifest[i];

      if (saved.status === 'completed') {
        resumePlan.push({ fileIndex: i, action: 'skip', reason: 'already completed' });
        continue;
      }

      // Find matching file in re-selected files
      const match = files.find(f => 
        f.file.name === saved.fileName && f.file.size === saved.fileSize
      );

      if (!match) {
        errors.push(`File "${saved.fileName}" (${saved.fileSize} bytes) not found in selection`);
        continue;
      }

      if (saved.status === 'sending' && saved.chunkBitmap) {
        // Partially sent — find first missing chunk
        const bitmap = deserializeBitmap(saved.chunkBitmap);
        const startFromChunk = getFirstMissingChunk(bitmap, saved.totalChunks);
        if (startFromChunk === -1) {
          resumePlan.push({ fileIndex: i, action: 'skip', reason: 'all chunks present' });
        } else {
          resumePlan.push({
            fileIndex: i,
            action: 'resume',
            file: match,
            startFromChunk,
            totalChunks: saved.totalChunks,
          });
        }
      } else {
        // Pending — send from beginning
        resumePlan.push({ fileIndex: i, action: 'send', file: match });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      resumePlan,
    };
  }

  /**
   * Start a resume transfer using a validated resume plan.
   * 
   * @param {Array<{file: File, relativePath: string|null}>} files - All files
   * @param {Object[]} resumePlan - From validateAndPlanResume
   */
  async startResume(files, resumePlan) {
    // Build a filtered file list excluding completed files
    const filesToSend = [];
    const startFromChunks = new Map();

    for (const plan of resumePlan) {
      if (plan.action === 'skip') continue;
      
      const fileEntry = plan.file || files[plan.fileIndex];
      if (!fileEntry) continue;
      
      filesToSend.push(fileEntry);
      if (plan.action === 'resume' && plan.startFromChunk > 0) {
        startFromChunks.set(filesToSend.length - 1, plan.startFromChunk);
      }
    }

    if (filesToSend.length === 0) {
      this._addLog('All files already transferred', 'success');
      if (this._onAllComplete) this._onAllComplete();
      return;
    }

    this._queue = new FileQueue(filesToSend);
    this._isPaused = false;
    this._isCancelled = false;
    this._startTime = Date.now();
    this._totalBytesSent = 0;
    this._startFromChunks = startFromChunks;

    this._queue.on('file-progress', () => {
      this._emitProgress();
    });

    // Send manifest with resume flag
    const manifest = this._queue.getManifest(this._chunkSize);
    this._sendJSON({
      type: MESSAGE_TYPE.MULTI_FILE_MANIFEST,
      ...manifest,
      chunkSize: this._chunkSize,
      mode: this._mode,
      isResume: true,
      perFileStartChunks: Object.fromEntries(startFromChunks),
    });

    this._addLog(`Resuming ${filesToSend.length} file(s)`, 'info');

    await this._waitForReceiverReady();
    if (this._isCancelled) return;

    this._bandwidthMonitor.start();
    this._startAutoScaling();

    try {
      if (this._mode === TRANSFER_MODE.SEQUENTIAL) {
        await this._runSequential();
      } else {
        await this._runParallel();
      }

      if (!this._isCancelled) {
        if (!this._isChannelDead && this._pool.openCount > 0) {
          this._sendJSON({ type: MESSAGE_TYPE.TRANSFER_COMPLETE });
        }
        this._addLog('Resume complete!', 'success');
        if (this._onAllComplete) this._onAllComplete();
      }
    } catch (err) {
      logger.error('[MultiFileTransferManager] Resume error:', err);
      this._addLog(`Resume failed: ${err.message}`, 'error');
      if (this._onError) this._onError(err);
    } finally {
      this._bandwidthMonitor.stop();
      this._stopAutoScaling();
    }
  }
}
