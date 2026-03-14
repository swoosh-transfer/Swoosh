/**
 * ZipStreamWriter — Streams multiple files into a single .zip archive.
 *
 * Uses `fflate` for fast, synchronous deflate compression and builds the
 * ZIP archive incrementally so that memory usage stays bounded to one
 * chunk at a time.
 *
 * Two output modes:
 *   1. File System API writable (preferred — writes directly to disk)
 *   2. In-memory Blob accumulation (fallback — triggers download at end)
 */
import { ZipPassThrough, Zip } from 'fflate';
import logger from '../../utils/logger.js';

export class ZipStreamWriter {
  /**
   * @param {FileSystemWritableFileStream|null} writable — FSAPI writable, or null for blob mode
   */
  constructor(writable = null) {
    this._writable = writable;
    this._blobParts = [];
    this._bytesWritten = 0;
    this._finished = false;

    // fflate streaming zip
    this._zip = new Zip((err, data, final) => {
      if (err) {
        logger.error('[ZipStreamWriter] fflate error:', err);
        return;
      }
      this._pushData(data, final);
    });
  }

  /**
   * Internal — push compressed data to the writable or blob buffer.
   */
  _pushData(data, _final) {
    if (!data || data.length === 0) return;
    this._bytesWritten += data.length;

    if (this._writable) {
      // Write to File System API writable (async, but fflate callback is sync)
      // Queue writes so they don't overlap
      this._writePromise = (this._writePromise || Promise.resolve())
        .then(() => this._writable.write(data))
        .catch(err => logger.error('[ZipStreamWriter] writable.write error:', err));
    } else {
      this._blobParts.push(new Uint8Array(data));
    }
  }

  /**
   * Begin a new file entry in the archive.
   * Must be called before pushChunk for each file.
   *
   * @param {string} name — path inside the ZIP (e.g. "photos/cat.jpg")
   * @param {number} size — uncompressed file size in bytes
   * @returns {ZipPassThrough} internal file handle
   */
  addFile(name, size) {
    // ZipPassThrough = store without compression (data is already binary, compression
    // adds CPU cost with little benefit for images/videos/compressed files that dominate
    // P2P transfers). For text-heavy transfers a ZipDeflate would be better, but
    // store-mode keeps the hot path fast and streaming-friendly.
    const entry = new ZipPassThrough(name);
    this._zip.add(entry);
    this._currentEntry = entry;
    this._currentBytesLeft = size;
    return entry;
  }

  /**
   * Push a chunk of data for the current file.
   * Chunks MUST arrive in order for the current file.
   *
   * @param {Uint8Array|ArrayBuffer} data
   */
  pushChunk(data) {
    if (!this._currentEntry) {
      throw new Error('No file started — call addFile first');
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._currentBytesLeft -= bytes.length;
    // final=true when this is the last chunk for this file entry
    this._currentEntry.push(bytes, this._currentBytesLeft <= 0);
  }

  /**
   * Finalize the current file entry (if not already done by pushChunk).
   */
  endFile() {
    if (this._currentEntry && this._currentBytesLeft > 0) {
      // Force-close the entry with an empty final push
      this._currentEntry.push(new Uint8Array(0), true);
    }
    this._currentEntry = null;
    this._currentBytesLeft = 0;
  }

  /**
   * Finalize the ZIP archive and close the writable.
   * @returns {Promise<Blob|null>} Blob in fallback mode, null in FSAPI mode
   */
  async finish() {
    if (this._finished) return null;
    this._finished = true;

    // End the current file if still open
    if (this._currentEntry) {
      this.endFile();
    }

    // Finalize the ZIP central directory
    this._zip.end();

    // Wait for all queued writes to flush
    if (this._writePromise) {
      await this._writePromise;
    }

    if (this._writable) {
      try {
        await this._writable.close();
      } catch (err) {
        logger.warn('[ZipStreamWriter] writable.close error:', err);
      }
      return null;
    }

    // Blob fallback
    return new Blob(this._blobParts, { type: 'application/zip' });
  }

  /** Total compressed bytes written so far */
  get bytesWritten() {
    return this._bytesWritten;
  }
}
