/**
 * ChannelPool — manages N WebRTC DataChannels on a single RTCPeerConnection.
 *
 * Channel-0 is always the "control" channel used for JSON signaling messages.
 * Channels 1..N are "data" channels used for bulk binary transfer.
 *
 * Emits (via callback maps):
 *   channel-open   (channelIndex, channel)
 *   channel-close  (channelIndex)
 *   channel-message(channelIndex, event)
 *   channel-error  (channelIndex, error)
 */
import {
  CHANNEL_LABEL_PREFIX,
  CHANNEL_BUFFER_LOW_WATERMARK,
  CHANNEL_BUFFER_HIGH_WATERMARK,
  MAX_CHANNELS,
} from '../../constants/transfer.constants.js';
import logger from '../../utils/logger.js';

export class ChannelPool {
  /** @param {RTCPeerConnection} pc */
  constructor(pc) {
    /** @type {RTCPeerConnection} */
    this._pc = pc;

    /** @type {Map<number, RTCDataChannel>} index → channel */
    this._channels = new Map();

    /** Event listeners: eventName → Set<Function> */
    this._listeners = {};

    /** Round-robin pointer */
    this._rrIndex = 0;
  }

  // ─── Channel lifecycle ────────────────────────────────────────────

  /**
   * Create a new outgoing data channel.
   * @param {number} [index] — channel index; defaults to next available
   * @returns {RTCDataChannel}
   */
  addChannel(index) {
    if (index === undefined) {
      index = this._nextIndex();
    }

    if (this._channels.has(index)) {
      return this._channels.get(index);
    }

    if (this._channels.size >= MAX_CHANNELS) {
      logger.warn('[ChannelPool] MAX_CHANNELS reached, cannot add more');
      return null;
    }

    // Check if peer connection is in valid state for creating data channels
    if (!this._pc || this._pc.signalingState === 'closed' || this._pc.connectionState === 'closed') {
      logger.warn(`[ChannelPool] Cannot create channel — peer connection state: signalingState=${this._pc?.signalingState}, connectionState=${this._pc?.connectionState}`);
      return null;
    }

    const label = `${CHANNEL_LABEL_PREFIX}${index}`;
    try {
      const channel = this._pc.createDataChannel(label, {
        ordered: true,
        // Let the browser handle its own buffering
      });
      channel.binaryType = 'arraybuffer';
      this._wire(index, channel);
      this._channels.set(index, channel);
      logger.log(`[ChannelPool] Created outgoing channel ${label}`);
      return channel;
    } catch (error) {
      // Catch any errors from createDataChannel (e.g., InvalidStateError)
      logger.warn(`[ChannelPool] Failed to create channel ${label}:`, error.message);
      return null;
    }
  }

  /**
   * Accept an incoming data channel (called from pc.ondatachannel).
   * Parses the index from the label and registers it.
   * @param {RTCDataChannel} channel
   * @returns {number} parsed channel index
   */
  acceptChannel(channel) {
    const index = this._parseIndex(channel.label);
    channel.binaryType = 'arraybuffer';
    this._wire(index, channel);
    this._channels.set(index, channel);
    logger.log(`[ChannelPool] Accepted incoming channel ${channel.label}`);
    return index;
  }

  /**
   * Remove and close a channel.
   * @param {number} index
   */
  removeChannel(index) {
    const ch = this._channels.get(index);
    if (ch) {
      try { ch.close(); } catch (_) { /* ignore */ }
      this._channels.delete(index);
      logger.log(`[ChannelPool] Removed channel ${index}`);
    }
  }

  // ─── Sending ──────────────────────────────────────────────────────

  /**
   * Send data on a specific channel.
   * @param {number} channelIndex
   * @param {string|ArrayBuffer} data
   */
  send(channelIndex, data) {
    const ch = this._channels.get(channelIndex);
    if (!ch || ch.readyState !== 'open') {
      throw new Error(`Channel ${channelIndex} not open`);
    }
    ch.send(data);
  }

  /**
   * Broadcast data to ALL open channels.
   * @param {string|ArrayBuffer} data
   */
  broadcast(data) {
    for (const [, ch] of this._channels) {
      if (ch.readyState === 'open') {
        ch.send(data);
      }
    }
  }

  /**
   * Send JSON on channel-0 (control channel).
   * @param {Object} obj
   */
  sendControl(obj) {
    this.send(0, JSON.stringify(obj));
  }

