// Example usage of the integrated file transfer chunking system

import { 
  initializeFileTransfer,
  initializeFileReception, 
  startFileChunking,
  processReceivedChunk,
  getTransferProgress,
  resumeTransfer,
  cleanupTransfer
} from './chunkingSystem.js';

// Example: Sender side - start file transfer
export async function startFileSending(file, peerId, webrtcConnection) {
  try {
    // 1. Initialize transfer with metadata
    const { transferId, fileMetadata, transferRecord } = await initializeFileTransfer(file, peerId);
    
    console.log('Transfer initialized:', { transferId, fileMetadata });
    
    // 2. Define chunk handler for WebRTC sending
    const onChunkReady = async ({ metadata, binaryData }) => {
      // Send metadata first
      webrtcConnection.send(JSON.stringify({
        type: 'CHUNK_METADATA',
        transferId,
        metadata
      }));
      
      // Then send binary data
      webrtcConnection.send(binaryData);
    };
    
    // 3. Define progress handler
    const onProgress = (bytesRead, totalSize) => {
      const progress = (bytesRead / totalSize) * 100;
      console.log(`Upload progress: ${progress.toFixed(2)}%`);
    };
    
    // 4. Start chunking process
    await startFileChunking(transferId, file, peerId, onChunkReady, onProgress);
    
    console.log('File chunking completed successfully');\n    return transferId;\n    \n  } catch (error) {\n    console.error('File sending failed:', error);\n    throw error;\n  }\n}\n\n// Example: Receiver side - handle file reception\nexport async function startFileReceiving(transferId, fileMetadata, peerId) {\n  try {\n    // 1. Initialize file reception\n    const fileWriter = await initializeFileReception(transferId, fileMetadata, peerId);\n    \n    console.log('File reception initialized:', fileWriter);\n    return fileWriter;\n    \n  } catch (error) {\n    console.error('File reception initialization failed:', error);\n    throw error;\n  }\n}\n\n// Example: Handle received chunks\nexport async function handleReceivedChunk(transferId, chunkData, chunkMetadata) {\n  try {\n    await processReceivedChunk(transferId, chunkData, chunkMetadata);\n    \n    // Get progress update\n    const progress = getTransferProgress(transferId);\n    if (progress.assembly) {\n      const percentage = (progress.assembly.bytesReceived / progress.assembly.totalBytes) * 100;\n      console.log(`Download progress: ${percentage.toFixed(2)}%`);\n    }\n    \n  } catch (error) {\n    console.error('Chunk processing failed:', error);\n    throw error;\n  }\n}\n\n// Example: Resume interrupted transfer\nexport async function handleTransferResume(transferId) {\n  try {\n    const resumeInfo = await resumeTransfer(transferId);\n    \n    if (resumeInfo.canResume) {\n      console.log(`Resuming transfer: ${resumeInfo.completedChunks}/${resumeInfo.totalChunks} chunks completed`);\n      return resumeInfo;\n    } else {\n      console.log('No resumable data found for transfer:', transferId);\n      return null;\n    }\n    \n  } catch (error) {\n    console.error('Transfer resume failed:', error);\n    throw error;\n  }\n}\n\n// Example: WebRTC message handler\nexport function setupWebRTCMessageHandler(webrtcConnection) {\n  webrtcConnection.onmessage = async (event) => {\n    try {\n      if (typeof event.data === 'string') {\n        // Handle JSON metadata messages\n        const message = JSON.parse(event.data);\n        \n        switch (message.type) {\n          case 'FILE_METADATA':\n            console.log('Received file metadata:', message.fileMetadata);\n            await startFileReceiving(message.transferId, message.fileMetadata, message.peerId);\n            break;\n            \n          case 'CHUNK_METADATA':\n            console.log('Received chunk metadata:', message.metadata);\n            // Store metadata for next binary chunk\n            window.pendingChunkMetadata = message.metadata;\n            break;\n            \n          case 'TRANSFER_COMPLETE':\n            console.log('Transfer completed:', message.transferId);\n            await cleanupTransfer(message.transferId, false); // Keep metadata\n            break;\n        }\n      } else if (event.data instanceof ArrayBuffer) {\n        // Handle binary chunk data\n        if (window.pendingChunkMetadata) {\n          await handleReceivedChunk(\n            window.pendingChunkMetadata.transferId,\n            new Uint8Array(event.data),\n            window.pendingChunkMetadata\n          );\n          window.pendingChunkMetadata = null;\n        }\n      }\n      \n    } catch (error) {\n      console.error('Message handling failed:', error);\n    }\n  };\n}\n\n// Example: Complete workflow\nexport async function exampleFileTransferWorkflow() {\n  // This is a complete example of how to use the system\n  \n  // Sender side:\n  // 1. User selects file\n  // const fileInput = document.querySelector('input[type=\"file\"]');\n  // const file = fileInput.files[0];\n  // \n  // 2. Establish WebRTC connection (not shown)\n  // const webrtcConnection = establishWebRTCConnection();\n  // \n  // 3. Start sending\n  // const transferId = await startFileSending(file, 'peer123', webrtcConnection);\n  \n  // Receiver side:\n  // 1. Setup message handler\n  // setupWebRTCMessageHandler(webrtcConnection);\n  // \n  // 2. File reception starts automatically when metadata is received\n  \n  console.log('Example workflow documented in code comments');\n}