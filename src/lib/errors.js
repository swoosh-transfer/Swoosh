/**
 * Custom Error Classes
 * 
 * Standardized error types for different failure scenarios.
 * These errors provide context-specific information and can be handled appropriately.
 */

/**
 * Base Application Error
 * 
 * Base class for all custom application errors.
 * Includes additional context and proper error name.
 */
export class AppError extends Error {
  /**
   * @param {string} message - Error message
   * @param {Object} context - Additional context about the error
   */
  constructor(message, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    this.timestamp = Date.now();
    
    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON for logging/reporting
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/**
 * Transfer Error
 * 
 * Errors related to file transfer operations (sending, receiving, chunking).
 * 
 * @example
 * throw new TransferError('Chunk validation failed', { 
 *   chunkId: 123, 
 *   expected: 'abc', 
 *   actual: 'xyz' 
 * });
 */
export class TransferError extends AppError {
  constructor(message, context = {}) {
    super(message, context);
  }
}

/**
 * Connection Error
 * 
 * Errors related to WebRTC connections, signaling, or network issues.
 * 
 * @example
 * throw new ConnectionError('Peer connection failed', { 
 *   state: 'failed', 
 *   iceState: 'disconnected' 
 * });
 */
export class ConnectionError extends AppError {
  constructor(message, context = {}) {
    super(message, context);
  }
}

/**
 * Security Error
 * 
 * Errors related to TOFU verification, key validation, or security checks.
 * 
 * @example
 * throw new SecurityError('TOFU verification failed', { 
 *   peerId: 'abc123', 
 *   reason: 'Key mismatch' 
 * });
 */
export class SecurityError extends AppError {
  constructor(message, context = {}) {
    super(message, context);
  }
}

/**
 * Storage Error
 * 
 * Errors related to IndexedDB, file system, or data persistence.
 * 
 * @example
 * throw new StorageError('Failed to write chunk to IndexedDB', { 
 *   transferId: 'abc', 
 *   chunkId: 5 
 * });
 */
export class StorageError extends AppError {
  constructor(message, context = {}) {
    super(message, context);
  }
}

/**
 * Validation Error
 * 
 * Errors related to data validation, schema checks, or input validation.
 * 
 * @example
 * throw new ValidationError('Invalid file metadata', { 
 *   field: 'size', 
 *   value: -1, 
 *   expected: 'positive number' 
 * });
 */
export class ValidationError extends AppError {
  constructor(message, context = {}) {
    super(message, context);
  }
}

/**
 * Timeout Error
 * 
 * Errors related to operation timeouts.
 * 
 * @example
 * throw new TimeoutError('Connection timeout', { 
 *   operation: 'peer-connection', 
 *   timeout: 30000 
 * });
 */
export class TimeoutError extends AppError {
  constructor(message, context = {}) {
    super(message, context);
  }
}

/**
 * Check if error is of a specific type
 * 
 * @param {Error} error - Error to check
 * @param {Function} ErrorClass - Error class to check against
 * @returns {boolean}
 * 
 * @example
 * if (isErrorType(err, TransferError)) {
 *   // Handle transfer-specific error
 * }
 */
export function isErrorType(error, ErrorClass) {
  return error instanceof ErrorClass;
}

/**
 * Extract error message safely
 * 
 * Handles cases where error might not be an Error object.
 * 
 * @param {*} error - Error or error-like value
 * @returns {string} Error message
 * 
 * @example
 * getErrorMessage(new Error('test'))  // "test"
 * getErrorMessage('string error')     // "string error"
 * getErrorMessage({ message: 'obj' }) // "obj"
 */
export function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return String(error);
}
