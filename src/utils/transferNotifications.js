/**
 * Transfer Notifications Manager
 * 
 * Handles both browser notifications and activity log updates for transfer events.
 * Provides a unified interface for notifying users about:
 * - Peer connections/disconnections
 * - Transfer state changes (pause, resume, complete, error)
 * - Resume attempts and verification status
 */

import logger from './logger.js';

/** @type {boolean} Whether browser notifications are supported and permitted */
let notificationPermission = false;

/** @type {Set<Function>} Registered activity log listeners */
const activityLogListeners = new Set();

/**
 * Notification event types
 */
export const NOTIFICATION_TYPE = {
  PEER_JOINED: 'peer-joined',
  PEER_DISCONNECTED: 'peer-disconnected',
  PEER_RECONNECTED: 'peer-reconnected',
  TRANSFER_STARTED: 'transfer-started',
  TRANSFER_PAUSED: 'transfer-paused',
  TRANSFER_RESUMED: 'transfer-resumed',
  TRANSFER_COMPLETE: 'transfer-complete',
  TRANSFER_FAILED: 'transfer-failed',
  RESUME_ATTEMPT: 'resume-attempt',
  RESUME_SUCCESS: 'resume-success',
  RESUME_FAILED: 'resume-failed',
  SESSION_MISMATCH: 'session-mismatch',
  NEW_TRANSFER_INCOMING: 'new-transfer-incoming',
  HEARTBEAT_LOST: 'heartbeat-lost',
  HEARTBEAT_RECOVERED: 'heartbeat-recovered',
};

/**
 * Initialize notification system
 * Requests browser notification permission and sets up listeners
 * 
 * @returns {Promise<boolean>} True if notifications are available
 */
export async function initNotifications() {
  // Check if Notification API is supported
  if (!('Notification' in window)) {
    logger.warn('[Notifications] Browser notifications not supported');
    notificationPermission = false;
    return false;
  }

  // Check current permission state
  if (Notification.permission === 'granted') {
    notificationPermission = true;
    logger.log('[Notifications] Browser notifications enabled');
    return true;
  }

  // Request permission if not yet determined
  if (Notification.permission === 'default') {
    try {
      const permission = await Notification.requestPermission();
      notificationPermission = permission === 'granted';
      logger.log(`[Notifications] Permission ${permission}`);
      return notificationPermission;
    } catch (error) {
      logger.error('[Notifications] Error requesting permission:', error);
      notificationPermission = false;
      return false;
    }
  }

  // Permission denied
  notificationPermission = false;
  logger.log('[Notifications] Browser notifications denied, using activity log only');
  return false;
}

/**
 * Register a listener for activity log events
 * 
 * @param {Function} callback - Called with (type, message, metadata)
 * @returns {Function} Unsubscribe function
 */
export function onActivityLogEvent(callback) {
  activityLogListeners.add(callback);
  return () => activityLogListeners.delete(callback);
}

/**
 * Notify all activity log listeners
 * 
 * @param {string} type - Notification type
 * @param {string} message - Human-readable message
 * @param {Object} metadata - Additional event data
 */
function notifyActivityLog(type, message, metadata = {}) {
  const event = {
    type,
    message,
    timestamp: Date.now(),
    ...metadata,
  };

  activityLogListeners.forEach(listener => {
    try {
      listener(event);
    } catch (error) {
      logger.error('[Notifications] Activity log listener error:', error);
    }
  });
}

/**
 * Show browser notification
 * 
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} options - Additional notification options
 */
function showBrowserNotification(title, body, options = {}) {
  if (!notificationPermission) {
    return;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon: '/icon-192x192.png',
      badge: '/icon-96x96.png',
      ...options,
    });

    // Auto-close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  } catch (error) {
    logger.error('[Notifications] Error showing browser notification:', error);
  }
}

/**
 * Send notification (both browser and activity log)
 * 
 * @param {string} type - Notification type from NOTIFICATION_TYPE
 * @param {string} message - Human-readable message
 * @param {Object} options - Additional options
 * @param {string} options.title - Browser notification title (defaults to app name)
 * @param {boolean} options.skipBrowser - Skip browser notification
 * @param {Object} options.metadata - Additional metadata for activity log
 */
export function notify(type, message, options = {}) {
  const {
    title = 'File Transfer',
    skipBrowser = false,
    metadata = {},
  } = options;

  // Always log to activity log
  notifyActivityLog(type, message, metadata);

  // Optionally show browser notification
  if (!skipBrowser) {
    showBrowserNotification(title, message);
  }

  // Debug log
  logger.log(`[Notification] ${type}: ${message}`, metadata);
}

/**
 * Convenience methods for common notifications
 */

