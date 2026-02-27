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

      {/* Share URL (host only, before connection) */}
      {isHost && !dataChannelReady && shareUrl && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <ShareUrlBox url={shareUrl} onCopy={() => onCopy(shareUrl)} copied={copied} />
        </div>
      )}

      {/* Connection Info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Connection</h2>
        <ConnectionInfoPanel info={connInfo} />
      </div>
    </div>
  );
}
