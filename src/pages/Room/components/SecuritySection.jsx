/**
 * SecuritySection Component
 * Displays TOFU verification status and identity information
 * This component is intentionally minimal - most display is in StatusSection
 */
import React from 'react';

export function SecuritySection({
  identityVerified,
  verificationStatus,
  tofuVerified,
}) {
  // Most security UI is shown in StatusSection (verificationStatus badge)
  // This component can be used for additional security details if needed
  
  if (!identityVerified && !tofuVerified) {
    return null; // Nothing to show yet
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-3">Security</h2>
      <div className="space-y-2 text-sm">
        {identityVerified && (
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Identity</span>
            <span className="text-emerald-400">Verified</span>
          </div>
        )}
        {tofuVerified && (
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">TOFU</span>
            <span className="text-emerald-400">Verified</span>
          </div>
        )}
        {verificationStatus === 'verifying' && (
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Status</span>
            <span className="text-yellow-400">Verifying...</span>
          </div>
        )}
        {verificationStatus === 'failed' && (
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Status</span>
            <span className="text-red-400">Failed</span>
          </div>
        )}
      </div>
    </div>
  );
}
