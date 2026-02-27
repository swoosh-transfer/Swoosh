/**
 * Infrastructure Module
 * 
 * Low-level data access and I/O operations.
 * Provides repositories for database access and utilities for file system operations.
 * 
 * @example
 * // Database operations
 * import { saveTransfer, getChunksByTransfer, initializeDatabase } from '@/infrastructure';
 * 
 * // Storage operations
 * import { initFileWriter, writeChunk, completeWriter } from '@/infrastructure/storage';
 * 
 * // Metadata utilities
 * import { createFileMetadata, createTransferRecord } from '@/infrastructure/metadata';
 */

// Database
export * from './database/index.js';

// Storage
export * as storage from './storage/index.js';

// Metadata
export * as metadata from './metadata/index.js';
