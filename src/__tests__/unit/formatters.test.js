/**
 * Unit Tests for Formatting Utilities
 * 
 * Tests pure formatting functions.
 */

import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration, formatSpeed } from '@/lib/formatters';

describe('formatBytes', () => {
  it('should format zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });

  it('should format bytes correctly', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('should format kilobytes correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('should format megabytes correctly', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
    expect(formatBytes(1024 * 1024 * 100)).toBe('100 MB');
  });

  it('should format gigabytes correctly', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
  });

  it('should format terabytes correctly', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });

  it('should handle decimal precision', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1.234)).toBe('1.23 KB');
    expect(formatBytes(1024 * 1024 * 1.999)).toBe('2 MB');
  });
});

describe('formatDuration', () => {
  it('should format zero duration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(null)).toBe('0s');
    expect(formatDuration(undefined)).toBe('0s');
  });

  it('should format seconds', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(45000)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('should format hours and minutes', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(3661000)).toBe('1h 1m');
    expect(formatDuration(5400000)).toBe('1h 30m');
  });

  it('should not show seconds when hours are present', () => {
    expect(formatDuration(3661000)).toBe('1h 1m');
    expect(formatDuration(3665000)).toBe('1h 1m'); // Ignores 5 seconds
  });

  it('should handle large durations', () => {
    expect(formatDuration(86400000)).toBe('24h 0m'); // 24 hours
    expect(formatDuration(90000000)).toBe('25h 0m'); // 25 hours
  });
});

describe('formatSpeed', () => {
  it('should format zero speed', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(null)).toBe('0 B/s');
    expect(formatSpeed(undefined)).toBe('0 B/s');
  });

  it('should format bytes per second', () => {
    expect(formatSpeed(100)).toBe('100 B/s');
    expect(formatSpeed(999)).toBe('999 B/s');
  });

  it('should format KB/s', () => {
    expect(formatSpeed(1024)).toBe('1 KB/s');
    expect(formatSpeed(1536)).toBe('1.5 KB/s');
    expect(formatSpeed(102400)).toBe('100 KB/s');
  });

  it('should format MB/s', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1 MB/s');
    expect(formatSpeed(1024 * 1024 * 5)).toBe('5 MB/s');
    expect(formatSpeed(1024 * 1024 * 10.5)).toBe('10.5 MB/s');
  });

  it('should format GB/s', () => {
    expect(formatSpeed(1024 * 1024 * 1024)).toBe('1 GB/s');
    expect(formatSpeed(1024 * 1024 * 1024 * 2)).toBe('2 GB/s');
  });
});
