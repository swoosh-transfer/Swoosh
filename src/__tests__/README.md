# Tests

This directory contains all test files for the P2P file transfer application.

## Structure

```
__tests__/
├── setup.js              # Test environment setup (runs before all tests)
├── unit/                 # Unit tests (pure functions, classes)
│   ├── formatters.test.js
│   └── ProgressTracker.test.js
├── integration/          # Integration tests (multiple modules)
│   └── (add your integration tests here)
└── hooks/                # React hooks tests
    └── (add your hook tests here)
```

## Running Tests

```bash
# Run all tests in watch mode
npm test

# Run tests once (for CI)
npm run test:run

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

## Test Files

### Unit Tests

- **formatters.test.js** - Tests formatting utilities (formatBytes, formatDuration, formatSpeed)
- **ProgressTracker.test.js** - Tests progress tracking logic

### Integration Tests

(To be added)

### Hook Tests

(To be added)

## Writing Tests

1. Create test file next to related source (with `.test.js` suffix)
2. Import test utilities from `@/__mocks__/testUtils`
3. Use descriptive test names
4. Test behavior, not implementation
5. Mock external dependencies

Example:

```javascript
import { describe, it, expect } from 'vitest';
import { formatBytes } from '@/lib/formatters';

describe('formatBytes', () => {
  it('should format bytes correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });
});
```

## Mock Utilities

See `src/__mocks__/testUtils.js` for reusable mock factories:

- `createMockDataChannel()` - Mock RTCDataChannel
- `createMockFile()` - Mock File object
- `createMockOrchestrator()` - Mock TransferOrchestrator
- `createMockProgressTracker()` - Mock ProgressTracker
- ... and more

## Coverage Goals

- Pure functions (lib/): **100%**
- Services: **80%+**
- Transfer modules: **80%+**
- Hooks: **70%+**
- Components: **60%+**

## Need Help?

See [docs/TESTING.md](../docs/TESTING.md) for comprehensive testing guide.
