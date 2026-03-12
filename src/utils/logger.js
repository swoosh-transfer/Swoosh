/**
 * Logger Utility
 * 
 * Production-ready logging with environment-based filtering.
 * - Development: All logs enabled
 * - Production: Only errors logged and sent to error tracking service
 */

const isDev = import.meta.env.DEV;

// ============================================================================
// ERROR TRACKING SERVICE INTEGRATION
// ============================================================================

/**
 * Initialize error tracking service (Sentry, LogRocket, etc.)
 * Configure this based on your chosen service provider
 */
function initializeErrorTracking() {
  // Check if we're in production
  if (!isDev) {
    // TODO: Configure your error tracking service here
    // Example for Sentry:
    // import * as Sentry from "@sentry/react";
    // Sentry.init({
    //   dsn: import.meta.env.VITE_SENTRY_DSN,
    //   environment: import.meta.env.MODE,
    //   tracesSampleRate: 1.0,
    // });
    
    // Example for LogRocket:
    // import LogRocket from 'logrocket';
    // LogRocket.init(import.meta.env.VITE_LOGROCKET_ID);
  }
}

// Initialize on module load
initializeErrorTracking();

/**
 * Send error to tracking service
 * @param {Error|string} error - Error object or message
 * @param {Object} context - Additional context for error tracking
 */
function reportError(error, context = {}) {
  if (!isDev) {
    // TODO: Implement error reporting based on your chosen service
    // Example for Sentry:
    // import * as Sentry from "@sentry/react";
    // Sentry.captureException(error, { contexts: { app: context } });
    
    // Example for LogRocket:
    // import LogRocket from 'logrocket';
    // LogRocket.captureException(error);
  }
}

/**
 * Logger instance with environment-aware logging methods
 * 
 * @example
 * import logger from '@/utils/logger';
 * 
 * logger.info('Transfer started', { fileId: 123 });
 * logger.warn('Connection slow', { rtt: 500 });
 * logger.error('Transfer failed', error);
 */
export const logger = {
  /**
   * General logging (development only)
   * @param {...any} args - Values to log
   */
  log: (...args) => {
    if (isDev) console.log(...args);
  },
  
  /**
   * Warning messages (development only)
   * @param {...any} args - Values to log
   */
  warn: (...args) => {
    if (isDev) console.warn(...args);
  },
  
  /**
   * Error messages (always logged and sent to tracking service)
   * @param {...any} args - Values to log
   */
  error: (...args) => {
    if (isDev) console.error(...args);
    // Send first argument to error tracking service if it's an Error
    if (args.length > 0 && args[0] instanceof Error) {
      reportError(args[0], { additionalArgs: args.slice(1) });
    } else if (args.length > 0) {
      reportError(new Error(String(args[0])), { additionalArgs: args.slice(1) });
    }
  },
  
  /**
   * Informational messages (development only)
   * @param {...any} args - Values to log
   */
  info: (...args) => {
    if (isDev) console.info(...args);
  },
  
  /**
   * Debug messages (development only)
   * @param {...any} args - Values to log
   */
  debug: (...args) => {
    if (isDev) console.debug(...args);
  }
};

export default logger;
