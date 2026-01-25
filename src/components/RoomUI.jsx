/**
 * Room UI Components
 */

import { useState } from 'react';
import { getQRCodeUrl } from '../utils/qrCode';

// Format bytes to human readable
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Info row for connection/transfer info panels
export function InfoRow({ label, value, status = 'default' }) {
  const statusColors = {
    success: 'text-emerald-400',
    error: 'text-red-400',
    warning: 'text-amber-400',
    default: 'text-zinc-300',
  };

  return (
    <div className="flex justify-between py-1 border-b border-zinc-800 last:border-0">
      <span className="text-zinc-500">{label}</span>
      <span className={`truncate ml-2 max-w-30 ${statusColors[status]}`}>{value}</span>
    </div>
  );
}

// Connection status indicators
export function StatusSection({ socketConnected, dataChannelReady, tofuVerified, tofuStatus }) {
  const statuses = [
    {
      label: 'Socket',
      done: socketConnected,
      active: !socketConnected,
    },
    {
      label: 'P2P',
      done: dataChannelReady,
      active: socketConnected && !dataChannelReady,
    },
    {
      label: 'Verified',
      done: tofuVerified,
      active: tofuStatus === 'verifying',
      failed: tofuStatus === 'failed',
    },
  ];

  return (
    <div className="flex justify-between">
      {statuses.map((status, i) => (
        <div key={status.label} className="flex items-center gap-2">
          <div className={`
            w-3 h-3 rounded-full transition-all
            ${status.done 
              ? 'bg-emerald-500' 
              : status.active 
                ? 'bg-amber-500 animate-pulse' 
                : status.failed 
                  ? 'bg-red-500' 
                  : 'bg-zinc-700'
            }
          `} />
          <span className="text-sm text-zinc-400">{status.label}</span>
          {i < statuses.length - 1 && (
            <div className="w-8 h-px bg-zinc-800 ml-2" />
          )}
        </div>
      ))}
    </div>
  );
}

// File info display
export function FileInfo({ file }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-zinc-700 flex items-center justify-center shrink-0">
        <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-zinc-100 font-medium truncate">{file.name}</p>
        <p className="text-zinc-500 text-sm">{formatBytes(file.size)}</p>
      </div>
    </div>
  );
}

// Transfer progress bar
export function TransferProgress({ progress, state, speed, eta }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-between text-sm">
        <span className="text-zinc-400">
          {state === 'transferring' ? 'Transferring...' : 
           state === 'preparing' ? 'Preparing...' :
           state === 'completed' ? 'Complete!' : 'Idle'}
        </span>
        <span className="text-zinc-300 font-mono">{progress}%</span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div 
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{speed ? `${formatBytes(speed)}/s` : 'Starting...'}</span>
        <span>{eta ? `ETA: ${Math.round(eta)}s` : ''}</span>
      </div>
    </div>
  );
}

// Share URL input with copy button and QR code
export function ShareUrlBox({ url, onCopy, copied }) {
  const [showQR, setShowQR] = useState(false);
  
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm text-zinc-400">Share this link:</label>
        <button
          onClick={() => setShowQR(!showQR)}
          className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors text-zinc-400"
        >
          {showQR ? 'Hide QR' : 'Show QR'}
        </button>
      </div>
      
      {showQR && url && (
        <div className="flex justify-center py-3">
          <div className="p-2 bg-white rounded-lg">
            <img 
              src={getQRCodeUrl(url, 150)} 
              alt="Scan to join room"
              width={150}
              height={150}
              className="block"
            />
          </div>
        </div>
      )}
      
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          readOnly
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs font-mono text-zinc-300 truncate"
        />
        <button
          onClick={onCopy}
          className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg transition-colors text-sm"
        >
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// Incoming file prompt
export function IncomingFilePrompt({ file, onAccept }) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-amber-950/30 border border-amber-900/50 rounded-xl">
        <h3 className="font-medium text-amber-400 mb-2">Incoming File</h3>
        <p className="text-zinc-300">{file.name}</p>
        <p className="text-zinc-500 text-sm">{formatBytes(file.size)}</p>
      </div>
      <button
        onClick={onAccept}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-medium transition-colors"
      >
        Choose Save Location & Start
      </button>
      <p className="text-xs text-zinc-500 text-center">
        For large files, choose a save location for direct disk writing
      </p>
    </div>
  );
}

