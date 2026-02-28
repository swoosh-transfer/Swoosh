/**
 * Test Utilities and Mock Factories
 * 
 * Reusable mock objects and helpers for testing.
 * Import these in your tests to create consistent mocks.
 */

import { vi } from 'vitest';

/**
 * Create a mock RTCDataChannel
 * @param {Object} overrides - Properties to override
 * @returns {Object} Mock DataChannel
 */
export function createMockDataChannel(overrides = {}) {
  const listeners = new Map();
  
  const channel = {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    removeEventListener: vi.fn((event, handler) => {
      if (listeners.has(event)) {
        const handlers = listeners.get(event);
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    }),
    dispatchEvent: vi.fn((event) => {
      const handlers = listeners.get(event.type) || [];
      handlers.forEach(handler => handler(event));
    }),
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    label: 'test-channel',
    ...overrides,
  };

  // Helper to trigger events
  channel._trigger = (eventType, data) => {
    const handlers = listeners.get(eventType) || [];
    handlers.forEach(handler => handler(data));
  };

  return channel;
}

/**
 * Create a mock File object
 * @param {string} name - File name
 * @param {number} size - File size in bytes
 * @param {string} type - MIME type
 * @returns {File} Mock File
 */
export function createMockFile(name = 'test.txt', size = 1024, type = 'text/plain') {
  const content = new Array(size).fill('x').join('');
  return new File([content], name, { type });
}

/**
 * Create a large mock file for testing chunking
 * @param {number} sizeMB - Size in megabytes
 * @returns {File} Mock File
 */
export function createLargeMockFile(sizeMB = 10) {
  const size = sizeMB * 1024 * 1024;
  return createMockFile(`large-file-${sizeMB}MB.bin`, size, 'application/octet-stream');
}

/**
 * Create mock TransferOrchestrator
 * @param {Object} overrides - Methods to override
 * @returns {Object} Mock orchestrator
 */
export function createMockOrchestrator(overrides = {}) {
  const listeners = new Map();

  return {
    startSending: vi.fn().mockResolvedValue('transfer-id-' + Math.random()),
    startReceiving: vi.fn().mockResolvedValue('transfer-id-' + Math.random()),
    pauseTransfer: vi.fn().mockResolvedValue(true),
    resumeTransfer: vi.fn().mockResolvedValue(true),
    cancelTransfer: vi.fn().mockResolvedValue(true),
    
    on: vi.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    
    off: vi.fn((event, handler) => {
      if (listeners.has(event)) {
        const handlers = listeners.get(event);
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    }),
    
    emit: vi.fn((event, data) => {
      const handlers = listeners.get(event) || [];
      handlers.forEach(handler => handler(data));
    }),

    // Helper to trigger events in tests
    _trigger: (event, data) => {
      const handlers = listeners.get(event) || [];
      handlers.forEach(handler => handler(data));
    },

    ...overrides,
  };
}

/**
 * Create mock ProgressTracker
 * @param {number} totalBytes - Total file size
 * @returns {Object} Mock tracker
 */
export function createMockProgressTracker(totalBytes = 1024) {
  let currentBytes = 0;
  const callbacks = [];

  return {
    updateProgress: vi.fn((bytes) => {
      currentBytes += bytes;
      callbacks.forEach(cb => cb({
        percentage: (currentBytes / totalBytes) * 100,
        currentBytes,
        totalBytes,
        speed: 1024 * 1024,
        eta: 5,
      }));
    }),
    
    getProgress: vi.fn(() => ({
      percentage: (currentBytes / totalBytes) * 100,
      currentBytes,
      totalBytes,
      speed: 1024 * 1024,
      eta: currentBytes < totalBytes ? 5 : null,
    })),
    
    onProgress: vi.fn((callback) => {
      callbacks.push(callback);
    }),
    
    reset: vi.fn(() => {
      currentBytes = 0;
    }),
  };
}

/**
 * Create mock MessageService
 * @returns {Object} Mock service
 */
export function createMockMessageService() {
  const listeners = new Map();

  return {
    send: vi.fn((message, dataChannel) => {
      // Simulate successful send
      return Promise.resolve();
    }),
    
    on: vi.fn((messageType, handler) => {
      if (!listeners.has(messageType)) {
        listeners.set(messageType, []);
      }
      listeners.get(messageType).push(handler);
    }),
    
    off: vi.fn((messageType, handler) => {
      if (listeners.has(messageType)) {
        const handlers = listeners.get(messageType);
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    }),

    // Message creation helpers
    createFileMetadataMessage: vi.fn((metadata) => ({
      type: 'file-metadata',
      payload: metadata,
    })),

    createFileChunkMessage: vi.fn((chunk) => ({
      type: 'file-chunk',
      payload: chunk,
    })),

    createFileCompleteMessage: vi.fn((data) => ({
      type: 'file-complete',
      payload: data,
    })),

    // Helper to simulate receiving messages
    _receiveMessage: (messageType, payload) => {
      const handlers = listeners.get(messageType) || [];
      handlers.forEach(handler => handler({ type: messageType, payload }));
    },
  };
}

/**
 * Create mock IndexedDB repository
 * @returns {Object} Mock repository
 */
export function createMockTransfersRepository() {
  const store = new Map();

  return {
    saveTransfer: vi.fn(async (transfer) => {
      store.set(transfer.id, { ...transfer });
      return { success: true, id: transfer.id };
    }),

    updateTransfer: vi.fn(async (id, updates) => {
      if (store.has(id)) {
        store.set(id, { ...store.get(id), ...updates });
        return { success: true };
      }
      return { success: false, error: 'Not found' };
    }),

    getTransfer: vi.fn(async (id) => {
      return store.get(id) || null;
    }),

    getAllTransfers: vi.fn(async () => {
      return Array.from(store.values());
    }),

    deleteTransfer: vi.fn(async (id) => {
      const existed = store.has(id);
      store.delete(id);
      return { success: existed };
    }),

    // Helper to inspect store
    _getStore: () => store,
    _clear: () => store.clear(),
  };
}

/**
 * Create mock ChunkingEngine
 * @returns {Object} Mock engine
 */
export function createMockChunkingEngine() {
  return {
    processFile: vi.fn(async function* (file) {
      // Yield mock chunks
      const chunkSize = 16384;
      const totalChunks = Math.ceil(file.size / chunkSize);
      
      for (let i = 0; i < totalChunks; i++) {
        yield {
          sequence: i,
          data: new ArrayBuffer(Math.min(chunkSize, file.size - i * chunkSize)),
          isFirst: i === 0,
          isLast: i === totalChunks - 1,
        };
      }
    }),

    calculateChunkSize: vi.fn(() => 16384),
  };
}

/**
 * Create mock AssemblyEngine
 * @returns {Object} Mock engine
 */
export function createMockAssemblyEngine() {
  const chunks = [];

  return {
    addChunk: vi.fn((chunk) => {
      chunks.push(chunk);
    }),

    getProgress: vi.fn(() => ({
      receivedChunks: chunks.length,
      totalChunks: 10,
      percentage: (chunks.length / 10) * 100,
    })),

    assembleFile: vi.fn(async (metadata) => {
      // Return mock File
      return createMockFile(metadata.name, metadata.size, metadata.type);
    }),

    reset: vi.fn(() => {
      chunks.length = 0;
    }),

    _getChunks: () => chunks,
  };
}

/**
 * Wait for all pending promises to resolve
 * Useful when testing async code
 */
export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait for a condition to be true
 * @param {Function} condition - Function that returns boolean
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<void>}
 */
export async function waitForCondition(condition, timeout = 1000) {
  const startTime = Date.now();
  
  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Simulate delay
 * @param {number} ms - Milliseconds to delay
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create mock crypto API
 */
export function createMockCrypto() {
  return {
    randomUUID: vi.fn(() => 'test-uuid-' + Math.random()),
    subtle: {
      digest: vi.fn(async (algorithm, data) => {
        // Return mock hash
        return new ArrayBuffer(32);
      }),
    },
  };
}

/**
 * Create mock File System Access API handle
 */
export function createMockFileHandle(file) {
  return {
    getFile: vi.fn(async () => file),
    createWritable: vi.fn(async () => ({
      write: vi.fn(),
      close: vi.fn(),
    })),
  };
}
