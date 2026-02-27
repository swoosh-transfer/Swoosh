/**
 * Transfer Module - Public API
 * 
 * Main entry point for file transfer operations.
 * Provides high-level functions for sending and receiving files.
 */

import { chunkingEngine } from './sending/ChunkingEngine.js';
import { assemblyEngine } from './receiving/AssemblyEngine.js';
import { progressTracker } from './shared/ProgressTracker.js';
import { chunkValidator } from './receiving/ChunkValidator.js';
import { 
  resumableTransferManager,
  TransferState,
  TransferRole 
} from './resumption/ResumableTransferManager.js';
import { 
  createFileMetadata, 
  saveFileMetadata, 
  createTransferRecord,
  generateUUID 
} from './metadata/fileMetadata.js';
import { chunksRepository } from '../infrastructure/database/chunks.repository.js';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Create a unique transfer ID
 */
export async function createTransferId() {
  return generateUUID();
}

// ============================================================================
// SENDER-SIDE OPERATIONS
// ============================================================================

/**
 * Initialize a file transfer (sender side)
 * 
 * @param {File} file - File to send
 * @param {string} peerId - Receiver peer ID
 * @returns {Promise<Object>} Transfer information
 */
export async function initializeFileTransfer(file, peerId) {
  const transferId = await createTransferId();
  
  // Create file metadata
  const fileMetadata = createFileMetadata({
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified
  });
  
  await saveFileMetadata(fileMetadata);
  const transferRecord = await createTransferRecord({ 
    transferId, 
    fileMeta: fileMetadata, 
    peerId 
  });
  
  return {
    transferId,
    fileMetadata,
    transferRecord
  };
}

/**
 * Start file chunking process (with optional resume)
 * 
 * @param {string} transferId - Transfer ID
 * @param {File} file - File to chunk
 * @param {string} peerId - Receiver peer ID
 * @param {Function} onChunkReady - Callback for each chunk
 * @param {number} [resumeFromChunk=0] - Chunk to resume from
 * @returns {Promise<void>}
 */
export async function startFileChunking(transferId, file, peerId, onChunkReady, resumeFromChunk = 0) {
  return await chunkingEngine.startChunking(transferId, file, peerId, onChunkReady, resumeFromChunk);
}

/**
 * Pause file chunking
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<boolean>} Success status
 */
export async function pauseChunking(transferId) {
  return await chunkingEngine.pause(transferId);
}

/**
 * Resume file chunking
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<boolean>} Success status
 */
export async function resumeChunking(transferId) {
  return await chunkingEngine.resume(transferId);
}

/**
 * Check if chunking is paused
 * 
 * @param {string} transferId - Transfer ID
 * @returns {boolean} True if paused
 */
export function isChunkingPaused(transferId) {
  return chunkingEngine.isPaused(transferId);
}

/**
 * Get chunking pause state
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Object} Pause state
 */
export function getChunkingPauseState(transferId) {
  return chunkingEngine.getPauseState(transferId);
}

/**
 * Retransmit specific chunks
 * 
 * @param {string} transferId - Transfer ID
 * @param {number[]} chunkIndices - Chunk indices to retransmit
 * @param {File} file - Original file
 * @param {Function} onChunkReady - Callback for each chunk
 * @returns {Promise<Object>} Retransmission results
 */
export async function retransmitChunks(transferId, chunkIndices, file, onChunkReady) {
  return await chunkingEngine.retransmitChunks(transferId, chunkIndices, file, onChunkReady);
}

// ============================================================================
// RECEIVER-SIDE OPERATIONS
// ============================================================================

/**
 * Initialize file reception (receiver side)
 * 
 * @param {string} transferId - Transfer ID
 * @param {Object} fileMetadata - File metadata from sender
 * @param {string} peerId - Sender peer ID
 * @returns {Promise<Object>} File writer instance
 */
