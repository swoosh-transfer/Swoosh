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

export default function Home() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [incompleteTransfers, setIncompleteTransfers] = useState([]);
  
  const { selectedFiles, addFiles, removeFile, clearFiles, setSelectedFiles, setIsHost, setSecurityPayload, setRoomId, setResumeContext } = useRoomStore();

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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4 lg:p-8">
      <div className="w-full max-w-6xl">
        {/* GitHub Link - Top Right */}
        <div className="absolute top-4 right-4 lg:top-8 lg:right-8">
          <a 
            href="https://github.com/swoosh-transfer" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 rounded-lg transition-all group"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            <span className="text-sm font-medium hidden lg:inline">View Source</span>
            <svg className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>

        {/* Header */}
        <div className="text-center mb-8 lg:mb-10">
          <h1 className="text-3xl font-light tracking-tight mb-2">
            P2P File Transfer
          </h1>
          <p className="text-zinc-500 text-sm">
            Secure peer-to-peer file sharing
          </p>
        </div>

        {/* Two Column Layout on Large Screens */}
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
          
          {/* Security Section - Left on Large, Bottom on Small */}
          <div className="order-2 lg:order-1 w-full lg:w-96 lg:shrink-0">
            <div className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <h2 className="text-lg font-medium text-zinc-100 mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                More Secure Than Any Platform
              </h2>
              
              <div className="space-y-3 mb-4">
                <div className="flex gap-3">
                  <div className="mt-1">
                    <svg className="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-zinc-200">True Peer-to-Peer</h3>
                    <p className="text-xs text-zinc-500 mt-1">Direct connection between devices. Files never touch our servers.</p>
                  </div>
                </div>
                
                <div className="flex gap-3">
                  <div className="mt-1">
                    <svg className="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-zinc-200">End-to-End Encrypted</h3>
                    <p className="text-xs text-zinc-500 mt-1">WebRTC with DTLS encryption. Only sender and receiver can access files.</p>
                  </div>
                </div>
                
                <div className="flex gap-3">
                  <div className="mt-1">
                    <svg className="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-zinc-200">TOFU Security Model</h3>
                    <p className="text-xs text-zinc-500 mt-1">Trust-On-First-Use verification prevents man-in-the-middle attacks.</p>
                  </div>
                </div>
                
                <div className="flex gap-3">
                  <div className="mt-1">
                    <svg className="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-zinc-200">Zero Server Storage</h3>
                    <p className="text-xs text-zinc-500 mt-1">Files stream directly between peers. No cloud storage, no data retention.</p>
                  </div>
                </div>
              </div>

              {/* Analytics Transparency */}
              <div className="pt-4 border-t border-zinc-800">
                <h3 className="text-xs font-medium text-zinc-400 mb-2">Analytics Transparency</h3>
                <p className="text-xs text-zinc-500 leading-relaxed mb-2">
                  We collect anonymous usage statistics (transfer counts, data volumes, room completions) to improve our service. 
                  <span className="text-zinc-400 font-medium"> No personal data, file contents, or identifiable information is ever stored.</span>
                </p>
                <p className="text-xs text-zinc-600">
                  Analytics are purely statistical and pose no security or privacy risk.
                </p>
              </div>
            </div>
          </div>

          {/* Main Transfer Card - Right on Large, Top on Small */}
          <div className="order-1 lg:order-2 w-full lg:flex-1 lg:max-w-2xl">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 overflow-hidden">

          {/* Incomplete Files Recovery */}
          {incompleteTransfers.length > 0 && (
            <div className="mb-6 p-4 bg-amber-950/30 border border-amber-800/50 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <h3 className="text-sm font-semibold text-amber-200">
                    {incompleteTransfers.length} Incomplete File{incompleteTransfers.length > 1 ? 's' : ''}
                  </h3>
                </div>
                {incompleteTransfers.length > 1 && (
                  <button
                    onClick={handleDiscardAll}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Discard All
                  </button>
                )}
              </div>
              <p className="text-xs text-zinc-400">
                These files were interrupted. Click Resume to continue, or Discard to remove.
              </p>
              {resumeError && (
                <div className="p-2 bg-red-950/50 border border-red-900/50 rounded-lg">
                  <p className="text-xs text-red-400">{resumeError}</p>
                </div>
              )}
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {incompleteTransfers.map((t) => (
                  <div key={t.transferId} className="flex items-center gap-3 p-2 bg-zinc-900/60 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{t.fileName}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500" style={{ width: `${t.progress}%` }} />
                        </div>
                        <span className="text-xs text-zinc-500 tabular-nums whitespace-nowrap">
                          {t.progress}% • {formatFileSize(t.fileSize)}
                        </span>
                      </div>
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      t.direction === 'sending' ? 'bg-blue-900/50 text-blue-400' : 'bg-purple-900/50 text-purple-400'
                    }`}>
                      {t.direction === 'sending' ? 'Send' : 'Recv'}
                    </span>
                    <button
                      onClick={() => t.direction === 'sending' ? handleResumeSend(t) : handleResumeReceive(t)}
                      disabled={isLoading}
                      className="px-2 py-1 text-xs bg-emerald-900/50 text-emerald-400 hover:bg-emerald-800/50 rounded transition-colors disabled:opacity-50"
                      title="Resume transfer"
                    >
                      Resume
                    </button>
                    <button
                      onClick={() => handleDiscardIncomplete(t.transferId)}
                      className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                      title="Discard"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
              {/* Hidden file input for sender-side resume file re-selection */}
              <input
                ref={resumeFileInputRef}
                type="file"
                className="hidden"
                onChange={handleResumeFileSelected}
              />
            </div>
          )}
          {/* File Input */}
          <div className="mb-6">
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
            <div className="mb-4 p-3 bg-amber-950/40 border border-amber-700/50 rounded-lg">
              <p className="text-sm text-amber-300">
                ⚠️ <strong>Recommendation:</strong> For {selectedFiles.length > 5 ? 'many files or folders' : 'large files'}, compress them into a ZIP/RAR archive before sending.
                This significantly reduces transfer time, improves reliability, and keeps folder structure intact.
              </p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-950/50 border border-red-900 rounded-lg">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Start Button */}
          <button
            onClick={handleStartTransfer}
            disabled={isLoading || !hasFiles}
            className={`
              w-full py-4 rounded-xl font-medium transition-all
              ${isLoading || !hasFiles
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-zinc-100 text-zinc-900 hover:bg-white active:scale-[0.98]'
              }
            `}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Creating Room...
              </span>
            ) : (
              `Start Transfer${selectedFiles.length > 1 ? ` (${selectedFiles.length} files)` : ''}`
            )}
          </button>

          {/* Analytics Stats */}
          {stats && (
            <div className="mt-6 p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-light text-emerald-400">
                    {formatNumber(calculateTotal(stats.dailyStats, 'transfersCompleted'))}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">Transfers</div>
                </div>
                <div>
                  <div className="text-2xl font-light text-emerald-400">
                    {formatBytes(calculateTotal(stats.dailyStats, 'totalBytesTransferred'))}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">Data Shared</div>
                </div>
                <div>
                  <div className="text-2xl font-light text-emerald-400">
                    {formatNumber(calculateTotal(stats.dailyStats, 'roomsCompleted'))}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">Rooms</div>
                </div>
              </div>
              <div className="text-center mt-3 text-xs text-zinc-600">
                {stats.period || 'Last 7 days'}
              </div>
            </div>
          )}
        </div>
          </div>
        </div>
      </div>
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