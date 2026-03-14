/**
 * Unit Tests for Validation Utilities
 *
 * Tests all pure validation functions in src/lib/validators.js
 */
import { describe, it, expect } from 'vitest';
import {
  validateFileMetadata,
  sanitizeFilename,
  isValidRoomId,
  isValidChunkId,
  isPositiveNumber,
  checkBrowserSupport,
} from '@/lib/validators';

// ─── validateFileMetadata ──────────────────────────────────────────

describe('validateFileMetadata', () => {
  it('should accept valid metadata', () => {
    const result = validateFileMetadata({ name: 'test.txt', size: 1024, type: 'text/plain' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept metadata without type (optional)', () => {
    const result = validateFileMetadata({ name: 'photo.png', size: 0 });
    expect(result.valid).toBe(true);
  });

  it('should reject null metadata', () => {
    const result = validateFileMetadata(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Metadata is required');
  });

  it('should reject undefined metadata', () => {
    const result = validateFileMetadata(undefined);
    expect(result.valid).toBe(false);
  });

  it('should reject missing name', () => {
    const result = validateFileMetadata({ size: 100 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid or missing file name');
  });

  it('should reject empty string name', () => {
    const result = validateFileMetadata({ name: '', size: 100 });
    expect(result.valid).toBe(false);
  });

  it('should reject non-string name', () => {
    const result = validateFileMetadata({ name: 123, size: 100 });
    expect(result.valid).toBe(false);
  });

  it('should reject missing size', () => {
    const result = validateFileMetadata({ name: 'file.txt' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid or missing file size');
  });

  it('should reject negative size', () => {
    const result = validateFileMetadata({ name: 'file.txt', size: -1 });
    expect(result.valid).toBe(false);
  });

  it('should reject string size', () => {
    const result = validateFileMetadata({ name: 'file.txt', size: '1024' });
    expect(result.valid).toBe(false);
  });

  it('should reject non-string type', () => {
    const result = validateFileMetadata({ name: 'file.txt', size: 100, type: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid file type');
  });

  it('should collect multiple errors', () => {
    const result = validateFileMetadata({ type: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('should accept zero-byte file', () => {
    const result = validateFileMetadata({ name: 'empty.txt', size: 0 });
    expect(result.valid).toBe(true);
  });

  it('should accept very large file size', () => {
    const result = validateFileMetadata({ name: 'big.bin', size: 10 * 1024 * 1024 * 1024 }); // 10GB
    expect(result.valid).toBe(true);
  });
});

// ─── sanitizeFilename ──────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('should return input for safe filenames', () => {
    expect(sanitizeFilename('hello.txt')).toBe('hello.txt');
  });

  it('should replace path separators', () => {
    expect(sanitizeFilename('path/to/file.txt')).toBe('path-to-file.txt');
    expect(sanitizeFilename('path\\to\\file.txt')).toBe('path-to-file.txt');
  });

  it('should replace dangerous characters', () => {
    expect(sanitizeFilename('file:name?.txt')).toBe('file-name-.txt');
    expect(sanitizeFilename('file<>|"*.txt')).toBe('file-----.txt');
  });

  it('should collapse multiple dots', () => {
    expect(sanitizeFilename('file...txt')).toBe('file.txt');
  });

  it('should remove leading dots', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('...file')).toBe('file');
  });

  it('should handle path traversal attacks', () => {
    const result = sanitizeFilename('../../../etc/passwd');
    expect(result).not.toContain('..');
    expect(result).not.toContain('/');
  });

  it('should return "untitled" for null/undefined/empty', () => {
    expect(sanitizeFilename(null)).toBe('untitled');
    expect(sanitizeFilename(undefined)).toBe('untitled');
    expect(sanitizeFilename('')).toBe('untitled');
  });

  it('should return "untitled" for all-dangerous-chars', () => {
    expect(sanitizeFilename('...')).toBe('untitled');
  });

  it('should trim whitespace', () => {
    expect(sanitizeFilename('  file.txt  ')).toBe('file.txt');
  });
});

// ─── isValidRoomId ─────────────────────────────────────────────────

describe('isValidRoomId', () => {
  it('should accept valid room IDs', () => {
    expect(isValidRoomId('abcd')).toBe(true);
    expect(isValidRoomId('ROOM1234')).toBe(true);
    expect(isValidRoomId('abc123def456')).toBe(true);
  });

  it('should accept IDs at boundary lengths', () => {
    expect(isValidRoomId('abcd')).toBe(true); // min 4
    expect(isValidRoomId('a'.repeat(32))).toBe(true); // max 32
  });

  it('should reject too-short IDs', () => {
    expect(isValidRoomId('abc')).toBe(false);
    expect(isValidRoomId('a')).toBe(false);
    expect(isValidRoomId('')).toBe(false);
  });

  it('should reject too-long IDs', () => {
    expect(isValidRoomId('a'.repeat(33))).toBe(false);
  });

  it('should reject null/undefined', () => {
    expect(isValidRoomId(null)).toBe(false);
    expect(isValidRoomId(undefined)).toBe(false);
  });

  it('should reject non-string types', () => {
    expect(isValidRoomId(12345)).toBe(false);
    expect(isValidRoomId({})).toBe(false);
  });

  it('should reject IDs with special characters', () => {
    expect(isValidRoomId('room-123')).toBe(false); // dash
    expect(isValidRoomId('room_123')).toBe(false); // underscore
    expect(isValidRoomId('room 123')).toBe(false); // space
    expect(isValidRoomId('room.123')).toBe(false); // dot
  });
});

// ─── isValidChunkId ────────────────────────────────────────────────

describe('isValidChunkId', () => {
  it('should accept valid chunk IDs', () => {
    expect(isValidChunkId(0, 10)).toBe(true);
    expect(isValidChunkId(5, 10)).toBe(true);
    expect(isValidChunkId(9, 10)).toBe(true);
  });

  it('should reject chunk ID equal to totalChunks', () => {
    expect(isValidChunkId(10, 10)).toBe(false);
  });

  it('should reject negative chunk IDs', () => {
    expect(isValidChunkId(-1, 10)).toBe(false);
  });

  it('should reject non-integer chunk IDs', () => {
    expect(isValidChunkId(1.5, 10)).toBe(false);
  });

  it('should reject non-number chunk IDs', () => {
    expect(isValidChunkId('5', 10)).toBe(false);
    expect(isValidChunkId(null, 10)).toBe(false);
  });

  it('should handle zero totalChunks', () => {
    expect(isValidChunkId(0, 0)).toBe(false);
  });

  it('should handle single chunk', () => {
    expect(isValidChunkId(0, 1)).toBe(true);
    expect(isValidChunkId(1, 1)).toBe(false);
  });
});

// ─── isPositiveNumber ──────────────────────────────────────────────

describe('isPositiveNumber', () => {
  it('should accept positive numbers', () => {
    expect(isPositiveNumber(1)).toBe(true);
    expect(isPositiveNumber(0.001)).toBe(true);
    expect(isPositiveNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should reject zero', () => {
    expect(isPositiveNumber(0)).toBe(false);
  });

  it('should reject negative numbers', () => {
    expect(isPositiveNumber(-1)).toBe(false);
    expect(isPositiveNumber(-0.001)).toBe(false);
  });

  it('should reject NaN', () => {
    expect(isPositiveNumber(NaN)).toBe(false);
  });

  it('should reject Infinity', () => {
    expect(isPositiveNumber(Infinity)).toBe(true); // Infinity IS a positive number
  });

  it('should reject non-number types', () => {
    expect(isPositiveNumber('5')).toBe(false);
    expect(isPositiveNumber(null)).toBe(false);
    expect(isPositiveNumber(undefined)).toBe(false);
    expect(isPositiveNumber(true)).toBe(false);
  });
});

// ─── checkBrowserSupport ───────────────────────────────────────────

describe('checkBrowserSupport', () => {
  it('should report all features supported in test env', () => {
    // Test env mocks RTCPeerConnection, indexedDB, and crypto
    const result = checkBrowserSupport();
    expect(result).toHaveProperty('supported');
    expect(result).toHaveProperty('missing');
    expect(Array.isArray(result.missing)).toBe(true);
  });

  it('should report supported as boolean', () => {
    const result = checkBrowserSupport();
    expect(typeof result.supported).toBe('boolean');
  });
});
