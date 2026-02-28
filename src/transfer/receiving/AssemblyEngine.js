/**
 * Assembly Engine (Receiver Side)
 * 
 * Receives chunks, validates checksums, buffers to storage size,
 * and writes to file using File System Access API.
 * 
 * Complements ChunkingEngine on the receiver side.
 */

import { saveChunkMeta } from '../../infrastructure/database/chunks.repository.js';
import { createTransferRecord, updateTransferProgress } from '../metadata/fileMetadata.js';
import { FileWriter } from '../../infrastructure/storage/FileWriter.js';
import logger from '../../utils/logger.js';
import { progressTracker } from '../shared/ProgressTracker.js';
import { chunkValidator } from './ChunkValidator.js';
import { NETWORK_CHUNK_SIZE, STORAGE_CHUNK_SIZE } from '../../constants/transfer.constants.js';
import { ValidationError } from '../../lib/errors.js';

export class AssemblyEngine {
  constructor() {
    this.activeAssemblies = new Map(); // transferId -> assembly state
    this.receiveBuffers = new Map(); // transferId -> receive buffer
    this.fileWriters = new Map(); // transferId -> FileWriter instance
  }

  /**
   * Initialize assembly for a transfer
   */
  async initializeAssembly(transferId, fileMetadata, peerId) {
    // Create transfer record
    const transferRecord = await createTransferRecord({ 
      transferId, 
      fileMeta: fileMetadata, 
      peerId 
    });
    
    const totalChunks = Math.ceil(fileMetadata.size / STORAGE_CHUNK_SIZE);
    
    // Initialize progress tracking
    progressTracker.initialize(transferId, {
      totalChunks,
      fileSize: fileMetadata.size,
      fileName: fileMetadata.name,
      direction: 'receive'
    });

    // Initialize chunk validator
    chunkValidator.initialize(transferId, totalChunks);

    // Initialize file writer
    const fileWriter = new FileWriter(transferId, fileMetadata.name, fileMetadata.size);
    await fileWriter.initialize();
    this.fileWriters.set(transferId, fileWriter);
    
    // Initialize assembly state
    this.activeAssemblies.set(transferId, {
      fileWriter,
      fileMetadata,
      transferRecord,
      receivedChunks: 0,
      totalChunks,
      bytesReceived: 0,
      isComplete: false,
      currentFileChunkIndex: 0 // Track network-sized chunks for file writing
    });

    // Initialize receive buffer
    this.receiveBuffers.set(transferId, {
      buffer: new Uint8Array(STORAGE_CHUNK_SIZE),
      currentSize: 0,
      expectedSize: STORAGE_CHUNK_SIZE
    });
    
    logger.log(`[AssemblyEngine] Initialized assembly for ${transferId}: ${totalChunks} chunks expected`);
    return fileWriter;
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
    const fileWriter = this.fileWriters.get(transferId);

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

      // Store validated chunk metadata in IndexedDB
      await this._storeValidatedChunk(transferId, chunkMetadata);

      // Write to file using FileWriter (handles sequential writing and queuing)
      await fileWriter.writeChunk(chunkMetadata.chunkIndex, actualData);

      // Update progress
      assemblyState.bytesReceived += bufferState.currentSize;
      assemblyState.receivedChunks++;
      
      // Update progress tracker
      progressTracker.updateChunk(transferId, chunkMetadata.chunkIndex, bufferState.currentSize);

      // Update transfer progress in metadata
      await updateTransferProgress(transferId, {
        receivedChunks: assemblyState.receivedChunks,
        status: 'in-progress'
      });

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
   * Store validated chunk in IndexedDB
   * @private
   */
  async _storeValidatedChunk(transferId, chunkMetadata) {
    await saveChunkMeta({
      transferId: chunkMetadata.transferId,
      chunkIndex: chunkMetadata.chunkIndex,
      size: chunkMetadata.size,
      checksum: chunkMetadata.checksum,
      timestamp: chunkMetadata.timestamp,
      isFinal: chunkMetadata.isFinal,
      fileOffset: chunkMetadata.fileOffset,
      status: 'received',
      validated: true,
      receivedAt: Date.now()
    });
  }

  /**
   * Complete file assembly
   * @private
   */
  async _completeAssembly(transferId) {
    const assemblyState = this.activeAssemblies.get(transferId);
    const fileWriter = this.fileWriters.get(transferId);
    
    // Complete the file writing
    const result = await fileWriter.complete();
    
    // Update transfer record
    await updateTransferProgress(transferId, {
      status: 'completed',
      receivedChunks: assemblyState.totalChunks,
      completedAt: Date.now()
    });
    
    // Update progress tracker
    progressTracker.updateStatus(transferId, 'completed');
    
    // Mark as complete
    assemblyState.isComplete = true;

    logger.log(`[AssemblyEngine] File assembly complete: ${result.fileSize} bytes received`);
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
    const fileWriter = this.fileWriters.get(transferId);
    if (fileWriter) {
      try {
        await fileWriter.close();
      } catch (err) {
        logger.warn(`[AssemblyEngine] Error closing file writer for ${transferId}:`, err);
      }
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
