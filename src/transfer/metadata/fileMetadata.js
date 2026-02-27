/**
 * File Metadata Utilities
 * 
 * Utilities for creating and managing file metadata for transfers.
 * Uses repository pattern for data access.
 */

import { metadataRepository } from '../../infrastructure/database/metadata.repository.js';
import { transfersRepository } from '../../infrastructure/database/transfers.repository.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';

/**
 * Generate a unique UUID
 */
export function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create file metadata object
 * 
 * @param {Object} options - File options
 * @param {string} options.name - File name
 * @param {number} options.size - File size in bytes
 * @param {string} options.type - MIME type
 * @param {number} options.lastModified - Last modified timestamp
 * @returns {Object} File metadata
 */
export function createFileMetadata({ name, size, type, lastModified }) {
  const fileId = generateUUID();
  const totalChunks = Math.ceil(size / STORAGE_CHUNK_SIZE);
  
  return {
    fileId,
    name,
    size,
    type,
    lastModified,
    chunkSize: STORAGE_CHUNK_SIZE,
    totalChunks,
    createdAt: Date.now(),
  };
}

/**
 * Save file metadata to database
 * 
 * @param {Object} fileMeta - File metadata
 * @returns {Promise<Object>} Saved metadata
 */
export async function saveFileMetadata(fileMeta) {
  return metadataRepository.saveFile(fileMeta);
}

/**
 * Create transfer record
 * 
 * @param {Object} options - Transfer options
 * @param {string} options.transferId - Transfer ID
 * @param {Object} options.fileMeta - File metadata
 * @param {string} options.peerId - Peer ID
 * @returns {Promise<Object>} Transfer record
 */
export async function createTransferRecord({ transferId, fileMeta, peerId }) {
  const record = {
    transferId: transferId || generateUUID(),
    fileId: fileMeta.fileId,
    fileName: fileMeta.name,
    size: fileMeta.size,
    chunkSize: fileMeta.chunkSize,
    totalChunks: fileMeta.totalChunks,
    sentChunks: 0,
    receivedChunks: 0,
    status: 'pending', // pending | in-progress | completed | cancelled
    peerId: peerId || null,
    createdAt: Date.now(),
  };
  
  await transfersRepository.save(record);
  return record;
}

/**
 * Update transfer progress
 * 
 * @param {string} transferId - Transfer ID
 * @param {Object} patch - Progress updates
 * @returns {Promise<Object>} Updated record
 */
export async function updateTransferProgress(transferId, patch) {
  return transfersRepository.update(transferId, patch);
}

/**
 * Get file metadata by ID
 * 
 * @param {string} fileId - File ID
 * @returns {Promise<Object|null>} File metadata
 */
export async function getFileMetadata(fileId) {
  return metadataRepository.getFile(fileId);
}

/**
 * Get transfer record by ID
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<Object|null>} Transfer record
 */
export async function getTransferRecord(transferId) {
  return transfersRepository.findById(transferId);
}

export default {
  generateUUID,
  createFileMetadata,
  saveFileMetadata,
  createTransferRecord,
  updateTransferProgress,
  getFileMetadata,
  getTransferRecord,
};
