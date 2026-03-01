# Testing Guide

This guide explains the testing strategy and how to write tests for the P2P file transfer application.

## Testing Philosophy

Our testing approach focuses on:
- **Unit Testing**: Test individual modules in isolation
- **Integration Testing**: Test how modules work together
- **Mock-Based Testing**: Mock dependencies for isolated testing
- **Real Behavior**: Test actual use cases, not implementation details

## Test Structure

```
src/
├── __tests__/              # Test files
│   ├── unit/               # Unit tests
│   │   ├── ProgressTracker.test.js
│   │   ├── formatters.test.js
│   │   └── chunkBitmap.test.js
│   └── hooks/              # React hooks tests
│       ├── useFileTransfer.test.js
│       └── useRoomConnection.test.js
└── __mocks__/              # Mock implementations
    └── testUtils.js
```

## Setup

```bash
# Install testing dependencies
npm install --save-dev vitest @testing-library/react @testing-library/hooks @testing-library/user-event happy-dom

# Run tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage
```

### Vite Configuration

Add to `vite.config.js`:

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
  },
});
```

### Test Setup File

Create `src/__tests__/setup.js`:

```javascript
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock Web APIs not available in test environment
global.crypto = {
  randomUUID: () => 'test-uuid-' + Math.random(),
  subtle: {
    digest: async () => new ArrayBuffer(32),
  },
};

// Mock IndexedDB
global.indexedDB = {
  open: () => ({
    onsuccess: null,
    onerror: null,
  }),
};

// Mock File System Access API
global.window.showOpenFilePicker = async () => [
  {
    getFile: async () => new File(['content'], 'test.txt', { type: 'text/plain' }),
  },
];
```

## Unit Testing

### Testing Pure Functions

Pure functions (from `lib/`) are the easiest to test.

**Example: Testing formatBytes**

```javascript
// src/__tests__/unit/formatters.test.js
import { describe, it, expect } from 'vitest';
import { formatBytes } from '@/lib/formatters';

describe('formatBytes', () => {
  it('formats bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('handles decimal precision', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1.5)).toBe('1.50 KB');
  });

  it('handles edge cases', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(-100)).toBe('0 B');
  });
});
```

### Testing Classes

For classes, test each public method separately.

**Example: Testing ProgressTracker**

```javascript
// src/__tests__/unit/ProgressTracker.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProgressTracker } from '@/transfer/shared/ProgressTracker';

describe('ProgressTracker', () => {
  let tracker;
  const totalBytes = 1024 * 1024; // 1 MB

  beforeEach(() => {
    tracker = new ProgressTracker(totalBytes);
  });

  it('initializes with correct total', () => {
    const progress = tracker.getProgress();
    expect(progress.totalBytes).toBe(totalBytes);
    expect(progress.currentBytes).toBe(0);
    expect(progress.percentage).toBe(0);
  });

  it('updates progress correctly', () => {
    tracker.updateProgress(512 * 1024); // 50%

    const progress = tracker.getProgress();
    expect(progress.currentBytes).toBe(512 * 1024);
    expect(progress.percentage).toBe(50);
  });

  it('calculates speed and ETA', () => {
    // Mock Date.now() for consistent timing
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    tracker.updateProgress(256 * 1024); // 25%

    // Advance time by 1 second
    vi.spyOn(Date, 'now').mockReturnValue(now + 1000);

    tracker.updateProgress(256 * 1024); // Another 25%

    const progress = tracker.getProgress();
    expect(progress.speed).toBeGreaterThan(0);
    expect(progress.eta).toBeGreaterThan(0);
  });

  it('triggers progress callbacks', () => {
    const callback = vi.fn();
    tracker.onProgress(callback);

    tracker.updateProgress(512 * 1024);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        percentage: 50,
        currentBytes: 512 * 1024,
      })
    );
  });

  it('handles completion', () => {
    tracker.updateProgress(totalBytes);

    const progress = tracker.getProgress();
    expect(progress.percentage).toBe(100);
  });
});
```

## Integration Testing

Integration tests verify how multiple modules work together.

**Example: Testing ChunkingEngine with ProgressTracker**

```javascript
// src/__tests__/integration/ChunkingEngine.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChunkingEngine } from '@/transfer/sending/ChunkingEngine';

// Mock dependencies
vi.mock('@/infrastructure/database/transfers.repository');

describe('ChunkingEngine Integration', () => {
  let engine;
  let mockDataChannel;
  let mockFile;

  beforeEach(() => {
    engine = new ChunkingEngine();

    mockDataChannel = createMockDataChannel();
    mockFile = new File(['content'], 'test.txt', { type: 'text/plain' });
  });

  it('sends file metadata before chunks', async () => {
    // Test that metadata is sent first
    expect(mockDataChannel.send).not.toHaveBeenCalled();
  });

  it('handles errors gracefully', async () => {
    mockDataChannel.send.mockImplementation(() => {
      throw new Error('Connection lost');
    });

    // Verify error handling
  });
});

