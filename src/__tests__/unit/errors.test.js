/**
 * Unit Tests for Custom Error Classes
 *
 * Tests error class hierarchy, serialization, and utility functions.
 */
import { describe, it, expect } from 'vitest';
import {
  AppError,
  TransferError,
  ConnectionError,
  SecurityError,
  StorageError,
  ValidationError,
  TimeoutError,
  isErrorType,
  getErrorMessage,
} from '@/lib/errors';

// ─── Error Class Hierarchy ─────────────────────────────────────────

describe('AppError', () => {
  it('should create with message and default context', () => {
    const err = new AppError('test error');
    expect(err.message).toBe('test error');
    expect(err.context).toEqual({});
    expect(err.name).toBe('AppError');
  });

  it('should store context', () => {
    const ctx = { transferId: 'abc', chunkId: 5 };
    const err = new AppError('test', ctx);
    expect(err.context).toEqual(ctx);
  });

  it('should have timestamp', () => {
    const before = Date.now();
    const err = new AppError('test');
    expect(err.timestamp).toBeGreaterThanOrEqual(before);
    expect(err.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('should be instanceof Error', () => {
    const err = new AppError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('should have stack trace', () => {
    const err = new AppError('test');
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });

  it('should serialize to JSON', () => {
    const err = new AppError('test', { key: 'val' });
    const json = err.toJSON();
    expect(json.name).toBe('AppError');
    expect(json.message).toBe('test');
    expect(json.context).toEqual({ key: 'val' });
    expect(json.timestamp).toBeDefined();
    expect(json.stack).toBeDefined();
  });
});

describe('Error Subclasses', () => {
  const subclasses = [
    { Class: TransferError, name: 'TransferError' },
    { Class: ConnectionError, name: 'ConnectionError' },
    { Class: SecurityError, name: 'SecurityError' },
    { Class: StorageError, name: 'StorageError' },
    { Class: ValidationError, name: 'ValidationError' },
    { Class: TimeoutError, name: 'TimeoutError' },
  ];

  subclasses.forEach(({ Class, name }) => {
    describe(name, () => {
      it('should have correct name', () => {
        const err = new Class('test');
        expect(err.name).toBe(name);
      });

      it('should extend AppError', () => {
        const err = new Class('test');
        expect(err).toBeInstanceOf(AppError);
        expect(err).toBeInstanceOf(Error);
      });

      it('should store message and context', () => {
        const err = new Class('msg', { foo: 'bar' });
        expect(err.message).toBe('msg');
        expect(err.context).toEqual({ foo: 'bar' });
      });

      it('should serialize to JSON with correct name', () => {
        const json = new Class('test').toJSON();
        expect(json.name).toBe(name);
      });
    });
  });
});

// ─── isErrorType ───────────────────────────────────────────────────

describe('isErrorType', () => {
  it('should identify correct error type', () => {
    expect(isErrorType(new TransferError('test'), TransferError)).toBe(true);
    expect(isErrorType(new ConnectionError('test'), ConnectionError)).toBe(true);
  });

  it('should match parent class', () => {
    expect(isErrorType(new TransferError('test'), AppError)).toBe(true);
    expect(isErrorType(new TransferError('test'), Error)).toBe(true);
  });

  it('should not match sibling classes', () => {
    expect(isErrorType(new TransferError('test'), ConnectionError)).toBe(false);
    expect(isErrorType(new SecurityError('test'), StorageError)).toBe(false);
  });

  it('should handle plain Error', () => {
    expect(isErrorType(new Error('test'), AppError)).toBe(false);
    expect(isErrorType(new Error('test'), Error)).toBe(true);
  });
});

// ─── getErrorMessage ───────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('should extract message from Error', () => {
    expect(getErrorMessage(new Error('hello'))).toBe('hello');
  });

  it('should extract message from AppError', () => {
    expect(getErrorMessage(new TransferError('chunk fail'))).toBe('chunk fail');
  });

  it('should return string errors directly', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('should extract message from plain object', () => {
    expect(getErrorMessage({ message: 'obj error' })).toBe('obj error');
  });

  it('should handle null/undefined', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
    expect(getErrorMessage(undefined)).toBe('Unknown error');
    expect(getErrorMessage(0)).toBe('Unknown error');
    expect(getErrorMessage(false)).toBe('Unknown error');
  });

  it('should stringify other types', () => {
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(true)).toBe('true');
  });
});
