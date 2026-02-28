/**
 * Logger Utility
 * 
 * Production-ready logging with environment-based filtering.
 * - Development: All logs enabled
 * - Production: Only errors logged (can be extended to send to monitoring service)
 */

const isDev = import.meta.env.DEV;

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
   * Error messages (always logged)
   * In production, these could be sent to error tracking service
   * @param {...any} args - Values to log
   */
  error: (...args) => {
    if (isDev) console.error(...args);
    // TODO: In production, send to error tracking service (Sentry, LogRocket, etc.)
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
