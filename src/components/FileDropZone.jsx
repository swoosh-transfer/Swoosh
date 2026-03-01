/**
 * FileDropZone — reusable file selection component.
 *
 * Supports:
 *   - Click to select files (multiple)
 *   - Click to select folder (webkitdirectory)
 *   - Drag-and-drop files & folders (recursive traversal)
 *   - Preserves relativePath for folder entries
 *   - Visual states: empty, dragging, files-selected
 *   - File list with remove buttons and "Clear all"
 *   - Aggregate size and count display
 *
 * Props:
 *   files       — Array<{ file: File, relativePath: string|null }>
 *   onFilesAdded(newFiles)   — called with new files to add
 *   onFileRemoved(index)     — called to remove file at index
 *   onFilesCleared()         — called to clear all files
 *   disabled    — disable interactions
 *   compact     — smaller layout for Room page
 */
import React, { useRef, useState, useCallback } from 'react';

// ─── Helpers ────────────────────────────────────────────────────────

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Recursively traverse a DataTransferItem entry to collect all files.
 * Preserves the relative directory path for each file.
 */
async function traverseEntry(entry, basePath = '') {
  const results = [];

  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    // entry.fullPath starts with "/" — strip leading slash, then remove the filename to get dir path
    const relDir = basePath || null;
    results.push({ file, relativePath: relDir });
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    // readEntries may not return all at once — loop until empty
    let entries = [];
    let batch;
    do {
      batch = await new Promise((resolve, reject) => dirReader.readEntries(resolve, reject));
      entries = entries.concat(batch);
    } while (batch.length > 0);

    const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    for (const child of entries) {
      const childResults = await traverseEntry(child, dirPath);
      results.push(...childResults);
    }
  }

  return results;
}

/**
 * Extract files from a drop event, recursively traversing directories.
 */
async function extractDroppedFiles(dataTransfer) {
  const items = dataTransfer.items;
  const results = [];

  if (items) {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.() || items[i].getAsEntry?.();
      if (entry) entries.push(entry);
    }

    for (const entry of entries) {
      const files = await traverseEntry(entry);
      results.push(...files);
    }
  }

  // Fallback: if no entry API, just use dataTransfer.files
  if (results.length === 0 && dataTransfer.files) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];
      // webkitRelativePath is available when using folder picker
      const relPath = file.webkitRelativePath
        ? file.webkitRelativePath.split('/').slice(0, -1).join('/') || null
        : null;
      results.push({ file, relativePath: relPath });
    }
  }

  return results;
}

/**
 * Extract files from an <input type="file"> change event.
 */
function extractInputFiles(fileList) {
  const results = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const relPath = file.webkitRelativePath
      ? file.webkitRelativePath.split('/').slice(0, -1).join('/') || null
      : null;
    results.push({ file, relativePath: relPath });
  }
  return results;
}

// ─── Component ──────────────────────────────────────────────────────

