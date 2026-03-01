/**
 * useRoomState Hook
 * Manages local UI state for the Room page (non-business logic)
 * - Activity logs
 * - Copy state (clipboard)
 * - Pending file information
 * - Awaiting save location state
 * - Download results
 * - Recoverable transfers
 */
import { useState, useCallback } from 'react';
import logger from '../../../utils/logger.js';

export function useRoomState() {
  // Activity log
  const [logs, setLogs] = useState([]);
  
  // Share URL copy state
  const [copied, setCopied] = useState(false);
  
  // Incoming file state
  const [pendingFile, setPendingFile] = useState(null);
  const [awaitingSaveLocation, setAwaitingSaveLocation] = useState(false);
  const [downloadResult, setDownloadResult] = useState(null);
  
  // Crash recovery
  const [recoverableTransfers, setRecoverableTransfers] = useState([]);

  /**
   * Add a log entry to the activity feed
   * @param {string} message - Log message
   * @param {'info' | 'success' | 'warning' | 'error'} type - Log type
   */
  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-50), { timestamp, message, type }]);
    logger.log(`[Room] ${message}`);
  }, []);

  /**
   * Copy text to clipboard and show confirmation
   * @param {string} text - Text to copy
   */
  const handleCopy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      addLog('Copy failed', 'error');
    }
  }, [addLog]);

  /**
   * Set pending file metadata (before save location selected)
   * @param {Object} fileData - File metadata
   */
  const setPendingFileData = useCallback((fileData) => {
    setPendingFile(fileData);
    setAwaitingSaveLocation(true);
  }, []);

  /**
   * Clear pending file state after save location selected
   */
  const clearPendingFile = useCallback(() => {
    setAwaitingSaveLocation(false);
  }, []);

  /**
   * Reset all UI transfer state for re-transfer
   */
  const resetUiTransferState = useCallback(() => {
    setPendingFile(null);
    setAwaitingSaveLocation(false);
    setDownloadResult(null);
  }, []);

  /**
   * Set download result after transfer complete
   * @param {Object} result - Download result
   */
  const setDownloadResultData = useCallback((result) => {
    setDownloadResult(result);
  }, []);

  /**
   * Add a recoverable transfer to the list
   * @param {Object} transfer - Transfer data
   */
  const addRecoverableTransfer = useCallback((transfer) => {
    setRecoverableTransfers(prev => [...prev, transfer]);
  }, []);

  /**
   * Remove a recoverable transfer from the list
   * @param {string} transferId - Transfer ID to remove
   */
  const removeRecoverableTransfer = useCallback((transferId) => {
    setRecoverableTransfers(prev => prev.filter(t => t.transferId !== transferId));
  }, []);

  return {
    // Activity logs
    logs,
    addLog,
    
    // Copy state
    copied,
    handleCopy,
    
    // Pending file state
    pendingFile,
    awaitingSaveLocation,
    setPendingFileData,
    clearPendingFile,
    resetUiTransferState,
    
    // Download results
    downloadResult,
    setDownloadResultData,
    
    // Crash recovery
    recoverableTransfers,
    addRecoverableTransfer,
    removeRecoverableTransfer,
  };
}
