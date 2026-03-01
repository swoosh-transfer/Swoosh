import { create } from 'zustand';

/**
 * Room Store
 * 
 * WHAT THIS STORE MANAGES:
 * - Room metadata (roomId, isHost)
 * - Security payload for TOFU verification
 * - Selected files from Home.jsx (persists to Room.jsx) — supports multi-file & folder drops
 * - Global room errors
 * 
 * WHAT IS MANAGED ELSEWHERE:
 * - Connection state → useRoomConnection hook
 * - Security verification → useSecurity hook
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
  // Used for encrypted signaling verification between peers
  securityPayload: null,
  
  // Files selected on Home.jsx, persists to Room.jsx for transfer
  // Each entry: { file: File, relativePath: string | null }
  selectedFiles: [],
  
  // Resume context — set when user clicks "Resume" on Home page
  // Contains transfer metadata needed to resume in a new room
  // { transferId, fileName, fileSize, fileHash, totalChunks, chunkBitmap, direction, fileManifest }
  resumeContext: null,

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
   * Set security payload for signaling encryption
   * @param {Object} payload - Security payload { secret, peerID }
   */
  setSecurityPayload: (payload) => set({ securityPayload: payload }),
  
  /**
   * Set selected files for transfer (replaces all)
   * @param {Array<{file: File, relativePath: string|null}>} files
   */
  setSelectedFiles: (files) => set({ selectedFiles: files }),

  /**
   * Add files to the selection (appends)
   * @param {Array<{file: File, relativePath: string|null}>} newFiles
   */
  addFiles: (newFiles) => set((state) => ({
    selectedFiles: [...state.selectedFiles, ...newFiles],
  })),

  /**
   * Remove a file from selection by index
   * @param {number} index
   */
  removeFile: (index) => set((state) => ({
    selectedFiles: state.selectedFiles.filter((_, i) => i !== index),
  })),

  /**
   * Clear all selected files
   */
  clearFiles: () => set({ selectedFiles: [] }),

  /** @deprecated Use setSelectedFiles instead */
  setSelectedFile: (file) => set({
    selectedFiles: file ? [{ file, relativePath: null }] : [],
  }),
  
  /**
   * Set resume context for resuming a failed transfer in a new room
   * @param {Object|null} context - Resume metadata
   */
  setResumeContext: (context) => set({ resumeContext: context }),

  /**
   * Clear resume context (after resume completes or is aborted)
   */
  clearResumeContext: () => set({ resumeContext: null }),

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
    selectedFiles: [],
    resumeContext: null,
    error: null,
  }),
  
}));
