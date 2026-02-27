import { create } from 'zustand';

/**
 * Room Store - Simplified (Phase 6 Refactoring)
 * 
 * WHAT THIS STORE MANAGES:
 * - Room metadata (roomId, isHost)
 * - Security payload for TOFU verification
 * - Selected file from Home.jsx (persists to Room.jsx)
 * - Global room errors
 * 
 * WHAT THIS STORE NO LONGER MANAGES (delegated to hooks):
 * - Connection state → useRoomConnection hook
 * - TOFU verification → useSecurity hook
 * - Transfer progress → useFileTransfer hook
 * - Data channel state → useRoomConnection hook
 * 
 * See stores/README.md for state management guidelines.
 */
export const useRoomStore = create((set, get) => ({
  // ============ ROOM METADATA ============
  // Room identifier (set when creating/joining room)
  roomId: null,
  
  // Whether current user is the host (creator) or guest (joiner)
  isHost: false,
  
  // Security payload (secret, peerID) embedded in share URL
  // Used for TOFU verification between peers
  securityPayload: null,
  
  // File selected on Home.jsx, persists to Room.jsx for transfer
  selectedFile: null,
  
  // Global room-level error (navigation failures, critical issues)
  error: null,

  // ============ ACTIONS ============
  
  /**
   * Set room ID
   * @param {string} roomId - Room identifier
   */
  setRoomId: (roomId) => set({ roomId }),
  
  /**
   * Set whether user is host
   * @param {boolean} isHost - Host status
   */
  setIsHost: (isHost) => set({ isHost }),
  
  /**
   * Set security payload for TOFU verification
   * @param {Object} payload - Security payload { secret, peerID }
   */
  setSecurityPayload: (payload) => set({ securityPayload: payload }),
  
  /**
   * Set selected file for transfer
   * @param {File} file - File object from Home.jsx
   */
  setSelectedFile: (file) => set({ selectedFile: file }),
  
  /**
   * Set global room error
   * @param {string} error - Error message
   */
  setError: (error) => set({ error }),
  
  /**
   * Reset room state (called when leaving room)
   */
  resetRoom: () => set({
    roomId: null,
    isHost: false,
    securityPayload: null,
    selectedFile: null,
    error: null,
  }),
  
  // ============ DEPRECATED METHODS (kept for backward compatibility) ============
  // These are no-ops now, state managed by hooks instead
  
  /** @deprecated Use useSecurity hook instead */
  setTofuVerified: () => {},
  
  /** @deprecated Use useSecurity hook instead */
  setVerificationStatus: () => {},
  
  /** @deprecated Use useRoomConnection hook instead */
  setConnectionState: () => {},
  
  /** @deprecated Use useRoomConnection hook instead */
  setPeerConnected: () => {},
  
  /** @deprecated Use useRoomConnection hook instead */
  setDataChannelReady: () => {},
  
  /** @deprecated Use useFileTransfer hook instead */
  setTransferState: () => {},
  
  /** @deprecated Use useFileTransfer hook instead */
  setTransferProgress: () => {},
  
  /** @deprecated Use useFileTransfer hook instead */
  setTransferSpeed: () => {},
  
  // ============ DEPRECATED PROPERTIES ============
  // Kept for read compatibility, but hooks are source of truth
  
  /** @deprecated Read from useSecurity hook instead */
  tofuVerified: false,
  
  /** @deprecated Read from useSecurity hook instead */
  verificationStatus: 'pending',
  
  /** @deprecated Read from useRoomConnection hook instead */
  connectionState: 'disconnected',
  
  /** @deprecated Read from useRoomConnection hook instead */
  peerConnected: false,
  
  /** @deprecated Read from useRoomConnection hook instead */
  dataChannelReady: false,
  
  /** @deprecated Read from useFileTransfer hook instead */
  transferState: 'idle',
  
  /** @deprecated Read from useFileTransfer hook instead */
  transferProgress: 0,
  
  /** @deprecated Read from useFileTransfer hook instead */
  transferSpeed: 0,
}));
