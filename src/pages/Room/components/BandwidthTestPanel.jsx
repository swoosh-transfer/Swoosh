/**
 * BandwidthTestPanel Component
 * 
 * Automatically runs coordinated connection speed test between both peers.
 * Flow: Host sends init → Receiver acks → Both run test
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { BandwidthTester, getConnectionType } from '../../../utils/bandwidthTester.js';
import { formatBytes } from '../../../lib/formatters.js';

// Track which channels have been initiated (persists across remounts)
const initiatedChannels = new WeakSet();

/**
 * Format duration in human-readable form
 */
function formatDuration(seconds) {
  if (!seconds || seconds === Infinity) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Quality badge colors
 */
const qualityColors = {
  excellent: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  good: 'bg-green-500/20 text-green-400 border-green-500/30',
  fair: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  poor: 'bg-red-500/20 text-red-400 border-red-500/30',
};

export function BandwidthTestPanel({
  dataChannel,
  peerConnection,
  totalFileSize = 0,
  onTestComplete,
  isHost = false,
  sendJSON,
}) {
  const [testState, setTestState] = useState('idle'); // idle | waiting | testing | complete | error
  const [testProgress, setTestProgress] = useState(0);
  const [testPhase, setTestPhase] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const testerRef = useRef(null);
  const testStateRef = useRef('idle'); // Track state for timeouts

  // Keep ref in sync with state
  useEffect(() => {
    testStateRef.current = testState;
  }, [testState]);

  // Run the actual speed test
  const runTest = useCallback(async () => {
    if (!dataChannel || dataChannel.readyState !== 'open') {
      setError('Connection not ready');
      setTestState('error');
      return;
    }

    setTestState('testing');
    setTestProgress(0);

    try {
      // Get connection type first
      setTestPhase('detecting');
      setTestProgress(10);
      const connectionType = peerConnection 
        ? await getConnectionType(peerConnection)
        : { type: 'unknown', isRelayed: false };

      // Create tester instance
      const tester = new BandwidthTester(dataChannel, peerConnection);
      testerRef.current = tester;

      const result = await tester.runTest({
        onProgress: (phase, percent) => {
          setTestPhase(phase);
          setTestProgress(percent);
        }
      });

      if (result.status === 'success') {
        setResults(result);
        setTestState('complete');
        onTestComplete?.(result);
      } else {
        setError(result.error || 'Test failed');
        setTestState('error');
      }
    } catch (err) {
      setError(err.message);
      setTestState('error');
    }
  }, [dataChannel, peerConnection, onTestComplete]);

  // Handle incoming bandwidth test messages AND auto-initiate
  useEffect(() => {
    if (!dataChannel || !sendJSON) {
      console.log('[BW-Test] Missing dataChannel or sendJSON');
      return;
    }

    const startTest = () => {
      // Check if already initiated for this channel
      if (initiatedChannels.has(dataChannel)) {
        console.log('[BW-Test] Already initiated for this channel');
        return;
      }

      console.log('[BW-Test] Channel open, starting coordination - isHost:', isHost);
      
      if (isHost) {
        // Host sends init after small delay
        const timer = setTimeout(() => {
          if (initiatedChannels.has(dataChannel)) return;
          initiatedChannels.add(dataChannel);
          console.log('[BW-Test] Host: sending bw-test-init');
          setTestState('waiting');
          sendJSON({ type: 'bw-test-init' });
          
          // Fallback if no ack
          setTimeout(() => {
            if (testStateRef.current === 'waiting') {
              console.log('[BW-Test] Host: no ack, starting test anyway');
              runTest();
            }
          }, 3000);
        }, 500);
        return () => clearTimeout(timer);
      } else {
        // Guest waits for host init
        setTestState('waiting');
        const timer = setTimeout(() => {
          if (testStateRef.current === 'waiting' && !initiatedChannels.has(dataChannel)) {
            initiatedChannels.add(dataChannel);
            console.log('[BW-Test] Guest: no init from host, sending our init');
            sendJSON({ type: 'bw-test-init' });
            
            setTimeout(() => {
              if (testStateRef.current === 'waiting') {
                console.log('[BW-Test] Guest: starting test anyway');
                runTest();
              }
            }, 2000);
          }
        }, 2000);
        return () => clearTimeout(timer);
      }
    };

    const handleMessage = (event) => {
      try {
        if (typeof event.data !== 'string') return;
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'bw-test-init') {
          console.log('[BW-Test] Received init from peer, sending ack');
          initiatedChannels.add(dataChannel);
          sendJSON({ type: 'bw-test-ack' });
          runTest();
        } else if (msg.type === 'bw-test-ack') {
          console.log('[BW-Test] Received ack from peer, starting test');
          runTest();
        }
      } catch {
        // Not for us
      }
    };

    dataChannel.addEventListener('message', handleMessage);

    // Start when channel is open
    let cleanup = null;
    if (dataChannel.readyState === 'open') {
      console.log('[BW-Test] Channel already open');
      if (testState === 'idle') {
        cleanup = startTest();
      }
    } else {
      console.log('[BW-Test] Waiting for channel to open, current state:', dataChannel.readyState);
      const onOpen = () => {
        console.log('[BW-Test] Channel just opened');
        if (testState === 'idle') {
          cleanup = startTest();
        }
      };
      dataChannel.addEventListener('open', onOpen);
      return () => {
        dataChannel.removeEventListener('message', handleMessage);
        dataChannel.removeEventListener('open', onOpen);
        if (cleanup) cleanup();
      };
    }

    return () => {
      dataChannel.removeEventListener('message', handleMessage);
      if (cleanup) cleanup();
    };
  }, [dataChannel, sendJSON, isHost, testState, runTest]);

  const phaseLabels = {
    'detecting': 'Detecting connection...',
    'measuring-latency': 'Measuring latency...',
    'measuring-speed': 'Testing throughput...',
    'calculating': 'Calculating results...',
    'complete': 'Complete',
  };

  // Estimate transfer time if we have results and file size
  const estimatedTime = results && totalFileSize > 0
    ? Math.ceil(totalFileSize / results.bytesPerSecond)
    : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-400">Connection Speed</h3>
        {testState === 'complete' && (
          <button
            onClick={() => { 
              // Clear initiated flag for this channel to allow re-test
              if (dataChannel) initiatedChannels.delete(dataChannel);
              setTestState('idle');
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Re-test
          </button>
        )}
      </div>

      {/* Waiting/Initializing State */}
      {(testState === 'idle' || testState === 'waiting') && (
        <div className="py-3 flex items-center justify-center gap-2">
          <div className="w-4 h-4 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">
            {testState === 'waiting' ? 'Waiting for peer...' : 'Initializing...'}
          </span>
        </div>
      )}

      {/* Testing State */}
      {testState === 'testing' && (
        <div className="py-4">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-zinc-300">{phaseLabels[testPhase] || 'Testing...'}</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div 
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${testProgress}%` }}
            />
          </div>
          <p className="text-xs text-zinc-500 text-center mt-2">{testProgress}%</p>
        </div>
      )}

      {/* Results State */}
      {testState === 'complete' && results && (
        <div className="space-y-3">
          {/* Quality Badge */}
          <div className="flex items-center justify-between">
            <span className={`px-2.5 py-1 text-xs font-medium rounded-full border ${qualityColors[results.quality?.rating] || qualityColors.fair}`}>
              {results.quality?.label || 'Unknown'}
            </span>
            {results.isRelayed && (
              <span className="text-xs text-amber-400 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Relayed connection
              </span>
            )}
          </div>

          {/* Speed Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-zinc-800/50 rounded-lg p-3">
              <p className="text-xs text-zinc-500 mb-1">Download Speed</p>
              <p className="text-lg font-semibold text-zinc-200">
                {results.megabitsPerSecond} <span className="text-xs text-zinc-500">Mbps</span>
              </p>
              <p className="text-xs text-zinc-500">{results.kilobytesPerSecond} KB/s</p>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3">
              <p className="text-xs text-zinc-500 mb-1">Latency (RTT)</p>
              <p className="text-lg font-semibold text-zinc-200">
                {results.rtt} <span className="text-xs text-zinc-500">ms</span>
              </p>
              <p className="text-xs text-zinc-500">Jitter: {results.jitter}ms</p>
            </div>
          </div>

          {/* Connection Type */}
          <div className="flex items-center justify-between text-xs py-2 border-t border-zinc-800">
            <span className="text-zinc-500">Connection Type</span>
            <span className={`font-medium ${results.isRelayed ? 'text-amber-400' : 'text-emerald-400'}`}>
              {results.connectionType === 'relay' ? 'Relayed (TURN)' : 
               results.connectionType === 'nat-traversal' ? 'NAT Traversal (STUN)' : 
               results.connectionType === 'direct' ? 'Direct (Host)' : 'Unknown'}
            </span>
          </div>

          {/* Transfer Time Estimate */}
          {totalFileSize > 0 && estimatedTime && (
            <div className="bg-blue-950/30 border border-blue-800/40 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-blue-400 mb-0.5">Estimated Transfer Time</p>
                  <p className="text-sm font-medium text-zinc-200">
                    {formatDuration(estimatedTime)} for {formatBytes(totalFileSize)}
                  </p>
                </div>
                <svg className="w-8 h-8 text-blue-500/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
          )}

          {/* Slow Connection Warning */}
          {results.quality?.rating === 'poor' && (
            <div className="bg-red-950/30 border border-red-800/40 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-xs text-red-300 font-medium">Slow Connection Detected</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {results.isRelayed 
                      ? 'Your connection is being relayed through a server. Consider using the same network for both devices.'
                      : 'Transfer speeds may be slower than expected. Large files may take a while.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Relayed Connection Warning (when not poor) */}
          {results.isRelayed && results.quality?.rating !== 'poor' && (
            <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-xs text-amber-300 font-medium">Connection is Relayed</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Data is passing through a relay server. For faster speeds, try connecting both devices to the same WiFi network.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error State */}
      {testState === 'error' && (
        <div className="text-center py-4">
          <p className="text-sm text-red-400 mb-2">Test failed</p>
          <p className="text-xs text-zinc-500 mb-3">{error}</p>
          <button
            onClick={runTest}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition-colors"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

export default BandwidthTestPanel;
