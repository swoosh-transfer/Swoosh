import idb from './indexedDB.js';
import fs from './fileSystem.js';

const CHUNK_SIZE = fs.CHUNK_SIZE;

export function generateUUID() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  // fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createFileMetadata({ name, size, type, lastModified }) {
  const fileId = generateUUID();
  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  return {
    fileId,
    name,
    size,
    type,
    lastModified,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    createdAt: Date.now(),
  };
}

export async function saveFileMetadata(fileMeta) {
  // store in files store for later lookup
  return idb.saveFileMeta(fileMeta);
}

export async function createTransferRecord({ transferId, fileMeta, peerId }) {
  const record = {
    transferId: transferId || generateUUID(),
    fileId: fileMeta.fileId,
    fileName: fileMeta.name,
    size: fileMeta.size,
    chunkSize: fileMeta.chunkSize,
    totalChunks: fileMeta.totalChunks,
    sentChunks: 0,
    receivedChunks: 0,
    status: 'pending', // pending | in-progress | completed | cancelled
    peerId: peerId || null,
    createdAt: Date.now(),
  };
  await idb.saveTransferMeta(record);
  return record;
}

export async function updateTransferProgress(transferId, patch) {
  return idb.updateTransferMeta(transferId, patch);
}

export default {
  generateUUID,
  createFileMetadata,
  saveFileMetadata,
  createTransferRecord,
  updateTransferProgress,
};
