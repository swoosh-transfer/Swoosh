/**
 * SpeedGraph — Real-time transfer speed chart using canvas.
 * Shows throughput over the last 30 seconds.
 */
import React, { useRef, useEffect, useCallback } from 'react';
import { formatBytes } from '../../../lib/formatters.js';

const MAX_SAMPLES = 30;
const GRAPH_HEIGHT = 80;
const GRAPH_PADDING = { top: 8, right: 8, bottom: 16, left: 48 };

export default function SpeedGraph({ speed = 0, isActive = false }) {
  const canvasRef = useRef(null);
  const samplesRef = useRef([]);
  const animFrameRef = useRef(null);

  // Collect speed samples (once per second via parent re-renders)
  const prevSpeedRef = useRef(speed);
  useEffect(() => {
    if (!isActive) return;
    // Only push when speed actually changes (avoids duplicate 0s)
    if (speed !== prevSpeedRef.current || samplesRef.current.length === 0) {
      samplesRef.current.push(speed);
      if (samplesRef.current.length > MAX_SAMPLES) {
        samplesRef.current.shift();
      }
      prevSpeedRef.current = speed;
    }
  }, [speed, isActive]);

  // Reset samples when transfer stops
  useEffect(() => {
    if (!isActive) {
      samplesRef.current = [];
    }
  }, [isActive]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // Size canvas to container
    canvas.width = rect.width * dpr;
    canvas.height = GRAPH_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = GRAPH_HEIGHT;
    const gw = w - GRAPH_PADDING.left - GRAPH_PADDING.right;
    const gh = h - GRAPH_PADDING.top - GRAPH_PADDING.bottom;

    // Clear
    ctx.clearRect(0, 0, w, h);

    const samples = samplesRef.current;
    if (samples.length < 2) {
      ctx.fillStyle = '#52525b';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for data...', w / 2, h / 2);
      animFrameRef.current = requestAnimationFrame(draw);
      return;
    }

    const maxSpeed = Math.max(...samples, 1);

    // Y-axis labels
    ctx.fillStyle = '#71717a';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${formatBytes(maxSpeed)}/s`, GRAPH_PADDING.left - 4, GRAPH_PADDING.top + 8);
    ctx.fillText('0', GRAPH_PADDING.left - 4, h - GRAPH_PADDING.bottom);

    // Grid lines
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = GRAPH_PADDING.top + (gh * i) / 4;
      ctx.beginPath();
      ctx.moveTo(GRAPH_PADDING.left, y);
      ctx.lineTo(w - GRAPH_PADDING.right, y);
      ctx.stroke();
    }

    // Draw speed line
    const toX = (i) => GRAPH_PADDING.left + (i / (MAX_SAMPLES - 1)) * gw;
    const toY = (v) => GRAPH_PADDING.top + gh - (v / maxSpeed) * gh;
    const startIdx = MAX_SAMPLES - samples.length;

    // Fill area under curve
    ctx.beginPath();
    ctx.moveTo(toX(startIdx), GRAPH_PADDING.top + gh);
    samples.forEach((v, i) => {
      ctx.lineTo(toX(startIdx + i), toY(v));
    });
    ctx.lineTo(toX(startIdx + samples.length - 1), GRAPH_PADDING.top + gh);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, GRAPH_PADDING.top, 0, h - GRAPH_PADDING.bottom);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    samples.forEach((v, i) => {
      const x = toX(startIdx + i);
      const y = toY(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Current value dot
    if (samples.length > 0) {
      const last = samples[samples.length - 1];
      const lx = toX(startIdx + samples.length - 1);
      const ly = toY(last);
      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();
    }

    // X-axis time label
    ctx.fillStyle = '#52525b';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${MAX_SAMPLES}s ago`, GRAPH_PADDING.left, h - 2);
    ctx.fillText('now', w - GRAPH_PADDING.right, h - 2);

    animFrameRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    if (isActive) {
      animFrameRef.current = requestAnimationFrame(draw);
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isActive, draw]);

  if (!isActive) return null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-500">Speed</span>
        <span className="text-xs text-emerald-400 font-mono">
          {formatBytes(speed)}/s
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height: GRAPH_HEIGHT }}
      />
    </div>
  );
}
