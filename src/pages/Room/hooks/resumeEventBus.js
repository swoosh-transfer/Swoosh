/**
 * Resume Event Bus
 * 
 * Lightweight event emitter to decouple useMessages <-> useResumeTransfer.
 * Breaks circular dependency by using publish/subscribe pattern.
 * 
 * Events:
 * - 'resumeAccepted': { transferId, startFromChunk, totalChunks }
 * - 'resumeRejected': { transferId, reason }
 * - 'resumeRequest': { transferId, fileName, fileSize, fileHash, totalChunks, chunkBitmap, inRoom }
 */

class ResumeEventBus {
  constructor() {
    this.listeners = new Map();
  }

  /**
   * Subscribe to an event
   * @param {string} eventName 
   * @param {Function} handler 
   * @returns {Function} Unsubscribe function
   */
  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(handler);
    
    // Return unsubscribe function
    return () => {
      const handlers = this.listeners.get(eventName);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.listeners.delete(eventName);
        }
      }
    };
  }

  /**
   * Emit an event to all subscribers
   * @param {string} eventName 
   * @param {*} data 
   */
  emit(eventName, data) {
    const handlers = this.listeners.get(eventName);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[ResumeEventBus] Error in ${eventName} handler:`, error);
        }
      });
    }
  }

  /**
   * Clear all listeners (for cleanup)
   */
  clear() {
    this.listeners.clear();
  }
}

// Singleton instance shared across hooks in the same room
export const resumeEventBus = new ResumeEventBus();
