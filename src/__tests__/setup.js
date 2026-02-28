/**
 * Test Setup and Global Mocks
 * 
 * This file runs before all tests.
 * It sets up the test environment and mocks Web APIs.
 */

import { expect, afterEach, vi, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createMockCrypto, createMockFileHandle, createMockFile } from '../__mocks__/testUtils';

// Cleanup React components after each test
afterEach(() => {
  cleanup();
});

// Mock Web Crypto API
beforeAll(() => {
  if (!global.crypto) {
    global.crypto = createMockCrypto();
  }
});

// Mock IndexedDB
global.indexedDB = {
  open: vi.fn((name, version) => {
    const request = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: null,
    };

    // Simulate async success
    setTimeout(() => {
      request.result = {
        transaction: vi.fn(() => ({
          objectStore: vi.fn(() => ({
            add: vi.fn(),
            put: vi.fn(),
            get: vi.fn(),
            delete: vi.fn(),
            getAll: vi.fn(),
          })),
        })),
        close: vi.fn(),
      };
      
      if (request.onsuccess) {
        request.onsuccess({ target: request });
      }
    }, 0);

    return request;
  }),
  deleteDatabase: vi.fn(),
};

// Mock File System Access API
global.showOpenFilePicker = vi.fn(async () => {
  const mockFile = createMockFile('test.txt', 1024);
  return [createMockFileHandle(mockFile)];
});

global.showSaveFilePicker = vi.fn(async () => {
  const mockFile = createMockFile('test.txt', 0);
  return createMockFileHandle(mockFile);
});

// Mock RTCPeerConnection
global.RTCPeerConnection = vi.fn(function() {
  this.createDataChannel = vi.fn(() => ({
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 'open',
  }));
  
  this.createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'mock-sdp' }));
  this.createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'mock-sdp' }));
  this.setLocalDescription = vi.fn(async () => {});
  this.setRemoteDescription = vi.fn(async () => {});
  this.addIceCandidate = vi.fn(async () => {});
  this.close = vi.fn();
  
  this.localDescription = null;
  this.remoteDescription = null;
  this.iceConnectionState = 'new';
  this.connectionState = 'new';
  
  this.addEventListener = vi.fn();
  this.removeEventListener = vi.fn();
});

// Mock performance API (for timing measurements)
if (!global.performance) {
  global.performance = {
    now: vi.fn(() => Date.now()),
  };
}

// Mock console methods to reduce noise in tests
// Uncomment if you want to suppress console output during tests
/*
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
*/

// Custom matchers (if needed)
expect.extend({
  toBeWithinRange(received, min, max) {
    const pass = received >= min && received <= max;
    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be within range ${min} - ${max}`
          : `expected ${received} to be within range ${min} - ${max}`,
    };
  },
});