// Test utilities
function createMockDataChannel() {
  return {
    send: vi.fn(),
    readyState: 'open',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    bufferedAmount: 0,
  };
}
```

## Testing React Hooks

Use `@testing-library/react` for testing hooks.

**Example: Testing useFileTransfer**

```javascript
// src/__tests__/hooks/useFileTransfer.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFileTransfer } from '@/pages/Room/hooks/useFileTransfer';

describe('useFileTransfer', () => {
  let mockOrchestrator;
  let mockDataChannel;

  beforeEach(() => {
    mockDataChannel = {
      send: vi.fn(),
      readyState: 'open',
    };
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() =>
      useFileTransfer(mockDataChannel)
    );

    expect(result.current.uploadProgress).toEqual({});
    expect(result.current.downloadProgress).toEqual({});
  });

  it('handles file selection and upload', async () => {
    const { result } = renderHook(() =>
      useFileTransfer(mockDataChannel)
    );

    const file = new File(['content'], 'test.txt', { type: 'text/plain' });

    await act(async () => {
      await result.current.handleSendFile(file);
    });
  });

  it('cleans up on unmount', () => {
    const { unmount } = renderHook(() =>
      useFileTransfer(mockDataChannel)
    );

    unmount();
  });
});
```

## Testing Components

**Example: Testing TransferSection**

```javascript
// src/__tests__/components/TransferSection.test.js
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransferSection } from '@/pages/Room/components/TransferSection';

describe('TransferSection', () => {
  const mockProps = {
    uploadProgress: {},
    downloadProgress: {},
    handleSendFile: vi.fn(),
    pauseTransfer: vi.fn(),
    resumeTransfer: vi.fn(),
  };

  it('renders file selection button', () => {
    render(<TransferSection {...mockProps} />);

    expect(screen.getByText(/select file/i)).toBeInTheDocument();
  });

  it('displays upload progress', () => {
    const props = {
      ...mockProps,
      uploadProgress: {
        'test-id': {
          fileName: 'test.txt',
          percentage: 50,
          speed: 1024 * 1024,
        },
      },
    };

    render(<TransferSection {...props} />);

    expect(screen.getByText('test.txt')).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  it('handles file selection', async () => {
    render(<TransferSection {...mockProps} />);

    const button = screen.getByText(/select file/i);
    fireEvent.click(button);

    // File picker is mocked in setup.js
    // Would normally trigger mockProps.handleSendFile
  });

  it('shows pause button for active transfers', () => {
    const props = {
      ...mockProps,
      uploadProgress: {
        'test-id': {
          fileName: 'test.txt',
          percentage: 50,
          status: 'active',
        },
      },
    };

    render(<TransferSection {...props} />);

    const pauseButton = screen.getByText(/pause/i);
    fireEvent.click(pauseButton);

    expect(mockProps.pauseTransfer).toHaveBeenCalledWith('test-id');
  });
});
```

## Mock Utilities

Create reusable mocks in `src/__mocks__/`.

**src/__mocks__/testUtils.js:**

```javascript
import { vi } from 'vitest';

/**
 * Create mock RTCDataChannel
 */
export function createMockDataChannel(overrides = {}) {
  return {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 'open',
    bufferedAmount: 0,
    ...overrides,
  };
}

/**
 * Create mock File object
 */
export function createMockFile(name = 'test.txt', size = 1024) {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' });
}

/**
 * Create mock ProgressTracker
 */
export function createMockProgressTracker() {
  return {
    updateProgress: vi.fn(),
    getProgress: vi.fn(() => ({
      percentage: 0,
      currentBytes: 0,
      totalBytes: 1024,
      speed: 0,
      eta: null,
    })),
    onProgress: vi.fn(),
  };
}

/**
 * Wait for async operations
 */
export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
```

## Test Coverage

Aim for coverage targets:
- **Pure functions (lib/):** 100%
- **Transfer modules:** 80%+
- **Infrastructure:** 80%+
- **Hooks:** 70%+
- **Components:** 60%+

Check coverage:
```bash
npm test -- --coverage
```

## Best Practices

### ✅ Do

- Test behavior, not implementation
- Use descriptive test names
- Mock external dependencies
- Test edge cases and error paths
- Keep tests isolated (no shared state)
- Use `beforeEach` for setup
- Test user interactions in components

### ❌ Don't

- Test implementation details
- Share state between tests
- Mock what you're testing
- Write tests that depend on test order
- Ignore failing tests
- Over-mock (mock what's necessary)

## Running Tests in CI

Add to `.github/workflows/test.yml`:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test -- --coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

## Debugging Tests

```javascript
// Add debugging output
import { debug } from '@testing-library/react';

it('test case', () => {
  const { container } = render(<MyComponent />);
  debug(container); // Prints DOM tree
});

// Use console.log in tests
it('test case', () => {
  console.log('Current state:', result.current);
});

// Run single test file
npm test -- TransferSection.test.js

// Run tests matching pattern
npm test -- --grep "transfer"
```

## Further Reading

- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [React Testing Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

## Need Help?

- Check existing test files for patterns
- See [DEBUGGING.md](DEBUGGING.md) for general debugging tips
- Ask in team chat or open an issue
