/**
 * Unit Tests for Chunk Bitmap
 *
 * Tests pure bitmap functions: create, mark, serialize/deserialize roundtrip,
 * getMissingChunks, edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  createBitmap,
  markChunk,
  isChunkComplete,
  getCompletedCount,
  getMissingChunks,
  getFirstMissingChunk,
  serializeBitmap,
  deserializeBitmap,
  markAllComplete,
} from '@/infrastructure/database/chunkBitmap';

describe('createBitmap', () => {
  it('should create a zeroed bitmap for 0 chunks', () => {
    const bm = createBitmap(0);
    expect(bm).toBeInstanceOf(Uint8Array);
    expect(bm.length).toBe(0);
  });

  it('should create a single-byte bitmap for 1 chunk', () => {
    const bm = createBitmap(1);
    expect(bm.length).toBe(1);
    expect(bm[0]).toBe(0);
  });

  it('should create a single-byte bitmap for exactly 8 chunks', () => {
    const bm = createBitmap(8);
    expect(bm.length).toBe(1);
  });

  it('should create 2 bytes for 9 chunks', () => {
    const bm = createBitmap(9);
    expect(bm.length).toBe(2);
  });

  it('should handle large chunk counts', () => {
    const bm = createBitmap(781250); // ~50GB file at 64KB chunks
    expect(bm.length).toBe(Math.ceil(781250 / 8));
  });

  it('should throw for negative totalChunks', () => {
    expect(() => createBitmap(-1)).toThrow();
  });

  it('should throw for NaN', () => {
    expect(() => createBitmap(NaN)).toThrow();
  });

  it('should throw for Infinity', () => {
    expect(() => createBitmap(Infinity)).toThrow();
  });
});

describe('markChunk / isChunkComplete', () => {
  it('should mark individual chunks as complete', () => {
    const bm = createBitmap(16);
    expect(isChunkComplete(bm, 0)).toBe(false);
    markChunk(bm, 0);
    expect(isChunkComplete(bm, 0)).toBe(true);
    expect(isChunkComplete(bm, 1)).toBe(false);
  });

  it('should mark multiple chunks across bytes', () => {
    const bm = createBitmap(16);
    markChunk(bm, 7); // last bit of byte 0
    markChunk(bm, 8); // first bit of byte 1
    expect(isChunkComplete(bm, 7)).toBe(true);
    expect(isChunkComplete(bm, 8)).toBe(true);
    expect(isChunkComplete(bm, 6)).toBe(false);
    expect(isChunkComplete(bm, 9)).toBe(false);
  });

  it('should be idempotent when marking same chunk twice', () => {
    const bm = createBitmap(8);
    markChunk(bm, 3);
    markChunk(bm, 3);
    expect(isChunkComplete(bm, 3)).toBe(true);
    expect(getCompletedCount(bm)).toBe(1);
  });
});

describe('getCompletedCount', () => {
  it('should return 0 for empty bitmap', () => {
    expect(getCompletedCount(createBitmap(0))).toBe(0);
  });

  it('should return 0 for fresh bitmap', () => {
    expect(getCompletedCount(createBitmap(32))).toBe(0);
  });

  it('should count marked chunks correctly', () => {
    const bm = createBitmap(32);
    markChunk(bm, 0);
    markChunk(bm, 15);
    markChunk(bm, 31);
    expect(getCompletedCount(bm)).toBe(3);
  });

  it('should count all chunks when all marked', () => {
    const bm = createBitmap(16);
    markAllComplete(bm, 16);
    expect(getCompletedCount(bm)).toBe(16);
  });
});

describe('getMissingChunks', () => {
  it('should return all indices for fresh bitmap', () => {
    const bm = createBitmap(4);
    expect(getMissingChunks(bm, 4)).toEqual([0, 1, 2, 3]);
  });

  it('should return empty array when all complete', () => {
    const bm = createBitmap(4);
    markAllComplete(bm, 4);
    expect(getMissingChunks(bm, 4)).toEqual([]);
  });

  it('should return only missing indices', () => {
    const bm = createBitmap(5);
    markChunk(bm, 0);
    markChunk(bm, 2);
    markChunk(bm, 4);
    expect(getMissingChunks(bm, 5)).toEqual([1, 3]);
  });

  it('should work with various patterns across byte boundaries', () => {
    const bm = createBitmap(12);
    // Mark alternating: 0, 2, 4, 6, 8, 10
    for (let i = 0; i < 12; i += 2) markChunk(bm, i);
    expect(getMissingChunks(bm, 12)).toEqual([1, 3, 5, 7, 9, 11]);
  });
});

describe('getFirstMissingChunk', () => {
  it('should return 0 for fresh bitmap', () => {
    const bm = createBitmap(8);
    expect(getFirstMissingChunk(bm, 8)).toBe(0);
  });

  it('should return -1 when all chunks complete', () => {
    const bm = createBitmap(8);
    markAllComplete(bm, 8);
    expect(getFirstMissingChunk(bm, 8)).toBe(-1);
  });

  it('should find first gap', () => {
    const bm = createBitmap(8);
    markChunk(bm, 0);
    markChunk(bm, 1);
    markChunk(bm, 2);
    expect(getFirstMissingChunk(bm, 8)).toBe(3);
  });

  it('should return -1 for 0 total chunks', () => {
    const bm = createBitmap(0);
    expect(getFirstMissingChunk(bm, 0)).toBe(-1);
  });
});

describe('serializeBitmap / deserializeBitmap roundtrip', () => {
  it('should roundtrip an empty bitmap', () => {
    const bm = createBitmap(0);
    const serialized = serializeBitmap(bm);
    const deserialized = deserializeBitmap(serialized);
    expect(deserialized).toEqual(bm);
  });

  it('should roundtrip a fresh bitmap', () => {
    const bm = createBitmap(16);
    const deserialized = deserializeBitmap(serializeBitmap(bm));
    expect(deserialized).toEqual(bm);
  });

  it('should roundtrip a partially filled bitmap', () => {
    const bm = createBitmap(24);
    markChunk(bm, 3);
    markChunk(bm, 7);
    markChunk(bm, 15);
    markChunk(bm, 23);

    const deserialized = deserializeBitmap(serializeBitmap(bm));
    expect(deserialized).toEqual(bm);
    expect(isChunkComplete(deserialized, 3)).toBe(true);
    expect(isChunkComplete(deserialized, 7)).toBe(true);
    expect(isChunkComplete(deserialized, 15)).toBe(true);
    expect(isChunkComplete(deserialized, 23)).toBe(true);
    expect(isChunkComplete(deserialized, 0)).toBe(false);
  });

  it('should roundtrip a fully complete bitmap', () => {
    const bm = createBitmap(20);
    markAllComplete(bm, 20);
    const deserialized = deserializeBitmap(serializeBitmap(bm));
    expect(getCompletedCount(deserialized)).toBe(20);
  });

  it('should roundtrip large bitmaps', () => {
    const totalChunks = 10000;
    const bm = createBitmap(totalChunks);
    // Mark every 3rd chunk
    for (let i = 0; i < totalChunks; i += 3) markChunk(bm, i);

    const deserialized = deserializeBitmap(serializeBitmap(bm));
    expect(deserialized).toEqual(bm);
    expect(getCompletedCount(deserialized)).toBe(Math.ceil(totalChunks / 3));
  });
});

describe('markAllComplete', () => {
  it('should mark all chunks for exactly 8 chunks', () => {
    const bm = createBitmap(8);
    markAllComplete(bm, 8);
    expect(bm[0]).toBe(0xFF);
    expect(getCompletedCount(bm)).toBe(8);
    expect(getMissingChunks(bm, 8)).toEqual([]);
  });

  it('should handle non-byte-aligned chunk counts', () => {
    const bm = createBitmap(5);
    markAllComplete(bm, 5);
    expect(getCompletedCount(bm)).toBe(5);
    // Only lower 5 bits should be set
    expect(bm[0]).toBe(0b00011111);
  });

  it('should work for 1 chunk', () => {
    const bm = createBitmap(1);
    markAllComplete(bm, 1);
    expect(isChunkComplete(bm, 0)).toBe(true);
    expect(getCompletedCount(bm)).toBe(1);
  });

  it('should handle 16 chunks (2 full bytes)', () => {
    const bm = createBitmap(16);
    markAllComplete(bm, 16);
    expect(bm[0]).toBe(0xFF);
    expect(bm[1]).toBe(0xFF);
    expect(getCompletedCount(bm)).toBe(16);
  });

  it('should handle 0 chunks', () => {
    const bm = createBitmap(0);
    markAllComplete(bm, 0);
    expect(getCompletedCount(bm)).toBe(0);
  });
});
