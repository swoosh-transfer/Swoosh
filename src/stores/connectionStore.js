import { create } from 'zustand';

/**
 * Connection Store
 * Manages all WebRTC connection-related state including peer connection,
 * data channel, connection status, and connected peer identification.
 */
export const useConnectionStore = create((set, get) => ({
  // State
  peerConnection: null,
  dataChannel: null,
  connectionStatus: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'failed'
  connectedPeerId: null,
  localPeerId: null,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],

  // Actions
  
  /**
   * Initialize WebRTC connection
   * @param {string} localPeerId - Local peer UUID
   * @param {Function} onDataChannelMessage - Callback for data channel messages
   * @param {Function} onConnectionStateChange - Callback for connection state changes
   */
  initializeConnection: async (localPeerId, onDataChannelMessage, onConnectionStateChange) => {
    try {
      set({ connectionStatus: 'connecting', localPeerId });

      const peerConnection = new RTCPeerConnection({
        iceServers: get().iceServers,
      });

      // Handle ICE connection state changes
      peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        console.log('ICE Connection State:', state);
        
        if (state === 'connected' || state === 'completed') {
          set({ connectionStatus: 'connected' });
          onConnectionStateChange?.('connected');
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          set({ connectionStatus: 'failed' });
          onConnectionStateChange?.('failed');
        }
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log('Connection State:', state);
        
        if (state === 'connected') {
          set({ connectionStatus: 'connected' });
          onConnectionStateChange?.('connected');
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          set({ connectionStatus: 'failed' });
          onConnectionStateChange?.('failed');
        }
      };

      set({ peerConnection });
      return peerConnection;
    } catch (error) {
      console.error('Failed to initialize connection:', error);
      set({ connectionStatus: 'failed' });
      throw error;
    }
  },

  /**
   * Create data channel (for sender/offerer)
   * @param {Function} onMessage - Callback for incoming messages
   */
  createDataChannel: (onMessage) => {
    const { peerConnection } = get();
    if (!peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    const dataChannel = peerConnection.createDataChannel('fileTransfer', {
      ordered: true,
      maxRetransmits: 3,
    });

    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
      console.log('Data channel opened');
      set({ connectionStatus: 'connected' });
    };

    dataChannel.onclose = () => {
      console.log('Data channel closed');
      set({ connectionStatus: 'disconnected' });
    };

    dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
      set({ connectionStatus: 'failed' });
    };

    dataChannel.onmessage = (event) => {
      onMessage?.(event.data);
    };

    set({ dataChannel });
    return dataChannel;
  },

  /**
   * Setup data channel (for receiver/answerer)
   * @param {Function} onMessage - Callback for incoming messages
   */
  setupDataChannelListener: (onMessage) => {
    const { peerConnection } = get();
    if (!peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    peerConnection.ondatachannel = (event) => {
      const dataChannel = event.channel;
      dataChannel.binaryType = 'arraybuffer';

      dataChannel.onopen = () => {
        console.log('Data channel opened (received)');
        set({ connectionStatus: 'connected', dataChannel });
      };

      dataChannel.onclose = () => {
        console.log('Data channel closed');
        set({ connectionStatus: 'disconnected' });
      };

      dataChannel.onerror = (error) => {
        console.error('Data channel error:', error);
        set({ connectionStatus: 'failed' });
      };

      dataChannel.onmessage = (event) => {
        onMessage?.(event.data);
      };
    };
  },

  /**
   * Send data through the established data channel
   * @param {any} data - Data to send (string, ArrayBuffer, or Blob)
   */
  sendData: (data) => {
    const { dataChannel, connectionStatus } = get();
    
    if (!dataChannel) {
      throw new Error('Data channel not initialized');
    }

    if (connectionStatus !== 'connected') {
      throw new Error(`Cannot send data: connection status is ${connectionStatus}`);
    }

    if (dataChannel.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }

    try {
      dataChannel.send(data);
      return true;
    } catch (error) {
      console.error('Failed to send data:', error);
      throw error;
    }
  },

  /**
   * Close connection gracefully
   */
  closeConnection: () => {
    const { peerConnection, dataChannel } = get();

    if (dataChannel) {
      dataChannel.close();
    }

    if (peerConnection) {
      peerConnection.close();
    }

    set({
      peerConnection: null,
      dataChannel: null,
      connectionStatus: 'disconnected',
      connectedPeerId: null,
    });
  },

  /**
   * Set connected peer ID
   * @param {string} peerId - Connected peer UUID
   */
  setConnectedPeer: (peerId) => {
    set({ connectedPeerId: peerId });
  },

  /**
   * Update connection status
   * @param {string} status - New connection status
   */
  updateConnectionStatus: (status) => {
    set({ connectionStatus: status });
  },

  /**
   * Check if connection is ready for data transfer
   * @returns {boolean}
   */
  isConnectionReady: () => {
    const { dataChannel, connectionStatus } = get();
    return dataChannel && 
           dataChannel.readyState === 'open' && 
           connectionStatus === 'connected';
  },

  /**
   * Get buffer amount (for flow control)
   * @returns {number}
   */
  getBufferedAmount: () => {
    const { dataChannel } = get();
    return dataChannel ? dataChannel.bufferedAmount : 0;
  },
}));
