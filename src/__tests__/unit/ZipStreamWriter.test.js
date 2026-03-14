/**
 * Unit Tests for ZipStreamWriter
 *
 * Tests streaming ZIP archive creation in blob-fallback mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to suppress output
vi.mock('../../utils/logger.js', () => ({
  default: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ZipStreamWriter } from '@/transfer/multifile/ZipStreamWriter';

describe('ZipStreamWriter', () => {
  // ─── Construction ──────────────────────────────────────────────

  describe('constructor', () => {
    it('should create in blob mode when no writable provided', () => {
      const writer = new ZipStreamWriter();
      expect(writer.bytesWritten).toBe(0);
    });

    it('should create in blob mode with null writable', () => {
      const writer = new ZipStreamWriter(null);
      expect(writer.bytesWritten).toBe(0);
    });
  });

  // ─── Single file ───────────────────────────────────────────────

  describe('single file', () => {
    it('should produce a valid ZIP blob with one file', async () => {
      const writer = new ZipStreamWriter(null);
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

      writer.addFile('test.txt', data.length);
      writer.pushChunk(data);
      writer.endFile();

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/zip');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should track bytesWritten', async () => {
      const writer = new ZipStreamWriter(null);
      const data = new Uint8Array(1024);

      writer.addFile('data.bin', data.length);
      writer.pushChunk(data);
      writer.endFile();
      await writer.finish();

      expect(writer.bytesWritten).toBeGreaterThan(0);
    });
  });

  // ─── Multiple files ────────────────────────────────────────────

  describe('multiple files', () => {
    it('should handle multiple files in sequence', async () => {
      const writer = new ZipStreamWriter(null);

      // File 1
      const data1 = new Uint8Array([1, 2, 3]);
      writer.addFile('file1.bin', data1.length);
      writer.pushChunk(data1);
      writer.endFile();

      // File 2
      const data2 = new Uint8Array([4, 5, 6, 7]);
      writer.addFile('file2.bin', data2.length);
      writer.pushChunk(data2);
      writer.endFile();

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
      // ZIP overhead + 2 files should be larger than either alone
      expect(blob.size).toBeGreaterThan(data1.length + data2.length);
    });

    it('should handle files with directory paths', async () => {
      const writer = new ZipStreamWriter(null);
      const data = new Uint8Array([10, 20, 30]);

      writer.addFile('photos/vacation/sunset.jpg', data.length);
      writer.pushChunk(data);
      writer.endFile();

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
    });
  });

  // ─── Chunked files ─────────────────────────────────────────────

  describe('chunked file writing', () => {
    it('should handle a file written in multiple chunks', async () => {
      const writer = new ZipStreamWriter(null);
      const chunk1 = new Uint8Array([1, 2, 3, 4]);
      const chunk2 = new Uint8Array([5, 6, 7, 8]);
      const totalSize = chunk1.length + chunk2.length;

      writer.addFile('chunked.bin', totalSize);
      writer.pushChunk(chunk1);
      writer.pushChunk(chunk2);
      writer.endFile();

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should handle many small chunks', async () => {
      const writer = new ZipStreamWriter(null);
      const chunkCount = 100;
      const chunkSize = 64;
      const totalSize = chunkCount * chunkSize;

      writer.addFile('manyChunks.bin', totalSize);
      for (let i = 0; i < chunkCount; i++) {
        writer.pushChunk(new Uint8Array(chunkSize).fill(i % 256));
      }
      writer.endFile();

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
    });

    it('should accept ArrayBuffer as chunk data', async () => {
      const writer = new ZipStreamWriter(null);
      const buffer = new ArrayBuffer(16);
      new Uint8Array(buffer).fill(42);

      writer.addFile('buffer.bin', 16);
      writer.pushChunk(buffer);
      writer.endFile();

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should throw if pushChunk called without addFile', () => {
      const writer = new ZipStreamWriter(null);
      expect(() => writer.pushChunk(new Uint8Array([1]))).toThrow('No file started');
    });

    it('should handle endFile when no file is open', () => {
      const writer = new ZipStreamWriter(null);
      // Should not throw
      expect(() => writer.endFile()).not.toThrow();
    });

    it('should handle double finish', async () => {
      const writer = new ZipStreamWriter(null);
      writer.addFile('test.txt', 5);
      writer.pushChunk(new Uint8Array([1, 2, 3, 4, 5]));
      writer.endFile();

      const blob1 = await writer.finish();
      const blob2 = await writer.finish();
      expect(blob1).toBeInstanceOf(Blob);
      expect(blob2).toBeNull(); // second call returns null
    });
  });

  // ─── finish() auto-closing ─────────────────────────────────────

  describe('finish auto-closing', () => {
    it('should auto-close open file entry on finish', async () => {
      const writer = new ZipStreamWriter(null);
      writer.addFile('auto.txt', 3);
      writer.pushChunk(new Uint8Array([1, 2, 3]));
      // No explicit endFile()

      const blob = await writer.finish();
      expect(blob).toBeInstanceOf(Blob);
    });
  });

  // ─── FSAPI writable mode ──────────────────────────────────────

  describe('writable mode', () => {
    it('should write to writable and return null from finish', async () => {
      const chunks = [];
      const mockWritable = {
        write: vi.fn(async (data) => { chunks.push(data); }),
        close: vi.fn(async () => {}),
      };

      const writer = new ZipStreamWriter(mockWritable);
      writer.addFile('file.txt', 5);
      writer.pushChunk(new Uint8Array([1, 2, 3, 4, 5]));
      writer.endFile();

      const result = await writer.finish();
      expect(result).toBeNull(); // FSAPI mode returns null
      expect(mockWritable.write).toHaveBeenCalled();
      expect(mockWritable.close).toHaveBeenCalled();
    });
  });
});
