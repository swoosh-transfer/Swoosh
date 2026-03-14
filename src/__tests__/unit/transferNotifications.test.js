/**
 * Unit Tests for Transfer Notifications
 *
 * Tests activity log event system and notification convenience methods.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  default: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  onActivityLogEvent,
  notify,
  notifyPeerJoined,
  notifyPeerDisconnected,
  notifyPeerReconnected,
  notifyTransferStarted,
  notifyTransferPaused,
  notifyTransferResumed,
  notifyTransferComplete,
  notifyTransferFailed,
  notifyResumeAttempt,
  notifyResumeSuccess,
  notifyResumeFailed,
  notifySessionMismatch,
  notifyNewTransferIncoming,
  notifyHeartbeatLost,
  notifyHeartbeatRecovered,
  clearNotificationListeners,
  NOTIFICATION_TYPE,
} from '@/utils/transferNotifications';

describe('Activity Log Events', () => {
  let listener;
  let unsub;

  beforeEach(() => {
    clearNotificationListeners();
    listener = vi.fn();
    unsub = onActivityLogEvent(listener);
  });

  afterEach(() => {
    if (unsub) unsub();
    clearNotificationListeners();
  });

  it('should register and receive events', () => {
    notify('test-type', 'test message');
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event.type).toBe('test-type');
    expect(event.message).toBe('test message');
    expect(event.timestamp).toBeDefined();
  });

  it('should support multiple listeners', () => {
    const listener2 = vi.fn();
    const unsub2 = onActivityLogEvent(listener2);

    notify('test', 'msg');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    unsub2();
  });

  it('should unsubscribe correctly', () => {
    unsub();
    notify('test', 'after unsub');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should pass metadata through', () => {
    notify('test', 'msg', { metadata: { key: 'value' } });
    const event = listener.mock.calls[0][0];
    expect(event.key).toBe('value');
  });

  it('should handle listener errors gracefully', () => {
    const badListener = vi.fn(() => { throw new Error('listener crash'); });
    const unsub2 = onActivityLogEvent(badListener);

    // Should not throw
    expect(() => notify('test', 'msg')).not.toThrow();

    unsub2();
  });
});

describe('clearNotificationListeners', () => {
  it('should remove all listeners', () => {
    const listener = vi.fn();
    onActivityLogEvent(listener);
    clearNotificationListeners();
    notify('test', 'msg');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('NOTIFICATION_TYPE', () => {
  it('should have all expected types', () => {
    expect(NOTIFICATION_TYPE.PEER_JOINED).toBeDefined();
    expect(NOTIFICATION_TYPE.PEER_DISCONNECTED).toBeDefined();
    expect(NOTIFICATION_TYPE.PEER_RECONNECTED).toBeDefined();
    expect(NOTIFICATION_TYPE.TRANSFER_STARTED).toBeDefined();
    expect(NOTIFICATION_TYPE.TRANSFER_PAUSED).toBeDefined();
    expect(NOTIFICATION_TYPE.TRANSFER_RESUMED).toBeDefined();
    expect(NOTIFICATION_TYPE.TRANSFER_COMPLETE).toBeDefined();
    expect(NOTIFICATION_TYPE.TRANSFER_FAILED).toBeDefined();
    expect(NOTIFICATION_TYPE.RESUME_ATTEMPT).toBeDefined();
    expect(NOTIFICATION_TYPE.RESUME_SUCCESS).toBeDefined();
    expect(NOTIFICATION_TYPE.RESUME_FAILED).toBeDefined();
    expect(NOTIFICATION_TYPE.SESSION_MISMATCH).toBeDefined();
    expect(NOTIFICATION_TYPE.NEW_TRANSFER_INCOMING).toBeDefined();
    expect(NOTIFICATION_TYPE.HEARTBEAT_LOST).toBeDefined();
    expect(NOTIFICATION_TYPE.HEARTBEAT_RECOVERED).toBeDefined();
  });

  it('should have unique values', () => {
    const values = Object.values(NOTIFICATION_TYPE);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── Convenience notification methods ──────────────────────────────

describe('Convenience notification methods', () => {
  let events;
  let unsub;

  beforeEach(() => {
    clearNotificationListeners();
    events = [];
    unsub = onActivityLogEvent((e) => events.push(e));
  });

  afterEach(() => {
    if (unsub) unsub();
    clearNotificationListeners();
  });

  it('notifyPeerJoined should emit peer-joined event', () => {
    notifyPeerJoined('uuid-1234-5678');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(NOTIFICATION_TYPE.PEER_JOINED);
    expect(events[0].message).toContain('uuid-123');
  });

  it('notifyPeerDisconnected should include reason', () => {
    notifyPeerDisconnected('uuid-abc', 'network failure');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.PEER_DISCONNECTED);
    expect(events[0].message).toContain('network failure');
  });

  it('notifyPeerReconnected should distinguish session types', () => {
    notifyPeerReconnected('uuid-abc', true);
    expect(events[0].message).toContain('same session');

    notifyPeerReconnected('uuid-abc', false);
    expect(events[1].message).toContain('new session');
  });

  it('notifyTransferStarted should emit with skipBrowser', () => {
    notifyTransferStarted('photo.jpg', 5000);
    expect(events[0].type).toBe(NOTIFICATION_TYPE.TRANSFER_STARTED);
    expect(events[0].message).toContain('photo.jpg');
  });

  it('notifyTransferPaused should include filename', () => {
    notifyTransferPaused('doc.pdf', 'user');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.TRANSFER_PAUSED);
    expect(events[0].message).toContain('doc.pdf');
  });

  it('notifyTransferResumed should include progress', () => {
    notifyTransferResumed('file.zip', 45);
    expect(events[0].message).toContain('45');
  });

  it('notifyTransferComplete should emit correct type', () => {
    notifyTransferComplete('final.mp4');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.TRANSFER_COMPLETE);
    expect(events[0].message).toContain('final.mp4');
  });

  it('notifyTransferFailed should include error', () => {
    notifyTransferFailed('broken.bin', 'disk full');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.TRANSFER_FAILED);
    expect(events[0].message).toContain('disk full');
  });

  it('notifyResumeAttempt should include progress', () => {
    notifyResumeAttempt('file.txt', 50);
    expect(events[0].type).toBe(NOTIFICATION_TYPE.RESUME_ATTEMPT);
    expect(events[0].message).toContain('50');
  });

  it('notifyResumeSuccess should emit', () => {
    notifyResumeSuccess('file.txt', 100);
    expect(events[0].type).toBe(NOTIFICATION_TYPE.RESUME_SUCCESS);
  });

  it('notifyResumeFailed should include reason', () => {
    notifyResumeFailed('file.txt', 'file changed');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.RESUME_FAILED);
    expect(events[0].message).toContain('file changed');
  });

  it('notifySessionMismatch should emit', () => {
    notifySessionMismatch('expected-uuid', 'actual-uuid');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.SESSION_MISMATCH);
  });

  it('notifyNewTransferIncoming should include file info', () => {
    notifyNewTransferIncoming('incoming.zip', 1024, 'peer-uuid-12345678');
    expect(events[0].type).toBe(NOTIFICATION_TYPE.NEW_TRANSFER_INCOMING);
    expect(events[0].message).toContain('incoming.zip');
  });

  it('notifyHeartbeatLost should emit', () => {
    notifyHeartbeatLost();
    expect(events[0].type).toBe(NOTIFICATION_TYPE.HEARTBEAT_LOST);
  });

  it('notifyHeartbeatRecovered should emit', () => {
    notifyHeartbeatRecovered();
    expect(events[0].type).toBe(NOTIFICATION_TYPE.HEARTBEAT_RECOVERED);
  });
});
