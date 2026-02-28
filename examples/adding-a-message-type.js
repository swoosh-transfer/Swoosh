/**
 * Example: Adding a Custom Message Type
 * 
 * This example shows how to add a new message type to the protocol,
 * following the proper architectural layers.
 */

// ============ STEP 1: Define Message Constant ============
// File: src/constants/messages.constants.js

/**
 * Message sent when a peer wants to request a specific file by name
 * Payload: { requestedFileName: string }
 */
export const MESSAGE_TYPE_FILE_REQUEST = 'file-request';

/**
 * Response to file request
 * Payload: { requestedFileName: string, available: boolean, fileMetadata?: Object }
 */
export const MESSAGE_TYPE_FILE_REQUEST_RESPONSE = 'file-request-response';

// ============ STEP 2: Add Message Builder to MessageService ============
// File: src/services/messaging/MessageService.js

export class MessageService {
  // ... existing code ...

  /**
   * Create a file request message
   * @param {string} fileName - Name of the requested file
   * @returns {Object} Formatted message
   * @example
   * const message = messageService.createFileRequestMessage('document.pdf');
   * messageService.send(message);
   */
  createFileRequestMessage(fileName) {
    return {
      type: MESSAGE_TYPE_FILE_REQUEST,
      payload: {
        requestedFileName: fileName,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create a file request response message
   * @param {string} fileName - Name of the file  
   * @param {boolean} available - Whether the file is available
   * @param {Object} [fileMetadata] - File metadata if available
   * @returns {Object} Formatted message
   */
  createFileRequestResponseMessage(fileName, available, fileMetadata = null) {
    return {
      type: MESSAGE_TYPE_FILE_REQUEST_RESPONSE,
      payload: {
        requestedFileName: fileName,
        available,
        fileMetadata,
      },
      timestamp: Date.now(),
    };
  }

  // ============ STEP 3: Add Message Handlers ============

  handleIncomingMessage(message) {
    switch (message.type) {
      // ... existing cases ...

      case MESSAGE_TYPE_FILE_REQUEST:
        this.handleFileRequest(message.payload);
        break;

      case MESSAGE_TYPE_FILE_REQUEST_RESPONSE:
        this.handleFileRequestResponse(message.payload);
        break;

      // ... rest of cases ...
    }
  }

  /**
   * Handle incoming file request
   * @private
   * @param {Object} payload - Message payload
   */
  handleFileRequest(payload) {
    const { requestedFileName } = payload;

    // Emit event for UI to handle
    this.emit('fileRequested', {
      fileName: requestedFileName,
      // UI can show a dialog asking user if they want to share this file
      respond: (available, fileMetadata) => {
        const response = this.createFileRequestResponseMessage(
          requestedFileName,
          available,
          fileMetadata
        );
        this.send(response);
      },
    });

    logger.log(`[MessageService] Peer requested file: ${requestedFileName}`);
  }

  /**
   * Handle file request response
   * @private
   * @param {Object} payload - Message payload
   */
  handleFileRequestResponse(payload) {
    const { requestedFileName, available, fileMetadata } = payload;

    this.emit('fileRequestResponse', {
      fileName: requestedFileName,
      available,
      metadata: fileMetadata,
    });

    if (available) {
      logger.log(`[MessageService] File available: ${requestedFileName}`);
    } else {
      logger.log(`[MessageService] File not available: ${requestedFileName}`);
    }
  }
}

// ============ STEP 4: Use in Hook/Component ============
// File: src/pages/Room/hooks/useFileRequest.js

import { useState, useEffect, useCallback } from 'react';
import { logger } from '@/utils/logger';

/**
 * Hook for requesting files from peer
 * @param {Object} messageService - MessageService instance
 * @returns {Object} File request controls
 */
export function useFileRequest(messageService) {
  const [pendingRequests, setPendingRequests] = useState(new Map());
  const [incomingRequests, setIncomingRequests] = useState([]);

  // Listen for incoming file requests
  useEffect(() => {
    const handleFileRequested = ({ fileName, respond }) => {
      setIncomingRequests((prev) => [
        ...prev,
        {
          fileName,
          timestamp: Date.now(),
          respond,
        },
      ]);
    };

    const handleFileRequestResponse = ({ fileName, available, metadata }) => {
      setPendingRequests((prev) => {
        const newMap = new Map(prev);
        const request = newMap.get(fileName);

        if (request) {
          // Resolve promise with response
          if (available) {
            request.resolve({ available: true, metadata });
          } else {
            request.reject(new Error('File not available'));
          }
          newMap.delete(fileName);
        }

        return newMap;
      });
    };

    messageService.on('fileRequested', handleFileRequested);
    messageService.on('fileRequestResponse', handleFileRequestResponse);

    return () => {
      messageService.off('fileRequested', handleFileRequested);
      messageService.off('fileRequestResponse', handleFileRequestResponse);
    };
  }, [messageService]);

  /**
   * Request a file from peer
   * @param {string} fileName - Name of file to request
   * @returns {Promise<{available: boolean, metadata: Object}>}
   */
  const requestFile = useCallback(
    (fileName) => {
      return new Promise((resolve, reject) => {
        // Store promise resolvers
        setPendingRequests((prev) => {
          const newMap = new Map(prev);
          newMap.set(fileName, { resolve, reject, timestamp: Date.now() });
          return newMap;
        });

        // Send request message
        const message = messageService.createFileRequestMessage(fileName);
        messageService.send(message);

        logger.log(`[useFileRequest] Requesting file: ${fileName}`);

        // Timeout after 30 seconds
        setTimeout(() => {
          setPendingRequests((prev) => {
            const newMap = new Map(prev);
            const request = newMap.get(fileName);
            if (request) {
              request.reject(new Error('File request timeout'));
              newMap.delete(fileName);
            }
            return newMap;
          });
        }, 30000);
      });
    },
    [messageService]
  );

  /**
   * Respond to incoming file request
   * @param {number} requestIndex - Index of request in incomingRequests array
   * @param {boolean} available - Whether file is available
   * @param {Object} [fileMetadata] - File metadata if available
   */
  const respondToRequest = useCallback(
    (requestIndex, available, fileMetadata = null) => {
      const request = incomingRequests[requestIndex];
      if (!request) return;

      // Call the respond function passed by MessageService
      request.respond(available, fileMetadata);

      // Remove from incoming requests
      setIncomingRequests((prev) => prev.filter((_, i) => i !== requestIndex));

      logger.log(
        `[useFileRequest] Responded to request for ${request.fileName}: ${available}`
      );
    },
    [incomingRequests]
  );

  return {
    requestFile,
    respondToRequest,
    pendingRequests: Array.from(pendingRequests.keys()),
    incomingRequests,
  };
}

// ============ STEP 5: Use in UI Component ============
// File: src/pages/Room/components/FileRequestSection.jsx

import React from 'react';
import { useFileRequest } from '../hooks/useFileRequest';

export function FileRequestSection({ messageService }) {
  const { requestFile, respondToRequest, incomingRequests } =
    useFileRequest(messageService);
  const [requestFileName, setRequestFileName] = React.useState('');

  const handleRequestFile = async () => {
    if (!requestFileName.trim()) return;

    try {
      const response = await requestFile(requestFileName);

      if (response.available) {
        alert(`File available! Metadata: ${JSON.stringify(response.metadata)}`);
        // Now you could automatically start receiving the file
      }
    } catch (error) {
      alert(`Request failed: ${error.message}`);
    }

    setRequestFileName('');
  };

  return (
    <div className="file-request-section">
      <h3>File Requests</h3>

      {/* Request a file from peer */}
      <div className="request-form">
        <input
          type="text"
          value={requestFileName}
          onChange={(e) => setRequestFileName(e.target.value)}
          placeholder="Enter file name to request..."
        />
        <button onClick={handleRequestFile}>Request File</button>
      </div>

      {/* Incoming requests */}
      {incomingRequests.length > 0 && (
        <div className="incoming-requests">
          <h4>Incoming Requests</h4>
          {incomingRequests.map((request, index) => (
            <div key={index} className="request-item">
              <span>Peer wants: {request.fileName}</span>
              <button onClick={() => respondToRequest(index, true, { /* metadata */ })}>
                Send File
              </button>
              <button onClick={() => respondToRequest(index, false)}>
                Decline
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ USAGE SUMMARY ============
/*
This example demonstrates:

1. ✅ Adding constants to constants/messages.constants.js
2. ✅ Creating message builders in MessageService
3. ✅ Adding message handlers in MessageService
4. ✅ Using events for loose coupling (emit/on pattern)
5. ✅ Creating a custom hook for business logic  
6. ✅ Building UI components that use the hook

Key patterns:
- Services emit events, hooks subscribe
- Promises for async request/response
- Timeout handling for robustness
- Clean separation of concerns

To use in your app:
1. Add this code to the appropriate files
2. Import and use FileRequestSection in Room/index.jsx
3. Test by requesting files between two peers
*/
