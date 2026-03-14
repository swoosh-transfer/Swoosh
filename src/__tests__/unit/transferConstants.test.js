/**
 * Unit Tests for Transfer Constants
 *
 * Tests config negotiation, transfer modes, states, and mobile detection.
 */
import { describe, it, expect } from 'vitest';
import {
  negotiateTransferConfig,
  TRANSFER_MODE,
  TRANSFER_STATE,
  NETWORK_CHUNK_SIZE,
  STORAGE_CHUNK_SIZE,
  INITIAL_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHANNELS,
  MIN_CHANNELS,
  INITIAL_CHANNELS,
  CHANNEL_LABEL_PREFIX,
} from '@/constants/transfer.constants';

// ─── negotiateTransferConfig ───────────────────────────────────────

describe('negotiateTransferConfig', () => {
  it('should use minimum chunk size from both peers', () => {
    const local = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    const remote = { chunkSize: 16384, maxChannels: 4, bufferWatermark: 131072, constrained: true };
    const result = negotiateTransferConfig(local, remote);
    expect(result.chunkSize).toBe(16384);
  });

  it('should use minimum maxChannels', () => {
    const local = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    const remote = { chunkSize: 65536, maxChannels: 4, bufferWatermark: 262144, constrained: false };
    const result = negotiateTransferConfig(local, remote);
    expect(result.maxChannels).toBe(4);
  });

  it('should use minimum bufferWatermark', () => {
    const local = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    const remote = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 131072, constrained: false };
    const result = negotiateTransferConfig(local, remote);
    expect(result.bufferWatermark).toBe(131072);
  });

  it('should be constrained if either peer is constrained', () => {
    const local = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    const remote = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: true };
    expect(negotiateTransferConfig(local, remote).constrained).toBe(true);
  });

  it('should not be constrained if neither peer is constrained', () => {
    const local = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    const remote = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    expect(negotiateTransferConfig(local, remote).constrained).toBe(false);
  });

  it('should be symmetric (order should not matter)', () => {
    const a = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    const b = { chunkSize: 32768, maxChannels: 4, bufferWatermark: 131072, constrained: true };
    expect(negotiateTransferConfig(a, b)).toEqual(negotiateTransferConfig(b, a));
  });

  it('should return identical config when both peers match', () => {
    const config = { chunkSize: 65536, maxChannels: 8, bufferWatermark: 262144, constrained: false };
    expect(negotiateTransferConfig(config, config)).toEqual(config);
  });
});

// ─── Constants sanity checks ───────────────────────────────────────

describe('Transfer Constants', () => {
  it('should have valid chunk size hierarchy', () => {
    expect(MIN_CHUNK_SIZE).toBeLessThanOrEqual(INITIAL_CHUNK_SIZE);
    expect(INITIAL_CHUNK_SIZE).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
  });

  it('should have valid channel range', () => {
    expect(MIN_CHANNELS).toBe(1);
    expect(INITIAL_CHANNELS).toBe(1);
    expect(MAX_CHANNELS).toBeGreaterThanOrEqual(MIN_CHANNELS);
  });

  it('should have power-of-2 chunk sizes', () => {
    const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
    expect(isPow2(MIN_CHUNK_SIZE)).toBe(true);
    expect(isPow2(INITIAL_CHUNK_SIZE)).toBe(true);
    expect(isPow2(MAX_CHUNK_SIZE)).toBe(true);
  });

  it('should have reasonable NETWORK_CHUNK_SIZE', () => {
    expect(NETWORK_CHUNK_SIZE).toBeGreaterThanOrEqual(16 * 1024);
    expect(NETWORK_CHUNK_SIZE).toBeLessThanOrEqual(256 * 1024);
  });

  it('should have reasonable STORAGE_CHUNK_SIZE', () => {
    expect(STORAGE_CHUNK_SIZE).toBeGreaterThanOrEqual(16 * 1024);
    expect(STORAGE_CHUNK_SIZE).toBeLessThanOrEqual(256 * 1024);
  });

  it('should have a channel label prefix', () => {
    expect(typeof CHANNEL_LABEL_PREFIX).toBe('string');
    expect(CHANNEL_LABEL_PREFIX.length).toBeGreaterThan(0);
  });
});

// ─── TRANSFER_MODE ─────────────────────────────────────────────────

describe('TRANSFER_MODE', () => {
  it('should have SEQUENTIAL mode', () => {
    expect(TRANSFER_MODE.SEQUENTIAL).toBe('sequential');
  });

  it('should have PARALLEL mode', () => {
    expect(TRANSFER_MODE.PARALLEL).toBe('parallel');
  });

  it('should only have two modes', () => {
    expect(Object.keys(TRANSFER_MODE)).toHaveLength(2);
  });
});

// ─── TRANSFER_STATE ────────────────────────────────────────────────

describe('TRANSFER_STATE', () => {
  it('should have all expected states', () => {
    expect(TRANSFER_STATE.IDLE).toBe('idle');
    expect(TRANSFER_STATE.PREPARING).toBe('preparing');
    expect(TRANSFER_STATE.TRANSFERRING).toBe('transferring');
    expect(TRANSFER_STATE.PAUSED).toBe('paused');
    expect(TRANSFER_STATE.COMPLETING).toBe('completing');
    expect(TRANSFER_STATE.COMPLETED).toBe('completed');
    expect(TRANSFER_STATE.FAILED).toBe('failed');
    expect(TRANSFER_STATE.CANCELLED).toBe('cancelled');
  });

  it('should have 8 states', () => {
    expect(Object.keys(TRANSFER_STATE)).toHaveLength(8);
  });

  it('should have unique values', () => {
    const values = Object.values(TRANSFER_STATE);
    expect(new Set(values).size).toBe(values.length);
  });
});
