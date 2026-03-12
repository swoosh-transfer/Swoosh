import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoomStore } from '../stores/roomStore';
import { initSocket, waitForConnection, createRoom } from '../utils/signaling';
import { createTOFUSetup } from '../utils/tofuSecurity';
import FileDropZone from '../components/FileDropZone';
import logger from '../utils/logger.js';
import { formatBytes } from '../lib/formatters';
import {
  listTransfers,
  deleteTransfer,
  cleanupOldTransfers,
} from '../infrastructure/database/transfers.repository.js';
import {
  deleteChunksByTransfer,
} from '../infrastructure/database/chunks.repository.js';
import {
  deserializeBitmap,
  getCompletedCount,
} from '../infrastructure/database/chunkBitmap.js';
import {
  loadUserSettings,
  saveUserSettings,
  resetUserSettings,
  isConstrainedMobileEnvironment,
} from '../constants/transfer.constants.js';

export default function Home() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [incompleteTransfers, setIncompleteTransfers] = useState([]);
  
  const { selectedFiles, addFiles, removeFile, clearFiles, setSelectedFiles, setIsHost, setSecurityPayload, setRoomId, setResumeContext, resetRoom, roomId: staleRoomId } = useRoomStore();

  // Clear leftover room state when Home mounts (handles browser back, URL navigation, etc.
  // without breaking React StrictMode like an unmount cleanup in Room would)
  useEffect(() => {
    if (staleRoomId) {
      resetRoom();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Settings panel state ──────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(loadUserSettings);
  const isMobile = isConstrainedMobileEnvironment();

  const updateSetting = (key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      saveUserSettings({ [key]: value });
      return next;
    });
  };

  const handleResetSettings = () => {
    resetUserSettings();
    setSettings(loadUserSettings());
  };

  useEffect(() => {
    // Fetch analytics data
    const fetchAnalytics = async () => {
      try {
        const baseUrl = (import.meta.env.VITE_API_URL || window.location.origin || 'http://localhost:5000').trim().replace(/\/$/, '');
        const url = `${baseUrl}/api/analytics/summary?days=7`;
        logger.info('Fetching analytics from:', url);
        const response = await fetch(url, { mode: 'cors' });
        if (response.ok) {
          const data = await response.json();
          logger.info('Analytics data:', data);
          setStats(data);
        } else {
          logger.warn('Analytics fetch failed:', response.status);
        }
      } catch (err) {
        logger.info('Analytics unavailable:', err.message);
      }
    };
    
    fetchAnalytics();
  }, []);

  // Check IndexedDB for incomplete transfers on mount
  useEffect(() => {
    let cancelled = false;
    async function loadIncomplete() {
      try {
        // Auto-discard stale transfers older than 7 days
        await cleanupOldTransfers();

        const transfers = await listTransfers();
        const incomplete = transfers.filter(
          (t) => (t.status === 'interrupted' || t.status === 'paused') &&
            t.direction !== 'receiving' // Only show sender-side transfers — receivers can't resume from Home
        );
        if (cancelled) return;

        // Build UI-friendly list with progress info
        const items = [];
        const seenFiles = new Set(); // Track unique file names to prevent duplicates
        
        for (const t of incomplete) {
          // Only surface transfers with real progress
          if (t.lastChunkIndex > 0 || t.lastProgress > 0 || t.chunkBitmap || t.fileBitmaps) {
            if (cancelled) return;

            // For multi-file transfers, show each file separately
            if (t.fileManifest && Array.isArray(t.fileManifest)) {
              for (const fileInfo of t.fileManifest) {
                // Use only fileName to deduplicate (not transferId)
                if (seenFiles.has(fileInfo.fileName)) continue; // Skip duplicates
                
                // Calculate progress for this specific file
                let fileProgress = 0;
                if (t.fileBitmaps && t.fileBitmaps[fileInfo.fileName]) {
                  try {
                    const bitmap = deserializeBitmap(t.fileBitmaps[fileInfo.fileName]);
                    const completedChunks = getCompletedCount(bitmap);
                    fileProgress = Math.round((completedChunks / (fileInfo.totalChunks || 1)) * 100);
                  } catch (err) {
                    logger.warn('Failed to deserialize file bitmap:', err.message);
                  }
                }
                
                seenFiles.add(fileInfo.fileName);
                items.push({
                  transferId: t.transferId,
                  fileName: fileInfo.fileName,
                  fileSize: fileInfo.fileSize,
                  direction: t.direction,
                  progress: fileProgress,
                  totalChunks: fileInfo.totalChunks,
                  chunkBitmap: null,
                  fileManifest: t.fileManifest,
                  fileHash: t.fileHash || null,
                  createdAt: t.createdAt,
                  roomId: t.roomId,
                });
              }
            } else {
              // Single-file transfer - deduplicate by fileName only
              if (seenFiles.has(t.fileName)) continue; // Skip duplicates

              // Calculate progress from bitmap when lastProgress is stale/missing
              let progress = t.lastProgress || 0;

              if (t.chunkBitmap && t.totalChunks > 0) {
                try {
                  const bitmap = deserializeBitmap(t.chunkBitmap);
                  const completedChunks = getCompletedCount(bitmap);
                  const bitmapProgress = Math.round((completedChunks / t.totalChunks) * 100);
                  // Use the higher of the two — bitmap is more accurate
                  if (bitmapProgress > progress) {
                    progress = bitmapProgress;
                  }
                } catch (err) {
                  logger.warn('Failed to deserialize chunkBitmap:', err.message);
                }
              }

              seenFiles.add(t.fileName);
              items.push({
                transferId: t.transferId,
                fileName: t.fileName,
                fileSize: t.fileSize,
                direction: t.direction,
                progress,
                totalChunks: t.totalChunks,
                chunkBitmap: t.chunkBitmap || null,
                fileManifest: t.fileManifest || null,
                fileHash: t.fileHash || null,
                createdAt: t.createdAt,
                roomId: t.roomId,
              });
            }
          }
        }
        setIncompleteTransfers(items);
      } catch (err) {
        logger.warn('Failed to load incomplete transfers:', err.message);
      }
    }
    loadIncomplete();
    return () => { cancelled = true; };
  }, []);

  const handleFilesAdded = (newFiles) => {
    addFiles(newFiles);
    setError(null);
  };

  const handleDiscardIncomplete = async (transferId) => {
    try {
      await deleteChunksByTransfer(transferId);
      await deleteTransfer(transferId);
      setIncompleteTransfers(prev => prev.filter(t => t.transferId !== transferId));
    } catch (err) {
      logger.warn('Failed to discard transfer:', err.message);
    }
  };

  // ── Resume Flow ───────────────────────────────────────────────────
  const resumeFileInputRef = useRef(null);
  const [pendingResumeTransfer, setPendingResumeTransfer] = useState(null);
  const [resumeError, setResumeError] = useState(null);

  /**
   * Handle clicking "Resume" on a send-direction failed transfer.
   * Opens a file picker for re-selecting the file, then validates and navigates.
   */
  const handleResumeSend = (transfer) => {
    setPendingResumeTransfer(transfer);
    setResumeError(null);
    // Trigger hidden file input
    if (resumeFileInputRef.current) {
      resumeFileInputRef.current.click();
    }
  };

  /**
   * Handle file re-selection for send-side resume.
   * Validates file matches saved metadata, then navigates to new room.
   */
  const handleResumeFileSelected = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !pendingResumeTransfer) {
      setPendingResumeTransfer(null);
      return;
    }

    const transfer = pendingResumeTransfer;

    // Validate file matches saved metadata
    if (file.name !== transfer.fileName) {
      setResumeError(`File name mismatch: expected "${transfer.fileName}", got "${file.name}". Please select the original file.`);
      setPendingResumeTransfer(null);
      return;
    }

    if (file.size !== transfer.fileSize) {
      setResumeError(`File size mismatch: expected ${formatFileSize(transfer.fileSize)}, got ${formatFileSize(file.size)}. Please select the original file.`);
      setPendingResumeTransfer(null);
      return;
    }

    // File matches — create room with resume context
    await navigateToResumeRoom(transfer, file);
    setPendingResumeTransfer(null);
  };

  /**
   * Handle clicking "Resume" on a receive-direction failed transfer.
   * Navigates directly to a new room with resume context.
   */
  const handleResumeReceive = async (transfer) => {
    setResumeError(null);
    await navigateToResumeRoom(transfer, null);
  };

  /**
   * Navigate to a new room with resume context.
   */
  const navigateToResumeRoom = async (transfer, file) => {
    setIsLoading(true);
    setError(null);

    try {
      initSocket();
      await waitForConnection();

      const tofuSetup = await createTOFUSetup();
      const roomData = await createRoom();
      const roomId = typeof roomData === 'object' ? roomData.roomId : roomData;

      // Set resume context in store
      setResumeContext({
        transferId: transfer.transferId,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        totalChunks: transfer.totalChunks,
        chunkBitmap: transfer.chunkBitmap || null,
        direction: transfer.direction,
        fileManifest: transfer.fileManifest || null,
        progress: transfer.progress,
      });

      if (file) {
        setSelectedFiles([{ file, relativePath: null }]);
      }

      setIsHost(true);
      setRoomId(roomId);
      setSecurityPayload({
        secret: tofuSetup.secret,
        peerID: tofuSetup.peerID,
      });

      navigate(`/${roomId}#${btoa(JSON.stringify({
        secret: tofuSetup.secret,
        peerID: tofuSetup.peerID,
        timestamp: Date.now(),
      }))}`);
    } catch (err) {
      logger.error('Failed to create resume room:', err);
      setError(err.message || 'Failed to create room for resume');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDiscardAll = async () => {
    for (const t of incompleteTransfers) {
      try {
        await deleteChunksByTransfer(t.transferId);
        await deleteTransfer(t.transferId);
      } catch (err) {
        logger.warn('Failed to discard transfer:', err.message);
      }
    }
    setIncompleteTransfers([]);
  };

  const handleStartTransfer = async () => {
    if (!selectedFiles || selectedFiles.length === 0) {
      setError('Please select at least one file');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Initialize socket connection
      initSocket();
      await waitForConnection();
      
      // Create TOFU security setup
      const tofuSetup = await createTOFUSetup();
      
      // Create room on signaling server
      const roomData = await createRoom();
      const roomId = typeof roomData === 'object' ? roomData.roomId : roomData;
      
      // Store state
      setSelectedFiles(selectedFiles);
      setIsHost(true);
      setRoomId(roomId);
      setSecurityPayload({
        secret: tofuSetup.secret,
        peerID: tofuSetup.peerID,
      });

      // Generate the share URL with security token in fragment
      const shareUrl = tofuSetup.createURL(`${window.location.origin}/${roomId}`);
      
      // Navigate to room with security info in hash
      navigate(`/${roomId}#${btoa(JSON.stringify({
        secret: tofuSetup.secret,
        peerID: tofuSetup.peerID,
        timestamp: Date.now(),
      }))}`);
      
    } catch (err) {
      logger.error('Failed to start transfer:', err);
      setError(err.message || 'Failed to create room');
    } finally {
      setIsLoading(false);
    }
  };

  const selectedFile = selectedFiles.length > 0 ? selectedFiles[0].file : null;
  const hasFiles = selectedFiles.length > 0;
  const totalSize = selectedFiles.reduce((s, f) => s + f.file.size, 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Swoosh
            </h1>
            <p className="text-zinc-500 text-xs mt-0.5">
              Peer-to-peer file transfer
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Transfer Settings"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <a
              href="https://github.com/swoosh-transfer/Swoosh"
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
            title="View on GitHub"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
          </a>
          </div>
        </div>

        {/* Main Transfer Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 overflow-hidden">

          {/* Incomplete Files Recovery */}
          {incompleteTransfers.length > 0 && (
            <div className="mb-4 p-3 bg-amber-950/30 border border-amber-800/50 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-amber-200">
                  {incompleteTransfers.length} Incomplete
                </h3>
                {incompleteTransfers.length > 1 && (
                  <button
                    onClick={handleDiscardAll}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Discard All
                  </button>
                )}
              </div>
              {resumeError && (
                <div className="p-1.5 bg-red-950/50 border border-red-900/50 rounded">
                  <p className="text-[10px] text-red-400">{resumeError}</p>
                </div>
              )}
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {incompleteTransfers.map((t) => (
                  <div key={t.transferId} className="flex items-center gap-2 p-1.5 bg-zinc-900/60 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-zinc-300 truncate">{t.fileName}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500" style={{ width: `${t.progress}%` }} />
                        </div>
                        <span className="text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">
                          {t.progress}% · {formatFileSize(t.fileSize)}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => t.direction === 'sending' ? handleResumeSend(t) : handleResumeReceive(t)}
                      disabled={isLoading}
                      className="px-2 py-0.5 text-[10px] bg-emerald-900/50 text-emerald-400 hover:bg-emerald-800/50 rounded transition-colors disabled:opacity-50"
                    >
                      Resume
                    </button>
                    <button
                      onClick={() => handleDiscardIncomplete(t.transferId)}
                      className="p-0.5 text-zinc-600 hover:text-red-400 transition-colors"
                      title="Discard"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
              <input
                ref={resumeFileInputRef}
                type="file"
                className="hidden"
                onChange={handleResumeFileSelected}
              />
            </div>
          )}
          {/* File Input */}
          <div className="mb-4">
            <FileDropZone
              files={selectedFiles}
              onFilesAdded={handleFilesAdded}
              onFileRemoved={(idx) => removeFile(idx)}
              onFilesCleared={() => clearFiles()}
              disabled={isLoading}
            />
          </div>

          {/* Large file / folder warning */}
          {hasFiles && (selectedFiles.some(f => f.file.size > 100 * 1024 * 1024) || selectedFiles.length > 5) && (
            <div className="mb-3 p-2.5 bg-amber-950/40 border border-amber-700/50 rounded-lg">
              <p className="text-xs text-amber-300">
                <strong>Tip:</strong> Compress {selectedFiles.length > 5 ? 'many files' : 'large files'} into a ZIP before sending for better speed and reliability.
              </p>
            </div>
          )}

          {/* Start Button */}
          <button
            onClick={handleStartTransfer}
            disabled={isLoading || !hasFiles}
            className={`
              w-full py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2
              ${isLoading || !hasFiles
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-emerald-600 text-white hover:bg-emerald-500 active:scale-[0.98] active:bg-emerald-700'
              }
            `}
          >
            {isLoading ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Creating Room...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                {`Send${selectedFiles.length > 1 ? ` ${selectedFiles.length} Files` : ''}`}
              </>
            )}
          </button>

          {/* Error Message */}
          {error && (
            <div className="mt-3 p-2.5 bg-red-950/50 border border-red-900 rounded-lg">
              <p className="text-red-400 text-xs">{error}</p>
            </div>
          )}
        </div>

        {/* Security Features — compact horizontal strip */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { icon: 'M13 10V3L4 14h7v7l9-11h-7z', label: 'Peer-to-Peer', sub: 'No servers' },
            { icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', label: 'Encrypted', sub: 'DTLS/WebRTC' },
            { icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', label: 'TOFU Verified', sub: 'Anti-MITM' },
            { icon: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16', label: 'Zero Storage', sub: 'Nothing saved' },
          ].map((f) => (
            <div key={f.label} className="flex items-center gap-2 px-3 py-2.5 bg-zinc-900/60 border border-zinc-800/60 rounded-lg">
              <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={f.icon} />
              </svg>
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-300 leading-tight">{f.label}</p>
                <p className="text-[10px] text-zinc-600 leading-tight">{f.sub}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Analytics Stats — subtle footer */}
        {stats && (
          <div className="mt-4 flex items-center justify-center gap-6 text-center">
            <div>
              <span className="text-sm font-medium text-emerald-400">{formatNumber(calculateTotal(stats.dailyStats, 'transfersCompleted'))}</span>
              <span className="text-[10px] text-zinc-600 ml-1">transfers</span>
            </div>
            <div className="w-px h-3 bg-zinc-800" />
            <div>
              <span className="text-sm font-medium text-emerald-400">{formatBytes(calculateTotal(stats.dailyStats, 'totalBytesTransferred'))}</span>
              <span className="text-[10px] text-zinc-600 ml-1">shared</span>
            </div>
            <div className="w-px h-3 bg-zinc-800" />
            <div>
              <span className="text-sm font-medium text-emerald-400">{formatNumber(calculateTotal(stats.dailyStats, 'roomsCompleted'))}</span>
              <span className="text-[10px] text-zinc-600 ml-1">rooms</span>
            </div>
          </div>
        )}

        {/* Privacy note */}
        <p className="mt-4 text-center text-[10px] text-zinc-700">
          No personal data or file contents are ever stored. Anonymous usage stats only.
        </p>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 rounded-t-2xl z-10">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Transfer Settings</h2>
                <p className="text-[10px] text-zinc-500 mt-0.5">
                  Device: {isMobile ? 'Mobile' : 'Desktop'} &middot; Changes apply on next transfer
                </p>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Desktop Settings */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Desktop Profile</h3>
                <SettingSlider
                  label="Chunk Size"
                  unit="KB"
                  value={settings.chunkSizeKB}
                  min={16} max={256} step={16}
                  onChange={v => updateSetting('chunkSizeKB', v)}
                  description="Size of each data chunk sent over the network"
                />
                <SettingSlider
                  label="Max Channels"
                  unit=""
                  value={settings.maxChannels}
                  min={1} max={16} step={1}
                  onChange={v => updateSetting('maxChannels', v)}
                  description="Maximum parallel data channels"
                />
                <SettingSlider
                  label="Buffer Watermark"
                  unit="KB"
                  value={settings.bufferWatermarkKB}
                  min={64} max={1024} step={64}
                  onChange={v => updateSetting('bufferWatermarkKB', v)}
                  description="Buffer threshold before pausing sends"
                />
                <SettingSlider
                  label="Scale Interval"
                  unit="ms"
                  value={settings.scaleIntervalMs}
                  min={500} max={10000} step={500}
                  onChange={v => updateSetting('scaleIntervalMs', v)}
                  description="How often to evaluate adding channels"
                />
                <SettingSlider
                  label="Scale-Up Threshold"
                  unit="KB/s"
                  value={settings.scaleUpThresholdKBs}
                  min={100} max={5000} step={100}
                  onChange={v => updateSetting('scaleUpThresholdKBs', v)}
                  description="Minimum throughput to trigger new channel"
                />
              </div>

              {/* Mobile Settings */}
              <div className="space-y-3 pt-2 border-t border-zinc-800">
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Mobile Profile</h3>
                <SettingSlider
                  label="Chunk Size"
                  unit="KB"
                  value={settings.mobileChunkSizeKB}
                  min={8} max={128} step={8}
                  onChange={v => updateSetting('mobileChunkSizeKB', v)}
                  description="Smaller chunks reduce memory pressure on mobile"
                />
                <SettingSlider
                  label="Max Channels"
                  unit=""
                  value={settings.mobileMaxChannels}
                  min={1} max={8} step={1}
                  onChange={v => updateSetting('mobileMaxChannels', v)}
                  description="More channels = faster, but uses more memory"
                />
                <SettingSlider
                  label="Buffer Watermark"
                  unit="KB"
                  value={settings.mobileBufferWatermarkKB}
                  min={32} max={512} step={32}
                  onChange={v => updateSetting('mobileBufferWatermarkKB', v)}
                  description="Higher = faster but may overwhelm slow devices"
                />
                <SettingSlider
                  label="Scale Interval"
                  unit="ms"
                  value={settings.mobileScaleIntervalMs}
                  min={500} max={10000} step={500}
                  onChange={v => updateSetting('mobileScaleIntervalMs', v)}
                  description="How often to evaluate adding channels on mobile"
                />
              </div>

              {/* Force Desktop Profile */}
              <div className="pt-2 border-t border-zinc-800">
                <label className="flex items-center justify-between cursor-pointer group">
                  <div>
                    <span className="text-xs text-zinc-300 group-hover:text-zinc-100 transition-colors">Force Desktop Profile on Mobile</span>
                    <p className="text-[10px] text-zinc-600 mt-0.5">Use desktop settings even on mobile devices</p>
                  </div>
                  <div
                    onClick={() => updateSetting('forceDesktopProfile', !settings.forceDesktopProfile)}
                    className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${settings.forceDesktopProfile ? 'bg-blue-600' : 'bg-zinc-700'}`}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${settings.forceDesktopProfile ? 'translate-x-4' : ''}`} />
                  </div>
                </label>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2 border-t border-zinc-800">
                <button
                  onClick={handleResetSettings}
                  className="flex-1 px-3 py-2 text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
                >
                  Reset to Defaults
                </button>
                <button
                  onClick={() => setShowSettings(false)}
                  className="flex-1 px-3 py-2 text-xs font-medium text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function calculateTotal(dailyStats, field) {
  if (!dailyStats || !Array.isArray(dailyStats)) return 0;
  return dailyStats.reduce((sum, day) => sum + (day[field] || 0), 0);
}

function SettingSlider({ label, unit, value, min, max, step, onChange, description }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-zinc-300">{label}</label>
        <span className="text-xs font-mono text-zinc-400">{value}{unit ? ` ${unit}` : ''}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer accent-blue-500
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500
          [&::-webkit-slider-thumb]:hover:bg-blue-400 [&::-webkit-slider-thumb]:transition-colors"
      />
      <div className="flex justify-between text-[9px] text-zinc-600">
        <span>{min}{unit ? ` ${unit}` : ''}</span>
        <span>{description}</span>
        <span>{max}{unit ? ` ${unit}` : ''}</span>
      </div>
    </div>
  );
}