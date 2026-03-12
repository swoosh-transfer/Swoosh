/**
 * Transfer and Chunking Constants
 * 
 * These constants define chunk sizes and buffer configurations for file transfers.
 * Different chunk sizes are used for different purposes to optimize performance.
 * 
 * Users can override any constant via the Settings panel on the Home page.
 * Overrides are stored in localStorage under 'swoosh-transfer-settings'.
 */

// ── User-overridable settings via localStorage ──────────────────────

/**
 * Load user-configured setting overrides from localStorage.
 * Returns an object of { key: value } overrides, or empty object.
 */
function _loadUserOverrides() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem('swoosh-transfer-settings');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/**
 * Save user settings to localStorage.
 * @param {Object} settings — partial key/value overrides
 */
export function saveUserSettings(settings) {
  try {
    const current = _loadUserOverrides();
    localStorage.setItem('swoosh-transfer-settings', JSON.stringify({ ...current, ...settings }));
  } catch { /* ignore */ }
}

/**
 * Load all user settings (with defaults filled in).
 */
export function loadUserSettings() {
  const overrides = _loadUserOverrides();
  return {
    chunkSizeKB:                  overrides.chunkSizeKB ?? 64,
    mobileChunkSizeKB:            overrides.mobileChunkSizeKB ?? 16,
    maxChannels:                  overrides.maxChannels ?? 8,
    mobileMaxChannels:            overrides.mobileMaxChannels ?? 4,
    bufferWatermarkKB:            overrides.bufferWatermarkKB ?? 256,
    mobileBufferWatermarkKB:      overrides.mobileBufferWatermarkKB ?? 128,
    scaleUpThresholdKBs:          overrides.scaleUpThresholdKBs ?? 500,
    scaleIntervalMs:              overrides.scaleIntervalMs ?? 2000,
    mobileScaleIntervalMs:        overrides.mobileScaleIntervalMs ?? 3000,
    forceDesktopProfile:          overrides.forceDesktopProfile ?? false,
  };
}

/**
 * Clear all user overrides, reverting to defaults.
 */
export function resetUserSettings() {
  try {
    localStorage.removeItem('swoosh-transfer-settings');
  } catch { /* ignore */ }
}

// Load overrides once at module init
const _user = loadUserSettings();

/**
 * NETWORK_CHUNK_SIZE: 64KB (desktop) or 16KB (mobile)
 * 
 * Used for WebRTC DataChannel transmission.
 * Uses desktop chunk size by default; mobile detection applies in getTransferReliabilityProfile().
 */
export const NETWORK_CHUNK_SIZE = isConstrainedMobileEnvironment()
  ? _user.mobileChunkSizeKB * 1024
  : _user.chunkSizeKB * 1024;

/**
 * STORAGE_CHUNK_SIZE: 64KB
 * 
 * Used for IndexedDB storage and file system operations.
 * Larger chunks reduce storage overhead and improve disk I/O performance.
 * Optimal size for browser IndexedDB and File System Access API.
 */
export const STORAGE_CHUNK_SIZE = _user.chunkSizeKB * 1024;

/**
 * Adaptive Chunk Size Limits
 * 
 * The ChunkingEngine adjusts chunk sizes dynamically based on network conditions.
 * - Fast connection: increases toward MAX_CHUNK_SIZE
 * - Slow connection: decreases toward MIN_CHUNK_SIZE
 * - Default: INITIAL_CHUNK_SIZE
 */
export const INITIAL_CHUNK_SIZE = 64 * 1024; // 64KB - starting size (increased for modern networks)
export const MAX_CHUNK_SIZE = 256 * 1024;    // 256KB - ceiling for fast connections
export const MIN_CHUNK_SIZE = 16 * 1024;     // 16KB - floor for poor connections

/**
 * Speed Thresholds for Adaptive Chunking
 * 
 * Used by BandwidthTester and ChunkingEngine to determine optimal chunk sizes.
 * SPEED_HIGH_THRESHOLD: Threshold above which chunks increase (~1.5 MB/s)
 * SPEED_LOW_THRESHOLD: Threshold below which chunks decrease (~512 KB/s)
 * SPEED_ADJUSTMENT_INCREMENT: How much to adjust in each direction (10-20%)
 */
export const SPEED_HIGH_THRESHOLD = 1.5 * 1024 * 1024;  // 1.5 MB/s
export const SPEED_LOW_THRESHOLD = 512 * 1024;          // 512 KB/s
export const SPEED_ADJUSTMENT_INCREMENT = 0.25;          // 25% adjustment per step

/**
 * BUFFER_SIZE: Maximum buffered chunks in memory
 * 
 * Limits the number of chunks held in memory before writing to storage.
 * Prevents excessive memory usage for large file transfers.
 */
export const BUFFER_SIZE = 100; // ~6.4MB with 64KB chunks

/**
 * Transfer State Constants
 */
// ============ MULTI-CHANNEL CONSTANTS ============

/**
 * Dynamic channel scaling — auto-detect optimal channel count based on bandwidth.
 * Starts with 1 channel, scales up to MAX_CHANNELS when throughput is high.
 */
export const MIN_CHANNELS = 1;
export const MAX_CHANNELS = _user.maxChannels;
export const INITIAL_CHANNELS = 1;

