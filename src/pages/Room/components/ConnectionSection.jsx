/**
 * ConnectionSection Component
 * Displays connection status, QR code, share URL, and connection info
 */
import React from 'react';
import {
  StatusSection,
  ShareUrlBox,
  ConnectionInfoPanel,
} from '../../../components/RoomUI.jsx';
import { getQRCodeUrl } from '../../../utils/qrCode.js';

export function ConnectionSection({
  isHost,
  socketConnected,
  connInfo,
  dataChannelReady,
  tofuVerified,
  verificationStatus,
  shareUrl,
  copied,
  onCopy,
}) {
  return (
    <div className="space-y-4">
      {/* Share URL & QR Code (host only) - Always visible but prominent when waiting */}
      {isHost && shareUrl && (
        <div className={`bg-zinc-900 border rounded-xl p-4 transition-all ${
          !dataChannelReady 
            ? 'border-blue-500 shadow-lg shadow-blue-500/20' 
            : 'border-zinc-800'
        }`}>
          <h2 className="text-sm font-medium text-zinc-400 mb-3">
            {!dataChannelReady ? '📱 Share this link to connect' : '🔗 Room Link'}
          </h2>
          <ShareUrlBox url={shareUrl} onCopy={() => onCopy(shareUrl)} copied={copied} />
        </div>
      )}

      {/* Connection Status */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Status</h2>
        <StatusSection
          socketConnected={socketConnected || connInfo.socketConnected}
          dataChannelReady={dataChannelReady}
          tofuVerified={tofuVerified}
          tofuStatus={verificationStatus}
        />
      </div>

      {/* Connection Info - Collapsible when everything is working */}
      {(connInfo.iceState !== 'connected' || !dataChannelReady || !tofuVerified) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">Connection Details</h2>
          <ConnectionInfoPanel info={connInfo} />
        </div>
      )}
    </div>
  );
}