  /**
   * Pick the "best" open data channel (channels >= 1) using least-buffered strategy.
   * Falls back to round-robin when buffers are equal.
   * @returns {number|null} channel index, or null if none available
   */
  getAvailableChannel() {
    const dataChannels = [...this._channels.entries()]
      .filter(([idx, ch]) => idx >= 1 && ch.readyState === 'open');

    if (dataChannels.length === 0) {
      // Fallback: use channel 0 if it's the only one
      const ch0 = this._channels.get(0);
      return ch0 && ch0.readyState === 'open' ? 0 : null;
    }

    // Find least-buffered
    let best = dataChannels[0];
    for (const entry of dataChannels) {
      if (entry[1].bufferedAmount < best[1].bufferedAmount) {
        best = entry;
      }
    }
    return best[0];
  }

  /**
   * Wait until a channel's bufferedAmount drops below CHANNEL_BUFFER_LOW_WATERMARK.
   * @param {number} channelIndex
   * @returns {Promise<void>}
   */
  waitForDrain(channelIndex) {
    const ch = this._channels.get(channelIndex);
    if (!ch) return Promise.resolve();
    if (ch.bufferedAmount <= CHANNEL_BUFFER_LOW_WATERMARK) return Promise.resolve();

    return new Promise((resolve) => {
      // Use bufferedamountlow event if supported
      if (typeof ch.bufferedAmountLowThreshold === 'number') {
        ch.bufferedAmountLowThreshold = CHANNEL_BUFFER_LOW_WATERMARK;
        const handler = () => {
          ch.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        ch.addEventListener('bufferedamountlow', handler);
      } else {
        // Poll fallback
        const poll = setInterval(() => {
          if (!ch || ch.readyState !== 'open' || ch.bufferedAmount <= CHANNEL_BUFFER_LOW_WATERMARK) {
            clearInterval(poll);
            resolve();
          }
        }, 10);
      }
    });
  }

  /**
   * Wait for drain on the least-buffered data channel, or a specific one.
   * @returns {Promise<void>}
   */
  async waitForAnyDrain() {
    const idx = this.getAvailableChannel();
    if (idx !== null) {
      await this.waitForDrain(idx);
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /** @returns {RTCDataChannel|undefined} channel-0 (control) */
  getControlChannel() {
    return this._channels.get(0);
  }

  /** @returns {RTCDataChannel|undefined} */
  getChannel(index) {
    return this._channels.get(index);
  }

  /** @returns {number} */
  get size() {
    return this._channels.size;
  }

  /** @returns {number} count of open channels */
  get openCount() {
    let n = 0;
    for (const [, ch] of this._channels) {
      if (ch.readyState === 'open') n++;
    }
    return n;
  }

  /** @returns {number} count of open DATA channels (index >= 1) */
  get openDataCount() {
    let n = 0;
    for (const [idx, ch] of this._channels) {
      if (idx >= 1 && ch.readyState === 'open') n++;
    }
    return n;
  }

  /** @returns {number[]} sorted list of channel indices */
  get indices() {
    return [...this._channels.keys()].sort((a, b) => a - b);
  }

  /** Are all channels open? */
  get allOpen() {
    if (this._channels.size === 0) return false;
    for (const [, ch] of this._channels) {
      if (ch.readyState !== 'open') return false;
    }
    return true;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  /** Close and remove all channels. */
  destroy() {
    for (const [idx] of this._channels) {
      this.removeChannel(idx);
    }
    this._listeners = {};
  }

  // ─── Events ───────────────────────────────────────────────────────

  /**
   * Register an event listener.
   * @param {'channel-open'|'channel-close'|'channel-message'|'channel-error'} event
   * @param {Function} fn
   */
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = new Set();
    this._listeners[event].add(fn);
  }

  off(event, fn) {
    this._listeners[event]?.delete(fn);
  }

  _emit(event, ...args) {
    if (this._listeners[event]) {
      for (const fn of this._listeners[event]) {
        try { fn(...args); } catch (e) { logger.error(`[ChannelPool] listener error:`, e); }
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────

  _wire(index, channel) {
    channel.onopen = () => {
      logger.log(`[ChannelPool] channel-${index} opened`);
      this._emit('channel-open', index, channel);
    };
    channel.onclose = () => {
      logger.log(`[ChannelPool] channel-${index} closed`);
      this._channels.delete(index);
      this._emit('channel-close', index);
    };
    channel.onerror = (e) => {
      logger.error(`[ChannelPool] channel-${index} error:`, e);
      this._emit('channel-error', index, e);
    };
    channel.onmessage = (event) => {
      this._emit('channel-message', index, event);
    };
  }

  _parseIndex(label) {
    const match = label.match(/(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  _nextIndex() {
    let i = 0;
    while (this._channels.has(i)) i++;
    return i;
  }
}
