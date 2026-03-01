/**
 * Assembly Engine (Receiver Side)
 * 
 * Receives chunks, validates checksums, buffers to storage size,
 * and writes to file using File System Access API.
 * 
 * Complements ChunkingEngine on the receiver side.
 * 
 * Two-step initialization:
 *   1. initializeReceive(metadata)  — set up state, progress, validator (no user prompt)
 *   2. setupFileWriter(transferId, fileName) — prompt user for save location
 */

import { initFileWriter, writeChunk as writeFileChunk, completeWriter, cancelWriter } from '../../infrastructure/storage/FileWriter.js';
import logger from '../../utils/logger.js';
import { progressTracker } from '../shared/ProgressTracker.js';
import { chunkValidator } from './ChunkValidator.js';
import { STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { ValidationError } from '../../lib/errors.js';

export class AssemblyEngine {
  constructor() {
    this.activeAssemblies = new Map(); // transferId -> assembly state
    this.receiveBuffers = new Map(); // transferId -> receive buffer
    this.fileWriters = new Map(); // transferId -> FileWriter instance

    // Event callbacks (set by consumer)
    this.onComplete = null; // (transferId, result) => void
    this.onError = null;    // (transferId, error) => void
  }

  /**
   * Step 1: Initialize receive state (no user prompt).
   * Called when file-metadata arrives from sender.
   * 
   * @param {Object} metadata
   * @param {string} metadata.transferId
   * @param {string} metadata.name
   * @param {number} metadata.size
   * @param {string} [metadata.mimeType]
   * @param {number} [metadata.totalChunks]
   */
  async initializeReceive({ transferId, name, size, mimeType, totalChunks: providedTotalChunks }) {
    const totalChunks = providedTotalChunks || Math.ceil(size / STORAGE_CHUNK_SIZE);

    // Initialize progress tracking
    progressTracker.initialize(transferId, {
      totalChunks,
      fileSize: size,
      fileName: name,
      direction: 'receive',
    });

    // Initialize chunk validator
    chunkValidator.initialize(transferId, totalChunks);

    // Initialize assembly state (file writer comes later in step 2)
    this.activeAssemblies.set(transferId, {
      fileMetadata: { name, size, mimeType },
      receivedChunks: 0,
      totalChunks,
      bytesReceived: 0,
      isComplete: false,
    });

    // Initialize receive buffer
    this.receiveBuffers.set(transferId, {
      buffer: new Uint8Array(STORAGE_CHUNK_SIZE),
      currentSize: 0,
      expectedSize: STORAGE_CHUNK_SIZE,
    });

    logger.log(`[AssemblyEngine] Initialized receive for ${transferId}: ${totalChunks} chunks expected`);
    return { transferId, totalChunks, fileName: name, fileSize: size };
  }

  /**
   * Step 2: Prompt user for save location and set up file writer.
   * Called when user clicks "Select save location".
   * 
   * @param {string} transferId
   * @param {string} fileName
   * @returns {Promise<Object>} Writer info including method used
   */
  async setupFileWriter(transferId, fileName) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new ValidationError(
        `No assembly initialized for transfer ${transferId}`,
        { transferId }
      );
    }

    const writerInfo = await initFileWriter(transferId, fileName, assemblyState.fileMetadata.size);
    this.fileWriters.set(transferId, { transferId, ...writerInfo });

    logger.log(`[AssemblyEngine] File writer ready for ${transferId}`);
    return { ...writerInfo, method: 'file-system-access' };
  }

  /**
   * Legacy one-step init (combines initializeReceive + setupFileWriter).
   * Kept for multi-file path and resume.
   */
  async initializeAssembly(transferId, fileMetadata, peerId) {
    await this.initializeReceive({
      transferId,
      name: fileMetadata.name,
      size: fileMetadata.size,
      mimeType: fileMetadata.type,
    });

    const writerInfo = await this.setupFileWriter(transferId, fileMetadata.name);

    logger.log(`[AssemblyEngine] Full assembly initialized for ${transferId}`);
    return writerInfo;
  }

  /**
   * Receive and process a chunk
   */
  async receiveChunk(transferId, chunkData, chunkMetadata) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new ValidationError(
        `No assembly initialized for transfer ${transferId}`,
        { transferId }
      );
    }

    // Validate the chunk
    const validationResult = chunkValidator.validate(
      transferId, 
      {
        index: chunkMetadata.chunkIndex,
        data: chunkData,
        size: chunkMetadata.size,
        checksum: chunkMetadata.checksum
      },
      assemblyState.totalChunks
    );

    // Skip if duplicate
    if (validationResult.duplicate) {
      logger.log(`[AssemblyEngine] Skipping duplicate chunk ${chunkMetadata.chunkIndex}`);
      return { duplicate: true, chunkIndex: chunkMetadata.chunkIndex };
    }

    // Append to receive buffer and process
    await this._appendToReceiveBuffer(transferId, chunkData, chunkMetadata);

    return {
      success: true,
      chunkIndex: chunkMetadata.chunkIndex,
      ...validationResult
    };
  }

  /**
   * Append to receive buffer and process when complete
   * @private
   */
  async _appendToReceiveBuffer(transferId, chunkData, chunkMetadata) {
    const bufferState = this.receiveBuffers.get(transferId);
    const assemblyState = this.activeAssemblies.get(transferId);

    // Convert to Uint8Array if needed
    const data = chunkData instanceof Uint8Array ? chunkData : new Uint8Array(chunkData);

    // Validate buffer capacity
    if (bufferState.currentSize + data.length > STORAGE_CHUNK_SIZE) {
      throw new ValidationError(
        `Chunk data exceeds storage buffer capacity`,
        { transferId, currentSize: bufferState.currentSize, dataLength: data.length }
      );
    }

    // Append chunk data to buffer
    bufferState.buffer.set(data, bufferState.currentSize);
    bufferState.currentSize += data.length;

    // Check if storage chunk is complete
    const isComplete = chunkMetadata.isFinal || 
                      bufferState.currentSize >= STORAGE_CHUNK_SIZE ||
                      bufferState.currentSize >= bufferState.expectedSize;

    if (isComplete) {
      // Get actual data from buffer
      const actualData = bufferState.buffer.slice(0, bufferState.currentSize);

      // Calculate and validate checksum
      const calculatedChecksum = await this._calculateChecksum(actualData);
      if (calculatedChecksum !== chunkMetadata.checksum) {
        throw new ValidationError(
          `Checksum validation failed for chunk ${chunkMetadata.chunkIndex}`,
          { transferId, chunkIndex: chunkMetadata.chunkIndex, expected: chunkMetadata.checksum, actual: calculatedChecksum }
        );
      }

      // Write to file using functional FileWriter API (handles sequential writing and queuing)
      await writeFileChunk(transferId, chunkMetadata.chunkIndex, actualData);

      // Update progress
      assemblyState.bytesReceived += bufferState.currentSize;
      assemblyState.receivedChunks++;
      
      // Update progress tracker (canonical progress — bitmap tracking is handled by useTransferTracking)
      progressTracker.updateChunk(transferId, chunkMetadata.chunkIndex, bufferState.currentSize);

      // Reset buffer
      bufferState.currentSize = 0;

      // Check if file transfer is complete
      if (chunkMetadata.isFinal) {
        await this._completeAssembly(transferId);
      }
    }
  }

  /**
   * Calculate SHA-256 checksum
   * @private
   */
  async _calculateChecksum(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Complete file assembly
   * @private
   */
  async _completeAssembly(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    
    // Complete the file writing using functional API
    const result = await completeWriter(transferId);
    
    // Update progress tracker
    progressTracker.updateStatus(transferId, 'completed');
    
    // Mark as complete
    assemblyState.isComplete = true;

    logger.log(`[AssemblyEngine] File assembly complete: ${result.fileSize} bytes received`);

    // Notify consumer
    if (this.onComplete) this.onComplete(transferId, result);

    return result;
  }

  /**
   * Get assembly progress
   */
  getProgress(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) return null;

    return {
      bytesReceived: assemblyState.bytesReceived,
      totalBytes: assemblyState.fileMetadata.size,
      chunksReceived: assemblyState.receivedChunks,
      totalChunks: assemblyState.totalChunks,
      isComplete: assemblyState.isComplete,
      percentage: (assemblyState.receivedChunks / assemblyState.totalChunks) * 100
    };
  }

  /**
   * Resume assembly from existing chunks
   */
  async resumeAssembly(transferId, completedChunkIndices) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) {
      throw new Error(`No assembly state found for transfer ${transferId}`);
    }

    // Mark chunks as already received
    chunkValidator.markReceived(transferId, completedChunkIndices);
    
    // Update assembly state
    assemblyState.receivedChunks = completedChunkIndices.length;
    assemblyState.bytesReceived = completedChunkIndices.length * STORAGE_CHUNK_SIZE;

    logger.log(`[AssemblyEngine] Resumed assembly for ${transferId}: ${completedChunkIndices.length} chunks already received`);
    
    return {
      transferId,
      resumedChunks: completedChunkIndices.length,
      totalChunks: assemblyState.totalChunks,
      remainingChunks: assemblyState.totalChunks - completedChunkIndices.length
    };
  }

  /**
   * Get missing chunks for retransmission
   */
  getMissingChunks(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    if (!assemblyState) return [];

    return chunkValidator.getMissingChunks(transferId, assemblyState.totalChunks);
  }

  /**
   * Cleanup assembly state
   */
  async cleanup(transferId) {
    try {
      await cancelWriter(transferId);
    } catch (err) {
      logger.warn(`[AssemblyEngine] Error cleaning up file writer for ${transferId}:`, err);
    }
    
    this.activeAssemblies.delete(transferId);
    this.receiveBuffers.delete(transferId);
    this.fileWriters.delete(transferId);
    chunkValidator.clear(transferId);
    progressTracker.clear(transferId);
    
    logger.log(`[AssemblyEngine] Cleaned up assembly state for ${transferId}`);
  }
}

// Export singleton instance
export const assemblyEngine = new AssemblyEngine();
