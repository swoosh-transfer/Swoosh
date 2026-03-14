/**
 * Unit Tests for Transfer Store (Zustand)
 *
 * Tests all store actions: initiate, complete, fail, cancel, clear, getHistory.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useTransferStore } from '@/stores/transferStore';

describe('transferStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useTransferStore.setState({ transferHistory: [] });
  });

  // ─── initiateUpload ──────────────────────────────────────────

  describe('initiateUpload', () => {
    it('should add an uploading entry to history', () => {
      useTransferStore.getState().initiateUpload({
        transferId: 'tx-1',
        fileName: 'photo.jpg',
        fileSize: 5000,
      });
      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('tx-1');
      expect(history[0].status).toBe('uploading');
      expect(history[0].direction).toBe('upload');
      expect(history[0].fileName).toBe('photo.jpg');
      expect(history[0].startedAt).toBeDefined();
    });

    it('should handle empty metadata', () => {
      useTransferStore.getState().initiateUpload();
      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('uploading');
      expect(history[0].direction).toBe('upload');
    });
  });

  // ─── initiateDownload ────────────────────────────────────────

  describe('initiateDownload', () => {
    it('should add a downloading entry to history', () => {
      useTransferStore.getState().initiateDownload({
        transferId: 'tx-2',
        fileName: 'doc.pdf',
        fileSize: 1024,
      });
      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('tx-2');
      expect(history[0].status).toBe('downloading');
      expect(history[0].direction).toBe('download');
    });
  });

  // ─── completeTransfer ────────────────────────────────────────

  describe('completeTransfer', () => {
    it('should update existing entry to completed', () => {
      useTransferStore.getState().initiateUpload({ transferId: 'tx-3' });
      useTransferStore.getState().completeTransfer('tx-3', { bytesTransferred: 5000 });

      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
      expect(history[0].completedAt).toBeDefined();
      expect(history[0].bytesTransferred).toBe(5000);
    });

    it('should create new entry if transferId not found', () => {
      useTransferStore.getState().completeTransfer('tx-new', { fileName: 'file.txt' });

      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('tx-new');
      expect(history[0].status).toBe('completed');
    });

    it('should not create duplicate entries', () => {
      useTransferStore.getState().initiateUpload({ transferId: 'tx-dup' });
      useTransferStore.getState().completeTransfer('tx-dup');
      useTransferStore.getState().completeTransfer('tx-dup');

      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
    });
  });

  // ─── failTransfer ───────────────────────────────────────────

  describe('failTransfer', () => {
    it('should add a failed entry with error message', () => {
      useTransferStore.getState().failTransfer('tx-4', 'Connection lost', { fileName: 'fail.zip' });

      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('failed');
      expect(history[0].error).toBe('Connection lost');
      expect(history[0].failedAt).toBeDefined();
      expect(history[0].fileName).toBe('fail.zip');
    });
  });

  // ─── cancelTransfer ─────────────────────────────────────────

  describe('cancelTransfer', () => {
    it('should add a cancelled entry', () => {
      useTransferStore.getState().cancelTransfer('tx-5');

      const history = useTransferStore.getState().transferHistory;
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('cancelled');
      expect(history[0].cancelledAt).toBeDefined();
    });
  });

  // ─── clearHistory ────────────────────────────────────────────

  describe('clearHistory', () => {
    it('should remove all entries', () => {
      useTransferStore.getState().initiateUpload({ transferId: 'a' });
      useTransferStore.getState().initiateDownload({ transferId: 'b' });
      expect(useTransferStore.getState().transferHistory).toHaveLength(2);

      useTransferStore.getState().clearHistory();
      expect(useTransferStore.getState().transferHistory).toHaveLength(0);
    });
  });

  // ─── getHistory ──────────────────────────────────────────────

  describe('getHistory', () => {
    it('should return current history array', () => {
      expect(useTransferStore.getState().getHistory()).toEqual([]);

      useTransferStore.getState().initiateUpload({ transferId: 'x' });
      const history = useTransferStore.getState().getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('x');
    });
  });

  // ─── Multiple operations ─────────────────────────────────────

  describe('multiple operations', () => {
    it('should handle a full transfer lifecycle', () => {
      const { initiateUpload, completeTransfer, getHistory } = useTransferStore.getState();

      initiateUpload({ transferId: 'lifecycle-1', fileName: 'big.zip', fileSize: 1e9 });
      expect(getHistory()).toHaveLength(1);
      expect(getHistory()[0].status).toBe('uploading');

      completeTransfer('lifecycle-1', { duration: 30000 });
      expect(useTransferStore.getState().getHistory()).toHaveLength(1);
      expect(useTransferStore.getState().getHistory()[0].status).toBe('completed');
    });

    it('should handle mixed uploads and downloads', () => {
      const state = useTransferStore.getState();
      state.initiateUpload({ transferId: 'u1' });
      state.initiateDownload({ transferId: 'd1' });
      state.initiateUpload({ transferId: 'u2' });

      expect(useTransferStore.getState().transferHistory).toHaveLength(3);
      expect(useTransferStore.getState().transferHistory.filter(t => t.direction === 'upload')).toHaveLength(2);
      expect(useTransferStore.getState().transferHistory.filter(t => t.direction === 'download')).toHaveLength(1);
    });
  });
});
