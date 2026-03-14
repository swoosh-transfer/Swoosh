/**
 * Unit Tests for Connection Monitor
 *
 * Tests health monitoring start/stop and getConnectionHealth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  default: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock timing constants
vi.mock('../../constants/timing.constants.js', () => ({
  CONNECTION_MONITOR_INTERVAL: 100,
}));

import {
  startHealthMonitoring,
  stopHealthMonitoring,
  getConnectionHealth,
} from '@/utils/connectionMonitor';

function createMockPC(statsEntries = [], state = 'connected') {
  return {
    connectionState: state,
    getStats: vi.fn().mockResolvedValue(
      new Map(statsEntries.map((e, i) => [String(i), e]))
    ),
  };
}

describe('connectionMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopHealthMonitoring();
    vi.useRealTimers();
  });

  // ─── getConnectionHealth ───────────────────────────────────────

  describe('getConnectionHealth', () => {
    it('should return default stats for null pc', async () => {
      const result = await getConnectionHealth(null);
      expect(result.rtt).toBe(0);
      expect(result.packetLoss).toBe('0');
      expect(result.connectionState).toBe('closed');
    });

    it('should extract RTT from candidate-pair', async () => {
      const pc = createMockPC([
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.05 },
      ]);
      const result = await getConnectionHealth(pc);
      expect(result.rtt).toBe(50); // 0.05s = 50ms
    });

    it('should extract packet loss from inbound-rtp', async () => {
      const pc = createMockPC([
        { type: 'inbound-rtp', packetsLost: 5, packetsReceived: 95 },
      ]);
      const result = await getConnectionHealth(pc);
      expect(parseFloat(result.packetLoss)).toBe(5.0);
    });

    it('should handle zero packets gracefully', async () => {
      const pc = createMockPC([
        { type: 'inbound-rtp', packetsLost: 0, packetsReceived: 0 },
      ]);
      const result = await getConnectionHealth(pc);
      expect(result.packetLoss).toBe('0');
    });

    it('should handle getStats error gracefully', async () => {
      const pc = {
        connectionState: 'connected',
        getStats: vi.fn().mockRejectedValue(new Error('stats fail')),
      };
      const result = await getConnectionHealth(pc);
      expect(result.rtt).toBe(0);
    });

    it('should include connectionState', async () => {
      const pc = createMockPC([], 'connected');
      const result = await getConnectionHealth(pc);
      expect(result.connectionState).toBe('connected');
    });
  });

  // ─── startHealthMonitoring ─────────────────────────────────────

  describe('startHealthMonitoring', () => {
    it('should call onStats periodically', async () => {
      const onStats = vi.fn();
      const pc = createMockPC([
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.03 },
      ]);

      startHealthMonitoring(pc, onStats);

      // Advance one interval
      await vi.advanceTimersByTimeAsync(100);
      expect(onStats).toHaveBeenCalledTimes(1);
      expect(onStats).toHaveBeenCalledWith(
        expect.objectContaining({ rtt: expect.any(Number) })
      );
    });

    it('should skip polling if connection is closed', async () => {
      const onStats = vi.fn();
      const pc = createMockPC([], 'closed');

      startHealthMonitoring(pc, onStats);
      await vi.advanceTimersByTimeAsync(100);
      expect(onStats).not.toHaveBeenCalled();
    });

    it('should skip polling if pc is null', async () => {
      const onStats = vi.fn();
      startHealthMonitoring(null, onStats);
      await vi.advanceTimersByTimeAsync(100);
      expect(onStats).not.toHaveBeenCalled();
    });
  });

  // ─── stopHealthMonitoring ──────────────────────────────────────

  describe('stopHealthMonitoring', () => {
    it('should stop polling after stopHealthMonitoring', async () => {
      const onStats = vi.fn();
      const pc = createMockPC([
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.02 },
      ]);

      startHealthMonitoring(pc, onStats);
      await vi.advanceTimersByTimeAsync(100);
      expect(onStats).toHaveBeenCalledTimes(1);

      stopHealthMonitoring();
      await vi.advanceTimersByTimeAsync(300);
      expect(onStats).toHaveBeenCalledTimes(1); // no additional calls
    });

    it('should be safe to call multiple times', () => {
      expect(() => {
        stopHealthMonitoring();
        stopHealthMonitoring();
      }).not.toThrow();
    });
  });
});