export function notifyPeerJoined(peerUuid) {
  notify(
    NOTIFICATION_TYPE.PEER_JOINED,
    `Peer connected: ${peerUuid.slice(0, 8)}...`,
    {
      title: 'Peer Connected',
      metadata: { peerUuid },
    }
  );
}

export function notifyPeerDisconnected(peerUuid, reason = 'Unknown') {
  notify(
    NOTIFICATION_TYPE.PEER_DISCONNECTED,
    `Peer disconnected: ${reason}`,
    {
      title: 'Peer Disconnected',
      metadata: { peerUuid, reason },
    }
  );
}

export function notifyPeerReconnected(peerUuid, isOriginalSession) {
  const message = isOriginalSession
    ? `Peer reconnected with same session`
    : `Peer reconnected with new session`;
  
  notify(
    NOTIFICATION_TYPE.PEER_RECONNECTED,
    message,
    {
      title: 'Peer Reconnected',
      metadata: { peerUuid, isOriginalSession },
    }
  );
}

export function notifyTransferStarted(fileName, fileSize) {
  notify(
    NOTIFICATION_TYPE.TRANSFER_STARTED,
    `Transfer started: ${fileName}`,
    {
      title: 'Transfer Started',
      skipBrowser: true, // Don't spam for every transfer start
      metadata: { fileName, fileSize },
    }
  );
}

export function notifyTransferPaused(fileName, reason = 'User action') {
  notify(
    NOTIFICATION_TYPE.TRANSFER_PAUSED,
    `Transfer paused: ${fileName}`,
    {
      title: 'Transfer Paused',
      metadata: { fileName, reason },
    }
  );
}

export function notifyTransferResumed(fileName, progress) {
  notify(
    NOTIFICATION_TYPE.TRANSFER_RESUMED,
    `Transfer resumed: ${fileName} (${progress}% complete)`,
    {
      title: 'Transfer Resumed',
      metadata: { fileName, progress },
    }
  );
}

export function notifyTransferComplete(fileName) {
  notify(
    NOTIFICATION_TYPE.TRANSFER_COMPLETE,
    `Transfer complete: ${fileName}`,
    {
      title: 'Transfer Complete',
      metadata: { fileName },
    }
  );
}

export function notifyTransferFailed(fileName, error) {
  notify(
    NOTIFICATION_TYPE.TRANSFER_FAILED,
    `Transfer failed: ${fileName} - ${error}`,
    {
      title: 'Transfer Failed',
      metadata: { fileName, error },
    }
  );
}

export function notifyResumeAttempt(fileName, fromProgress) {
  notify(
    NOTIFICATION_TYPE.RESUME_ATTEMPT,
    `Attempting to resume transfer from ${fromProgress}%...`,
    {
      title: 'Resume Attempt',
      metadata: { fileName, fromProgress },
    }
  );
}

export function notifyResumeSuccess(fileName, savedChunks) {
  notify(
    NOTIFICATION_TYPE.RESUME_SUCCESS,
    `Successfully resumed transfer: ${fileName}`,
    {
      title: 'Resume Successful',
      metadata: { fileName, savedChunks },
    }
  );
}

export function notifyResumeFailed(fileName, reason) {
  notify(
    NOTIFICATION_TYPE.RESUME_FAILED,
    `Resume failed: ${reason}. Starting fresh transfer.`,
    {
      title: 'Resume Failed',
      metadata: { fileName, reason },
    }
  );
}

export function notifySessionMismatch(expectedPeer, actualPeer) {
  notify(
    NOTIFICATION_TYPE.SESSION_MISMATCH,
    `Cannot resume - different peer detected. Expected session from previous transfer.`,
    {
      title: 'Session Verification Failed',
      metadata: { expectedPeer, actualPeer },
    }
  );
}

export function notifyNewTransferIncoming(fileName, fileSize, peerUuid) {
  notify(
    NOTIFICATION_TYPE.NEW_TRANSFER_INCOMING,
    `Incoming transfer: ${fileName} from ${peerUuid.slice(0, 8)}...`,
    {
      title: 'New Transfer',
      metadata: { fileName, fileSize, peerUuid },
    }
  );
}

export function notifyHeartbeatLost() {
  notify(
    NOTIFICATION_TYPE.HEARTBEAT_LOST,
    `Connection unstable - attempting to maintain connection...`,
    {
      title: 'Connection Issue',
      skipBrowser: true, // Too frequent
      metadata: {},
    }
  );
}

export function notifyHeartbeatRecovered() {
  notify(
    NOTIFICATION_TYPE.HEARTBEAT_RECOVERED,
    `Connection restored`,
    {
      title: 'Connection Recovered',
      metadata: {},
    }
  );
}

/**
 * Clear all activity log listeners (cleanup)
 */
export function clearNotificationListeners() {
  activityLogListeners.clear();
  logger.log('[Notifications] All listeners cleared');
}

export default {
  initNotifications,
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
};