export default function FileDropZone({
  files = [],
  onFilesAdded,
  onFileRemoved,
  onFilesCleared,
  disabled = false,
  compact = false,
}) {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Drag handlers ──
  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (disabled) return;

    const extracted = await extractDroppedFiles(e.dataTransfer);
    if (extracted.length > 0 && onFilesAdded) {
      onFilesAdded(extracted);
    }
  }, [disabled, onFilesAdded]);

  // ── Input handlers ──
  const handleFileInputChange = useCallback((e) => {
    if (disabled || !e.target.files?.length) return;
    const extracted = extractInputFiles(e.target.files);
    if (extracted.length > 0 && onFilesAdded) {
      onFilesAdded(extracted);
    }
    // Reset input so the same files can be re-selected
    e.target.value = '';
  }, [disabled, onFilesAdded]);

  const handleFolderInputChange = useCallback((e) => {
    if (disabled || !e.target.files?.length) return;
    const extracted = extractInputFiles(e.target.files);
    if (extracted.length > 0 && onFilesAdded) {
      onFilesAdded(extracted);
    }
    e.target.value = '';
  }, [disabled, onFilesAdded]);

  // ── Computed ──
  const totalSize = files.reduce((sum, f) => sum + f.file.size, 0);
  const hasFiles = files.length > 0;

  // ── Compact layout (Room page) ──
  if (compact) {
    return (
      <div
        className={`border-2 border-dashed rounded-xl p-4 transition-all ${
          isDragging
            ? 'border-emerald-500 bg-emerald-950/30'
            : hasFiles
              ? 'border-emerald-600 bg-emerald-950/10'
              : 'border-zinc-700 hover:border-zinc-600'
        } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {hasFiles ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-300">
                {files.length} file{files.length > 1 ? 's' : ''} • {formatFileSize(totalSize)}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400 transition-colors"
                >
                  + Add
                </button>
                <button
                  onClick={onFilesCleared}
                  className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-red-400 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="max-h-32 overflow-y-auto space-y-1">
              {files.map((f, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs py-1 px-2 bg-zinc-800/50 rounded">
                  <span className="text-zinc-300 truncate flex-1 mr-2">
                    {f.relativePath ? `${f.relativePath}/` : ''}{f.file.name}
                  </span>
                  <span className="text-zinc-500 shrink-0 mr-2">{formatFileSize(f.file.size)}</span>
                  <button
                    onClick={() => onFileRemoved?.(idx)}
                    className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-zinc-400 text-sm mb-1">Drop files here or</p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300 transition-colors"
              >
                Select Files
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300 transition-colors"
              >
                Select Folder
              </button>
            </div>
          </div>
        )}

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
        <input ref={folderInputRef} type="file" webkitdirectory="" className="hidden" onChange={handleFolderInputChange} />
      </div>
    );
  }

  // ── Full layout (Home page) ──
  return (
    <div className="space-y-3">
      <div
        className={`
          border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer
          ${hasFiles
            ? 'border-emerald-600 bg-emerald-950/20'
            : isDragging
              ? 'border-emerald-500 bg-emerald-950/30 scale-[1.02]'
              : 'border-zinc-700 hover:border-zinc-600'
          }
          ${disabled ? 'opacity-50 pointer-events-none' : ''}
        `}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        {hasFiles ? (
          <div>
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-900/50 flex items-center justify-center">
              <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-zinc-100 font-medium mb-1">
              {files.length} file{files.length > 1 ? 's' : ''} selected
            </p>
            <p className="text-zinc-500 text-sm">{formatFileSize(totalSize)} total</p>
          </div>
        ) : (
          <div>
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-zinc-800 flex items-center justify-center">
              <svg className="w-6 h-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-zinc-400 mb-1">Click to select files</p>
            <p className="text-zinc-600 text-sm">or drag and drop files & folders</p>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
          disabled={disabled}
          className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          📁 Select Folder
        </button>
        {hasFiles && (
          <button
            onClick={(e) => { e.stopPropagation(); onFilesCleared?.(); }}
            disabled={disabled}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-red-400 text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            Clear All
          </button>
        )}
      </div>

      {/* File list */}
      {hasFiles && (
        <div className="max-h-48 overflow-y-auto space-y-1 border border-zinc-800 rounded-xl p-2">
          {files.map((f, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between py-1.5 px-3 bg-zinc-900 rounded-lg text-sm"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <svg className="w-4 h-4 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-zinc-300 truncate">
                  {f.relativePath ? (
                    <span className="text-zinc-500">{f.relativePath}/</span>
                  ) : null}
                  {f.file.name}
                </span>
              </div>
              <span className="text-zinc-500 text-xs shrink-0 mx-2">{formatFileSize(f.file.size)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onFileRemoved?.(idx); }}
                className="text-zinc-600 hover:text-red-400 transition-colors shrink-0 p-1"
                title="Remove file"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden inputs */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
      <input ref={folderInputRef} type="file" webkitdirectory="" className="hidden" onChange={handleFolderInputChange} />
    </div>
  );
}