// Transfer complete success message
export function TransferComplete({ isHost, savedToFileSystem, fileName, onDownload }) {
  return (
    <div className="p-4 bg-emerald-950/30 border border-emerald-900/50 rounded-xl text-center">
      <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-900/50 flex items-center justify-center">
        <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <p className="text-emerald-400 font-medium">Transfer Complete!</p>
      {savedToFileSystem && (
        <p className="text-zinc-500 text-sm mt-1">File saved to disk</p>
      )}
      {!isHost && !savedToFileSystem && onDownload && (
        <button
          onClick={onDownload}
          className="w-full mt-4 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-medium transition-colors"
        >
          Download {fileName}
        </button>
      )}
    </div>
  );
}

// Pause/Resume button for transfers - minimal icon-only design
export function PauseResumeButton({ isPaused, onPause, onResume, disabled = false }) {
  return (
    <button
      onClick={isPaused ? onResume : onPause}
      disabled={disabled}
      title={isPaused ? 'Resume' : 'Pause'}
      className={`
        w-9 h-9 flex items-center justify-center rounded-lg transition-all
        ${disabled 
          ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' 
          : isPaused 
            ? 'bg-zinc-800 hover:bg-zinc-700 text-emerald-400' 
            : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
        }
      `}
    >
      {isPaused ? (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z"/>
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
        </svg>
      )}
    </button>
  );
}

// Transfer progress with pause/resume controls
export function TransferProgressWithControls({ 
  progress, 
  state, 
  speed, 
  eta, 
  isPaused,
  onPause,
  onResume,
  onCancel
}) {
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-zinc-400 text-sm">
          {isPaused ? 'Paused' :
           state === 'sending' ? 'Sending...' :
           state === 'receiving' ? 'Receiving...' : 
           state === 'preparing' ? 'Preparing...' :
           state === 'completed' ? 'Complete!' : 'Transferring...'}
        </span>
        <span className="text-zinc-300 font-mono text-sm">{progress}%</span>
      </div>
      
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div 
          className={`h-full transition-all duration-300 ${isPaused ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          {isPaused ? 'Paused' : speed ? `${formatBytes(speed)}/s` : 'Starting...'}
          {!isPaused && eta ? ` • ${Math.round(eta)}s left` : ''}
        </span>
        
        <div className="flex gap-1.5">
          <PauseResumeButton 
            isPaused={isPaused} 
            onPause={onPause} 
            onResume={onResume}
            disabled={state === 'completed'}
          />
          {onCancel && state !== 'completed' && (
            <button
              onClick={onCancel}
              title="Cancel"
              className="w-9 h-9 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-red-400 rounded-lg transition-all"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Crash recovery prompt dialog
export function CrashRecoveryPrompt({ 
  transfers, 
  onResume, 
  onDiscard, 
  onSelectFile 
}) {
  if (!transfers || transfers.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 max-w-md w-full p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-amber-900/50 flex items-center justify-center">
            <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-zinc-100">Recover Transfers</h3>
            <p className="text-sm text-zinc-400">
              Found {transfers.length} incomplete transfer{transfers.length > 1 ? 's' : ''}
            </p>
          </div>
        </div>

        <div className="space-y-3 max-h-64 overflow-y-auto">
          {transfers.map((transfer) => (
            <div 
              key={transfer.transferId} 
              className="p-3 bg-zinc-800 rounded-xl space-y-2"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <p className="text-zinc-200 font-medium truncate">{transfer.fileName}</p>
                  <p className="text-xs text-zinc-500">
                    {formatBytes(transfer.fileSize)} • {transfer.percentComplete}% complete
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${
                  transfer.role === 'sender' ? 'bg-blue-900/50 text-blue-400' : 'bg-purple-900/50 text-purple-400'
                }`}>
                  {transfer.role === 'sender' ? 'Sending' : 'Receiving'}
                </span>
              </div>

              <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-amber-500"
                  style={{ width: `${transfer.percentComplete}%` }}
                />
              </div>

              <div className="flex gap-2 pt-1">
                {transfer.requiresFileReselection ? (
                  <button
                    onClick={() => onSelectFile(transfer.transferId)}
                    className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition-colors"
                  >
                    Select File & Resume
                  </button>
                ) : (
                  <button
                    onClick={() => onResume(transfer.transferId)}
                    className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition-colors"
                  >
                    Resume
                  </button>
                )}
                <button
                  onClick={() => onDiscard(transfer.transferId)}
                  className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition-colors"
                >
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => transfers.forEach(t => onDiscard(t.transferId))}
          className="w-full py-2 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          Discard All
        </button>
      </div>
    </div>
  );
}

