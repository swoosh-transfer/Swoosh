/**
 * TextShareSection — Send/receive text snippets via DataChannel
 */
import React, { useState, useRef, useEffect } from 'react';

export default function TextShareSection({ messages, onSend, disabled }) {
  const [text, setText] = useState('');
  const [copiedIdx, setCopiedIdx] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCopy = async (content, idx) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-3">💬 Text Share</h2>

      {/* Message list */}
      {messages.length > 0 && (
        <div className="max-h-40 overflow-y-auto mb-3 space-y-2 scrollbar-thin">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-2 ${msg.fromSelf ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`relative group max-w-[85%] px-3 py-2 rounded-lg text-sm break-words ${
                  msg.fromSelf
                    ? 'bg-emerald-900/40 text-emerald-200 border border-emerald-800/50'
                    : 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
                <div className="flex items-center justify-between mt-1 gap-2">
                  <span className="text-[10px] text-zinc-500">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button
                    onClick={() => handleCopy(msg.content, i)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    {copiedIdx === i ? '✓' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input */}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? 'Connect to share text...' : 'Type a message...'}
          rows={1}
          className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-emerald-600 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-sm font-medium transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
