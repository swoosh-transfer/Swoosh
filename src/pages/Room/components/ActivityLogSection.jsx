/**
 * Activity Log Component
 * Displays activity feed for room events
 */
import React from 'react';
import { ActivityLog as ActivityLogUI } from '../../../components/RoomUI.jsx';

export function ActivityLogSection({ logs }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-3">Activity</h2>
      <ActivityLogUI logs={logs} />
    </div>
  );
}