// Activity log display
export function ActivityLog({ logs }) {
  return (
    <div className="h-48 overflow-y-auto space-y-1 font-mono text-xs">
      {logs.length === 0 ? (
        <p className="text-zinc-600">No activity yet...</p>
      ) : (
        logs.map((log, i) => (
          <div key={i} className={`flex gap-2 ${
            log.type === 'error' ? 'text-red-400' :
            log.type === 'success' ? 'text-emerald-400' :
            log.type === 'warning' ? 'text-amber-400' :
            'text-zinc-500'
          }`}>
            <span className="text-zinc-600 shrink-0">{log.timestamp}</span>
            <span className="break-all">{log.message}</span>
          </div>
        ))
      )}
    </div>
  );
}

// Error display
export function ErrorDisplay({ error }) {
  if (!error) return null;
  
  return (
    <div className="p-3 bg-red-950/50 border border-red-900 rounded-lg">
      <p className="text-red-400 text-sm">{error}</p>
    </div>
  );
}

// Connection info panel
export function ConnectionInfoPanel({ info }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <InfoRow label="Socket" value={info.socketConnected ? 'Connected' : 'Disconnected'} 
               status={info.socketConnected ? 'success' : 'error'} />
      <InfoRow label="Socket ID" value={info.socketId?.slice(0, 12) || '-'} />
      <InfoRow label="ICE State" value={info.iceState} 
               status={info.iceState === 'connected' ? 'success' : 'default'} />
      <InfoRow label="Signaling" value={info.signalingState} />
      <InfoRow label="RTC State" value={info.rtcState}
               status={info.rtcState === 'connected' ? 'success' : 'default'} />
      <InfoRow label="Data Channel" value={info.dataChannelState}
               status={info.dataChannelState === 'open' ? 'success' : 'default'} />
      <InfoRow label="RTT" value={`${info.rtt}ms`} />
      <InfoRow label="Packet Loss" value={`${info.packetLoss}%`} />
    </div>
  );
}

// Transfer info panel with pause state
export function TransferInfoPanel({ info }) {
  if (!info.fileName) return null;
  
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <InfoRow label="File" value={info.fileName} />
      <InfoRow label="Size" value={formatBytes(info.fileSize)} />
      <InfoRow label="Progress" value={`${info.progress}%`} />
      <InfoRow label="Speed" value={info.isPaused ? 'Paused' : info.speed ? `${formatBytes(info.speed)}/s` : '-'} 
               status={info.isPaused ? 'warning' : 'default'} />
      <InfoRow label="ETA" value={info.isPaused ? '-' : info.eta ? `${Math.round(info.eta)}s` : '-'} />
      <InfoRow label="Status" value={info.isPaused ? 'Paused' : 'Active'} 
               status={info.isPaused ? 'warning' : 'success'} />
    </div>
  );
}