export async function initializeFileReception(transferId, fileMetadata, peerId) {
  return await assemblyEngine.initializeAssembly(transferId, fileMetadata, peerId);
}

/**
 * Process received chunk
 * 
 * @param {string} transferId - Transfer ID
 * @param {ArrayBuffer} chunkData - Chunk data
 * @param {Object} chunkMetadata - Chunk metadata
 * @returns {Promise<Object>} Processing result
 */
export async function processReceivedChunk(transferId, chunkData, chunkMetadata) {
  return await assemblyEngine.receiveChunk(transferId, chunkData, chunkMetadata);
}

/**
 * Get missing chunks for retransmission
 * 
 * @param {string} transferId - Transfer ID
 * @returns {number[]} Array of missing chunk indices
 */
export function getMissingChunks(transferId) {
  return assemblyEngine.getMissingChunks(transferId);
}

// ============================================================================
// PROGRESS TRACKING
// ============================================================================

/**
 * Get transfer progress (combined chunking and assembly)
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Object|null} Progress information
 */
export function getTransferProgress(transferId) {
  return progressTracker.getProgress(transferId);
}

/**
 * Subscribe to progress updates
 * 
 * @param {string} transferId - Transfer ID
 * @param {Function} callback - Callback receiving progress updates
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProgress(transferId, callback) {
  return progressTracker.subscribe(transferId, callback);
}

/**
 * Get all active transfers progress
 * 
 * @returns {Object[]} Array of progress objects
 */
export function getAllProgress() {
  return progressTracker.getAllProgress();
}

// ============================================================================
// RESUME & RECOVERY
// ============================================================================

/**
 * Resume transfer from existing chunks
 * 
 * @param {string} transferId - Transfer ID
 * @returns {Promise<Object>} Resume information
 */
export async function resumeTransfer(transferId) {
  const chunks = await chunksRepository.findByTransferId(transferId);
  const completedChunks = chunks.filter(chunk => 
    chunk.status === 'received' && chunk.validated
  );
  
  return {
    transferId,
    completedChunks: completedChunks.length,
    totalChunks: chunks.length,
    canResume: completedChunks.length > 0
  };
}

/**
 * Check for recoverable transfers (crash recovery)
 * 
 * @returns {Promise<Object[]>} Array of recoverable transfers
 */
export async function checkForRecoverableTransfers() {
  return await resumableTransferManager.checkForRecoverableTransfers();
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up completed or cancelled transfer
 * 
 * @param {string} transferId - Transfer ID
 * @param {boolean} [deleteMetadata=false] - Whether to delete metadata
 * @returns {Promise<void>}
 */
export async function cleanupTransfer(transferId, deleteMetadata = false) {
  // Clean up chunking engine
  chunkingEngine.cleanup(transferId);
  
  // Clean up assembly engine
  await assemblyEngine.cleanup(transferId);
  
  if (deleteMetadata) {
    await resumableTransferManager.cancelTransfer(transferId, true);
  }
}

/**
 * Clean up old completed/cancelled transfers
 * 
 * @param {number} [maxAge] - Maximum age in milliseconds
 * @returns {Promise<number>} Number of cleaned transfers
 */
export async function cleanupOldTransfers(maxAge) {
  return await resumableTransferManager.cleanupOldTransfers(maxAge);
}

// ============================================================================
// EXPORTS
// ============================================================================

// Export classes for advanced usage
export { ChunkingEngine } from './sending/ChunkingEngine.js';
export { AssemblyEngine } from './receiving/AssemblyEngine.js';
export { ProgressTracker } from './shared/ProgressTracker.js';
export { ChunkValidator } from './receiving/ChunkValidator.js';
export { ResumableTransferManager, TransferState, TransferRole } from './resumption/ResumableTransferManager.js';

// Export singletons
export { 
  chunkingEngine, 
  assemblyEngine, 
  progressTracker, 
  chunkValidator,
  resumableTransferManager 
};
