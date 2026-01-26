import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoomStore } from '../stores/roomStore';
import { initSocket, createRoom } from '../utils/signaling';
import { createTOFUSetup } from '../utils/tofuSecurity';
import logger from '../utils/logger.js';

export default function Home() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  
  const { setSelectedFile, setIsHost, setSecurityPayload, setRoomId } = useRoomStore();

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

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  const handleStartTransfer = async () => {
    const file = fileInputRef.current?.files?.[0];
    
    if (!file) {
      setError('Please select a file first');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Initialize socket connection
      initSocket();
      
      // Create TOFU security setup
      const tofuSetup = await createTOFUSetup();
      
      // Create room on signaling server
      const roomId = await createRoom();
      
      // Store state
      setSelectedFile(file);
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

  const selectedFile = fileInputRef.current?.files?.[0];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-3xl font-light tracking-tight mb-2">
            P2P File Transfer
          </h1>
          <p className="text-zinc-500 text-sm">
            Secure peer-to-peer file sharing
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
          {/* File Input */}
          <div className="mb-6">
            <label 
              htmlFor="file-input"
              className="block w-full cursor-pointer"
            >
              <div className={`
                border-2 border-dashed rounded-xl p-8 text-center transition-all
                ${selectedFile 
                  ? 'border-emerald-600 bg-emerald-950/20' 
                  : 'border-zinc-700 hover:border-zinc-600'
                }
              `}>
                {selectedFile ? (
                  <div>
                    <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-900/50 flex items-center justify-center">
                      <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <p className="text-zinc-100 font-medium truncate mb-1">
                      {selectedFile.name}
                    </p>
                    <p className="text-zinc-500 text-sm">
                      {formatFileSize(selectedFile.size)}
                    </p>
                  </div>
                ) : (
                  <div>
                    <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-zinc-800 flex items-center justify-center">
                      <svg className="w-6 h-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    </div>
                    <p className="text-zinc-400 mb-1">
                      Click to select a file
                    </p>
                    <p className="text-zinc-600 text-sm">
                      or drag and drop
                    </p>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                id="file-input"
                type="file"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-950/50 border border-red-900 rounded-lg">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Start Button */}
          <button
            onClick={handleStartTransfer}
            disabled={isLoading || !selectedFile}
            className={`
              w-full py-4 rounded-xl font-medium transition-all
              ${isLoading || !selectedFile
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
              'Start Transfer'
            )}
          </button>
        </div>

        {/* Analytics Stats */}
        {stats && (
          <div className="mt-8 p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
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

        {/* Footer */}
        <p className="text-center text-zinc-600 text-xs mt-8">
          End-to-end encrypted • No server storage • TOFU verified
        </p>
      </div>
    </div>
  );
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function calculateTotal(dailyStats, field) {
  if (!dailyStats || !Array.isArray(dailyStats)) return 0;
  return dailyStats.reduce((sum, day) => sum + (day[field] || 0), 0);
}
