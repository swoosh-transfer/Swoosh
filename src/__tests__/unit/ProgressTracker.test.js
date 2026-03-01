/**
 * Unit Tests for ProgressTracker
 * 
 * Tests the core progress tracking logic in isolation.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProgressTracker } from '@/transfer/shared/ProgressTracker';

describe('ProgressTracker', () => {
  let tracker;
  let progressCallback;

  beforeEach(() => {
    tracker = new ProgressTracker();
    progressCallback = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialize()', () => {
    it('should initialize transfer with correct state', () => {
      const transferId = 'test-transfer-1';
      const options = {
        totalChunks: 100,
        fileSize: 1024 * 1024, // 1 MB
        fileName: 'test.txt',
        direction: 'send',
      };

      const state = tracker.initialize(transferId, options);

      expect(state).toMatchObject({
        transferId,
        fileName: 'test.txt',
        fileSize: 1024 * 1024,
        totalChunks: 100,
        direction: 'send',
        chunksCompleted: 0,
        bytesTransferred: 0,
        status: 'active',
      });

      expect(state.startTime).toBeDefined();
      expect(state.lastUpdateTime).toBeDefined();
    });

    it('should notify listeners on initialization', () => {
      const transferId = 'test-transfer-2';
      
      tracker.subscribe(transferId, progressCallback);
      
      tracker.initialize(transferId, {
        totalChunks: 50,
        fileSize: 512 * 1024,
        fileName: 'file.dat',
      });

      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId,
          fileName: 'file.dat',
          chunksCompleted: 0,
        })
      );
    });

    it('should default direction to "send"', () => {
      const state = tracker.initialize('test-id', {
        totalChunks: 10,
        fileSize: 1024,
        fileName: 'file.txt',
      });

      expect(state.direction).toBe('send');
    });
  });

  describe('updateChunk()', () => {
    beforeEach(() => {
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240, // 10 KB
        fileName: 'test.txt',
      });
    });

    it('should update progress correctly', () => {
      const progress = tracker.updateChunk('transfer-1', 0, 1024);

      expect(progress).toMatchObject({
        chunksCompleted: 1,
        bytesTransferred: 1024,
        totalChunks: 10,
        fileSize: 10240,
      });
    });

    it('should calculate percentage correctly', () => {
      // Complete 5 out of 10 chunks
      for (let i = 0; i < 5; i++) {
        tracker.updateChunk('transfer-1', i, 1024);
      }

      const progress = tracker.getProgress('transfer-1');
      expect(progress.percentage).toBe(50);
    });

    it('should calculate transfer speed', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Upload 5 KB
      tracker.updateChunk('transfer-1', 0, 5120);

      // Advance time by 1 second
      vi.setSystemTime(now + 1000);

      tracker.updateChunk('transfer-1', 1, 1024);

      const progress = tracker.getProgress('transfer-1');
      
      // Speed should be around 5-6 KB/s
      expect(progress.transferSpeed).toBeGreaterThan(5000);
    });

    it('should estimate time remaining', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Complete first chunk
      tracker.updateChunk('transfer-1', 0, 1024);

      // Advance time by 100ms
      vi.setSystemTime(now + 100);

      tracker.updateChunk('transfer-1', 1, 1024);

      const progress = tracker.getProgress('transfer-1');
      
      // Should have ETA for remaining 8 chunks
      expect(progress.estimatedTimeRemaining).toBeGreaterThan(0);
    });

    it('should handle non-existent transfer gracefully', () => {
      const progress = tracker.updateChunk('non-existent', 0, 1024);
      expect(progress).toBeNull();
    });

    it('should throttle listener notifications', () => {
      tracker.subscribe('transfer-1', progressCallback);
      progressCallback.mockClear();

      const now = Date.now();
      // Start 100ms after initialization so first update fires
      vi.setSystemTime(now + 100);

      // First update fires (>= 100ms since init's lastUpdateTime)
      tracker.updateChunk('transfer-1', 0, 1024);

      // Next 4 updates at 10ms intervals — all within 100ms throttle window
      for (let i = 1; i < 5; i++) {
        vi.setSystemTime(now + 100 + i * 10);
        tracker.updateChunk('transfer-1', i, 1024);
      }

      // Should only notify once (first update); the rest are throttled
      expect(progressCallback).toHaveBeenCalledTimes(1);
    });

    it('should always notify on completion', () => {
      tracker.subscribe('transfer-1', progressCallback);
      progressCallback.mockClear();

      // Complete all 10 chunks rapidly
      for (let i = 0; i < 10; i++) {
        tracker.updateChunk('transfer-1', i, 1024);
      }

      // Should notify on last chunk even if within throttle window
      expect(progressCallback).toHaveBeenCalled();
      
      const lastCall = progressCallback.mock.calls[progressCallback.mock.calls.length - 1][0];
      expect(lastCall.chunksCompleted).toBe(10);
    });
  });

  describe('batchUpdate()', () => {
    beforeEach(() => {
      tracker.initialize('transfer-1', {
        totalChunks: 100,
        fileSize: 102400, // 100 KB
        fileName: 'test.txt',
      });
    });

    it('should update multiple chunks at once', () => {
      tracker.updateBatch('transfer-1', 10, 10240);

      const progress = tracker.getProgress('transfer-1');
      expect(progress.chunksCompleted).toBe(10);
      expect(progress.bytesTransferred).toBe(10240);
    });

    it('should be more efficient than individual updates', () => {
      tracker.subscribe('transfer-1', progressCallback);
      progressCallback.mockClear();

      // Batch update should trigger only one notification
      tracker.updateBatch('transfer-1', 50, 51200);

      expect(progressCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('pause() and resume()', () => {
    beforeEach(() => {
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });
    });

    it('should pause transfer', () => {
      tracker.updateStatus('transfer-1', 'paused');

      const progress = tracker.getProgress('transfer-1');
      expect(progress.status).toBe('paused');
    });

    it('should resume transfer', () => {
      tracker.updateStatus('transfer-1', 'paused');
      tracker.updateStatus('transfer-1', 'active');

      const progress = tracker.getProgress('transfer-1');
      expect(progress.status).toBe('active');
    });

    it('should reset speed calculation on resume', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      tracker.updateChunk('transfer-1', 0, 1024);
      
      vi.setSystemTime(now + 1000);
      tracker.updateStatus('transfer-1', 'paused');

      // Advance time while paused (shouldn't affect speed)
      vi.setSystemTime(now + 10000);
      tracker.updateStatus('transfer-1', 'active');

      // Speed should be recalculated from resume point
      const progress = tracker.getProgress('transfer-1');
      expect(progress.transferSpeed).toBeDefined();
    });
  });

  describe('complete()', () => {
    beforeEach(() => {
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });
    });

    it('should mark transfer as completed', () => {
      tracker.updateStatus('transfer-1', 'completed');

      const progress = tracker.getProgress('transfer-1');
      expect(progress.status).toBe('completed');
    });

    it('should notify listeners', () => {
      tracker.subscribe('transfer-1', progressCallback);
      progressCallback.mockClear();

      tracker.updateStatus('transfer-1', 'completed');

      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
        })
      );
    });
  });

  describe('fail()', () => {
    beforeEach(() => {
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });
    });

    it('should mark transfer as failed', () => {
      tracker.updateStatus('transfer-1', 'failed');

      const progress = tracker.getProgress('transfer-1');
      expect(progress.status).toBe('failed');
    });
  });

  describe('subscribe() and unsubscribe()', () => {
    it('should allow subscribing to progress updates', () => {
      const callback = vi.fn();
      
      tracker.subscribe('transfer-1', callback);
      
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });

      expect(callback).toHaveBeenCalled();
    });

    it('should allow multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      tracker.subscribe('transfer-1', callback1);
      tracker.subscribe('transfer-1', callback2);

      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should allow unsubscribing', () => {
      const callback = vi.fn();

      const unsub = tracker.subscribe('transfer-1', callback);
      unsub(); // subscribe returns an unsubscribe function

      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle unsubscribing non-existent listener', () => {
      const callback = vi.fn();

      // Calling the unsub function for a non-existent transfer should not throw
      const unsub = tracker.subscribe('non-existent', callback);
      expect(() => {
        unsub();
      }).not.toThrow();
    });
  });

  describe('getProgress()', () => {
    it('should return current progress state', () => {
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });

      tracker.updateChunk('transfer-1', 0, 1024);
      tracker.updateChunk('transfer-1', 1, 1024);

      const progress = tracker.getProgress('transfer-1');

      expect(progress).toMatchObject({
        transferId: 'transfer-1',
        fileName: 'test.txt',
        chunksCompleted: 2,
        bytesTransferred: 2048,
        totalChunks: 10,
        fileSize: 10240,
        percentage: 20,
      });
    });

    it('should return null for non-existent transfer', () => {
      const progress = tracker.getProgress('non-existent');
      expect(progress).toBeNull();
    });
  });

  describe('cleanup()', () => {
    it('should remove transfer state', () => {
      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });

      tracker.clear('transfer-1');

      expect(tracker.getProgress('transfer-1')).toBeNull();
    });

    it('should remove listeners', () => {
      const callback = vi.fn();
      
      tracker.subscribe('transfer-1', callback);
      tracker.clear('transfer-1');

      tracker.initialize('transfer-1', {
        totalChunks: 10,
        fileSize: 10240,
        fileName: 'test.txt',
      });

      // Callback should not be called for new transfer with same ID
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