/**
 * Channel scaling thresholds.
 * CHANNEL_SCALE_UP_THRESHOLD: sustained throughput above this triggers adding a channel (~2 MB/s)
 * CHANNEL_SCALE_DOWN_THRESHOLD: sustained throughput below this triggers removing a channel (~200 KB/s)
 * CHANNEL_SCALE_INTERVAL: how often (ms) to evaluate scaling decisions
 * CHANNEL_SCALE_SUSTAIN_COUNT: how many consecutive intervals the threshold must be sustained
 */
export const CHANNEL_SCALE_UP_THRESHOLD = Math.max(_user.scaleUpThresholdKBs * 1024, 2 * 1024 * 1024); // minimum 2 MB/s
export const CHANNEL_SCALE_DOWN_THRESHOLD = 200 * 1024;          // 200 KB/s
export const CHANNEL_SCALE_INTERVAL = _user.scaleIntervalMs;                      // user-configurable
export const CHANNEL_SCALE_SUSTAIN_COUNT = 1;                    // single interval (faster response)

/** Prefix for data channel labels: file-transfer-0, file-transfer-1, etc. */
export const CHANNEL_LABEL_PREFIX = 'file-transfer-';

/** Low watermark for per-channel bufferedAmount before sending more data */
export const CHANNEL_BUFFER_LOW_WATERMARK = 128 * 1024;  // 128KB (increased for throughput)

/** High watermark — pause sending on a channel when bufferedAmount exceeds this */
export const CHANNEL_BUFFER_HIGH_WATERMARK = 512 * 1024; // 512KB (increased for high-latency)

/**
 * Mobile/constrained-network reliability profile.
 * Keeps throughput balanced while reducing stalls on weaker devices/networks.
 */
export const MOBILE_MAX_CHANNELS = _user.mobileMaxChannels;
export const MOBILE_MIN_PARALLEL_WORKERS = 2;
export const MOBILE_CHANNEL_SCALE_INTERVAL = _user.mobileScaleIntervalMs;
export const MOBILE_CHANNEL_BUFFER_LOW_WATERMARK = _user.mobileBufferWatermarkKB * 1024;
export const DESKTOP_CHANNEL_BUFFER_LOW_WATERMARK = _user.bufferWatermarkKB * 1024;

// ── Hoisted mobile detection (needed before NETWORK_CHUNK_SIZE) ──

/**
 * Detect likely mobile/constrained environment.
 * Uses userAgentData when available, with UA and Network Information API fallback.
 *
 * @returns {boolean}
 */
export function isConstrainedMobileEnvironment() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  if (typeof localStorage !== 'undefined' && (_user.forceDesktopProfile || localStorage.getItem('forceDesktopProfile') === 'true')) {
    return false;
  }

  const userAgentDataMobile = Boolean(navigator.userAgentData?.mobile);
  const userAgent = navigator.userAgent || '';
  const isMobileUa = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(userAgent);

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const saveData = Boolean(connection?.saveData);
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  const slowNetwork = effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g';

  return userAgentDataMobile || isMobileUa || saveData || slowNetwork;
}

/**
 * Runtime transfer profile tuned for current device/network conditions.
 */
export function getTransferReliabilityProfile() {
  const constrained = isConstrainedMobileEnvironment();

  return {
    constrained,
    maxChannels: constrained ? MOBILE_MAX_CHANNELS : MAX_CHANNELS,
    minParallelWorkers: constrained ? MOBILE_MIN_PARALLEL_WORKERS : 3,
    channelScaleInterval: constrained ? MOBILE_CHANNEL_SCALE_INTERVAL : CHANNEL_SCALE_INTERVAL,
    channelBufferLowWatermark: constrained
      ? MOBILE_CHANNEL_BUFFER_LOW_WATERMARK
      : DESKTOP_CHANNEL_BUFFER_LOW_WATERMARK,
    chunkSize: constrained ? (_user.mobileChunkSizeKB * 1024) : STORAGE_CHUNK_SIZE,
  };
}

/**
 * Build a serializable transfer config for exchange with the remote peer.
 * Both peers send their config; the negotiated config uses conservative (minimum) values.
 */
export function getLocalTransferConfig() {
  const profile = getTransferReliabilityProfile();
  return {
    chunkSize: profile.chunkSize,
    maxChannels: profile.maxChannels,
    bufferWatermark: profile.channelBufferLowWatermark,
    constrained: profile.constrained,
  };
}

/**
 * Negotiate a shared config from local and remote configs.
 * Uses the more conservative (smaller) values so both peers can handle the load.
 *
 * @param {Object} localConfig  - from getLocalTransferConfig()
 * @param {Object} remoteConfig - received from peer
 * @returns {Object} agreed config
 */
export function negotiateTransferConfig(localConfig, remoteConfig) {
  return {
    chunkSize: Math.min(localConfig.chunkSize, remoteConfig.chunkSize),
    maxChannels: Math.min(localConfig.maxChannels, remoteConfig.maxChannels),
    bufferWatermark: Math.min(localConfig.bufferWatermark, remoteConfig.bufferWatermark),
    constrained: localConfig.constrained || remoteConfig.constrained,
  };
}

// ============ TRANSFER MODE ============

export const TRANSFER_MODE = {
  SEQUENTIAL: 'sequential',
  PARALLEL: 'parallel',
};

/**
 * Transfer State Constants
 */
export const TRANSFER_STATE = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  TRANSFERRING: 'transferring',
  PAUSED: 'paused',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
