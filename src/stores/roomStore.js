import { create } from 'zustand';

/**
 * Room Store
 * Manages room state, peer connection state, and TOFU verification status
 */
export const useRoomStore = create((set, get) => ({
  // State
  roomId: null,
  isHost: false,
  securityPayload: null,
  peerConnected: false,
  dataChannelReady: false,
  tofuVerified: false,
  verificationStatus: 'pending', // 'pending' | 'verifying' | 'verified' | 'failed'
  connectionState: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'failed'
  error: null,
  
  // Selected file for transfer
  selectedFile: null,
  
  // Transfer state
  transferState: 'idle', // 'idle' | 'sending' | 'receiving' | 'completed' | 'error'
  transferProgress: 0,
  transferSpeed: 0,

  // Actions
  setRoomId: (roomId) => set({ roomId }),
  
  setIsHost: (isHost) => set({ isHost }),
  
  setSecurityPayload: (payload) => set({ securityPayload: payload }),
  
  setPeerConnected: (connected) => set({ peerConnected: connected }),
  
  setDataChannelReady: (ready) => set({ dataChannelReady: ready }),
  
  setTofuVerified: (verified) => set({ 
    tofuVerified: verified,
    verificationStatus: verified ? 'verified' : 'failed'
  }),
  
  setVerificationStatus: (status) => set({ verificationStatus: status }),
  
  setConnectionState: (state) => set({ connectionState: state }),
  
  setError: (error) => set({ error }),
  
  setSelectedFile: (file) => set({ selectedFile: file }),
  
  setTransferState: (state) => set({ transferState: state }),
  
  setTransferProgress: (progress) => set({ transferProgress: progress }),
  
  setTransferSpeed: (speed) => set({ transferSpeed: speed }),
  
  // Reset room state
  resetRoom: () => set({
    roomId: null,
    isHost: false,
    securityPayload: null,
    peerConnected: false,
    dataChannelReady: false,
    tofuVerified: false,
    verificationStatus: 'pending',
    connectionState: 'disconnected',
    error: null,
    selectedFile: null,
    transferState: 'idle',
    transferProgress: 0,
    transferSpeed: 0,
  }),
}));
