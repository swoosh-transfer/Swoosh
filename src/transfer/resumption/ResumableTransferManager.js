/**
 * Resumable Transfer Manager
 * 
 * Handles pause/resume functionality and crash recovery for file transfers.
 * Coordinates transfer state across sender and receiver.
 * 
 * Uses repository pattern to avoid circular dependencies.
 */

import { transfersRepository } from '../../infrastructure/database/transfers.repository.js';
import { chunksRepository } from '../../infrastructure/database/chunks.repository.js';
import logger from '../../utils/logger.js';

// Transfer states
export const TransferState = {
  PENDING: 'pending',
  ACTIVE: 'active',
  PAUSED: 'paused',
  RESUMING: 'resuming',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// Transfer roles
export const TransferRole = {
  SENDER: 'sender',
  RECEIVER: 'receiver'
};

/**
 * ResumableTransferManager - Manages pause/resume and crash recovery
 */
class ResumableTransferManager {
  constructor() {
    this.pausedTransfers = new Map(); // transferId -> pause state
    this.transferCallbacks = new Map(); // transferId -> { onPause, onResume, onCancel }
    this.fileReferences = new Map(); // transferId -> File reference (sender only)
    this.resumePromises = new Map(); // transferId -> resolve function for resume
  }

  /**
   * Register a transfer for pause/resume capability
   */
  async registerTransfer(options) {
    const {
      transferId,
      role, // 'sender' or 'receiver'
      fileName,
      fileSize,
      totalChunks,
      peerId,
      file = null, // File object for sender
      onPause = null,
      onResume = null,
      onCancel = null
    } = options;

    const transferMeta = {
      transferId,
      role,
      fileName,
      fileSize,
      totalChunks,
      peerId,
      status: TransferState.ACTIVE,
      chunksProcessed: 0,
      bytesProcessed: 0,
      lastChunkIndex: -1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pausedAt: null,
      resumedAt: null,
      // Store file info for crash recovery (sender)
      fileInfo: file ? {
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified
      } : null
    };

    await transfersRepository.save(transferMeta);

    // Store file reference in memory (for pause/resume without crash)
    if (file) {
      this.fileReferences.set(transferId, file);
    }

    // Store callbacks
    if (onPause || onResume || onCancel) {
      this.transferCallbacks.set(transferId, { onPause, onResume, onCancel });
    }

    logger.log(`[ResumableTransfer] Registered ${role} transfer: ${transferId}`);
    return transferMeta;
  }

  /**
   * Pause a transfer
   */
  async pauseTransfer(transferId) {
    const meta = await transfersRepository.findById(transferId);
    if (!meta) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    if (meta.status === TransferState.PAUSED) {
      logger.log(`[ResumableTransfer] Transfer ${transferId} already paused`);
      return meta;
    }

    if (meta.status !== TransferState.ACTIVE) {
      throw new Error(`Cannot pause transfer in state: ${meta.status}`);
    }

    // Create pause state
    const pauseState = {
      pausedAt: Date.now(),
      lastChunkIndex: meta.lastChunkIndex,
      bytesProcessed: meta.bytesProcessed,
      chunksProcessed: meta.chunksProcessed
    };

    this.pausedTransfers.set(transferId, pauseState);

    // Update transfer metadata
    await transfersRepository.update(transferId, {
      status: TransferState.PAUSED,
      pausedAt: pauseState.pausedAt,
      updatedAt: Date.now()
    });

    // Trigger callback
    const callbacks = this.transferCallbacks.get(transferId);
    if (callbacks?.onPause) {
      await callbacks.onPause(pauseState);
    }

    logger.log(`[ResumableTransfer] Paused transfer: ${transferId} at chunk ${meta.lastChunkIndex}`);
    return pauseState;
  }

  /**
   * Resume a paused transfer
   */
  async resumeTransfer(transferId, file = null) {
    const meta = await transfersRepository.findById(transferId);
    if (!meta) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    if (meta.status !== TransferState.PAUSED && meta.status !== TransferState.ACTIVE) {
      throw new Error(`Cannot resume transfer in state: ${meta.status}`);
    }

    // For sender, validate file if provided
    if (meta.role === TransferRole.SENDER && file) {
      if (meta.fileInfo) {
        if (file.name !== meta.fileInfo.name || 
            file.size !== meta.fileInfo.size ||
            file.lastModified !== meta.fileInfo.lastModified) {
          throw new Error('File does not match the original transfer file');
        }
      }
      this.fileReferences.set(transferId, file);
    }

    // Get completed chunks
    const chunks = await chunksRepository.findByTransferId(transferId);
    const completedChunks = chunks.filter(c => 
      c.status === 'sent' || c.status === 'received'
    );

    // Calculate resume point
    const resumeState = {
      transferId,
      role: meta.role,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      totalChunks: meta.totalChunks,
      completedChunks: completedChunks.length,
      lastChunkIndex: meta.lastChunkIndex,
      bytesProcessed: meta.bytesProcessed,
      resumeFromChunk: meta.lastChunkIndex + 1,
      file: this.fileReferences.get(transferId) || null,
      pauseDuration: meta.pausedAt ? Date.now() - meta.pausedAt : 0
    };

    // Update transfer metadata
    await transfersRepository.update(transferId, {
      status: TransferState.RESUMING,
      resumedAt: Date.now(),
      updatedAt: Date.now()
    });

    this.pausedTransfers.delete(transferId);

    // Trigger callback
    const callbacks = this.transferCallbacks.get(transferId);
    if (callbacks?.onResume) {
      await callbacks.onResume(resumeState);
    }

    logger.log(`[ResumableTransfer] Resuming transfer: ${transferId} from chunk ${resumeState.resumeFromChunk}`);
    return resumeState;
  }

  /**
   * Update transfer progress
   */
  async updateProgress(transferId, progress) {
    const { chunkIndex, bytesProcessed, status = TransferState.ACTIVE } = progress;

    await transfersRepository.update(transferId, {
      lastChunkIndex: chunkIndex,
      bytesProcessed,
      chunksProcessed: chunkIndex + 1,
      status,
      updatedAt: Date.now()
    });
  }

  /**
   * Mark transfer as complete
   */
  async completeTransfer(transferId) {
    await transfersRepository.update(transferId, {
      status: TransferState.COMPLETED,
      completedAt: Date.now(),
      updatedAt: Date.now()
    });

    // Cleanup
    this.pausedTransfers.delete(transferId);
    this.transferCallbacks.delete(transferId);
    this.fileReferences.delete(transferId);
    this.resumePromises.delete(transferId);

    logger.log(`[ResumableTransfer] Completed transfer: ${transferId}`);
  }

  /**
   * Cancel a transfer
   */
  async cancelTransfer(transferId, cleanup = false) {
    const callbacks = this.transferCallbacks.get(transferId);
    if (callbacks?.onCancel) {
      await callbacks.onCancel();
    }

    await transfersRepository.update(transferId, {
      status: TransferState.CANCELLED,
      cancelledAt: Date.now(),
      updatedAt: Date.now()
    });

    // Cleanup
    this.pausedTransfers.delete(transferId);
    this.transferCallbacks.delete(transferId);
    this.fileReferences.delete(transferId);
    this.resumePromises.delete(transferId);

    if (cleanup) {
      await chunksRepository.deleteByTransferId(transferId);
      await transfersRepository.delete(transferId);
    }

    logger.log(`[ResumableTransfer] Cancelled transfer: ${transferId}`);
  }

  /**
   * Check if transfer is paused
   */
  isPaused(transferId) {
    return this.pausedTransfers.has(transferId);
  }

  /**
   * Get transfer state
   */
  async getTransferState(transferId) {
    return await transfersRepository.findById(transferId);
  }

  /**
   * Check for incomplete transfers (crash recovery)
   */
  async checkForRecoverableTransfers() {
    const allTransfers = await transfersRepository.findAll();
    
    const recoverable = allTransfers.filter(t => 
      t.status === TransferState.ACTIVE || 
      t.status === TransferState.PAUSED ||
      t.status === TransferState.RESUMING
    );

    // Enrich with chunk data
    const enriched = await Promise.all(recoverable.map(async (transfer) => {
      const chunks = await chunksRepository.findByTransferId(transfer.transferId);
      const completedChunks = chunks.filter(c => 
        c.status === 'sent' || c.status === 'received'
      );
      
      return {
        ...transfer,
        completedChunks: completedChunks.length,
        percentComplete: Math.round((completedChunks.length / transfer.totalChunks) * 100),
        canResume: true,
        requiresFileReselection: transfer.role === TransferRole.SENDER
      };
    }));

    logger.log(`[ResumableTransfer] Found ${enriched.length} recoverable transfers`);
    return enriched;
  }

  /**
   * Clear old completed/cancelled transfers
   */
  async cleanupOldTransfers(maxAge = 24 * 60 * 60 * 1000) {
    const allTransfers = await transfersRepository.findAll();
    const now = Date.now();
    
    const toCleanup = allTransfers.filter(t => 
      (t.status === TransferState.COMPLETED || t.status === TransferState.CANCELLED) &&
      (now - (t.completedAt || t.cancelledAt || t.updatedAt)) > maxAge
    );

    for (const transfer of toCleanup) {
      await chunksRepository.deleteByTransferId(transfer.transferId);
      await transfersRepository.delete(transfer.transferId);
    }

    logger.log(`[ResumableTransfer] Cleaned up ${toCleanup.length} old transfers`);
    return toCleanup.length;
  }

  /**
   * Create a pause-aware chunk iterator for sender
   */
  createPauseAwareIterator(transferId, startChunk = 0) {
    const self = this;
    
    return {
      currentChunk: startChunk,
      
      async shouldContinue() {
        // Check if paused
        if (self.isPaused(transferId)) {
          logger.log(`[ResumableTransfer] Transfer ${transferId} is paused, waiting...`);
          
          // Wait for resume
          await new Promise((resolve) => {
            self.resumePromises.set(transferId, resolve);
          });
          
          logger.log(`[ResumableTransfer] Transfer ${transferId} resumed`);
        }
        
        // Check if cancelled
        const meta = await self.getTransferState(transferId);
        return meta?.status !== TransferState.CANCELLED;
      },
      
      next() {
        return this.currentChunk++;
      }
    };
  }

  /**
   * Signal resume to waiting iterators
   */
  signalResume(transferId) {
    const resolve = this.resumePromises.get(transferId);
    if (resolve) {
      resolve();
      this.resumePromises.delete(transferId);
    }
  }
}

// Singleton instance
export const resumableTransferManager = new ResumableTransferManager();

// Helper functions for easier access
export async function registerTransfer(options) {
  return resumableTransferManager.registerTransfer(options);
}

export async function pauseTransfer(transferId) {
  return resumableTransferManager.pauseTransfer(transferId);
}

export async function resumeTransfer(transferId, file = null) {
  const result = await resumableTransferManager.resumeTransfer(transferId, file);
  resumableTransferManager.signalResume(transferId);
  return result;
}

export async function updateTransferProgress(transferId, progress) {
  return resumableTransferManager.updateProgress(transferId, progress);
}

export async function completeTransfer(transferId) {
  return resumableTransferManager.completeTransfer(transferId);
}

export async function cancelTransfer(transferId, cleanup = false) {
  return resumableTransferManager.cancelTransfer(transferId, cleanup);
}

export function isPaused(transferId) {
  return resumableTransferManager.isPaused(transferId);
}

export async function getTransferState(transferId) {
  return resumableTransferManager.getTransferState(transferId);
}

export async function checkForRecoverableTransfers() {
  return resumableTransferManager.checkForRecoverableTransfers();
}

export async function cleanupOldTransfers(maxAge) {
  return resumableTransferManager.cleanupOldTransfers(maxAge);
}

export function createPauseAwareIterator(transferId, startChunk = 0) {
  return resumableTransferManager.createPauseAwareIterator(transferId, startChunk);
}

export default resumableTransferManager;
