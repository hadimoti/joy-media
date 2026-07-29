import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { sampleCurve } from '@joy-media/motion-core';
import type { EffectInstanceIR } from '@joy-media/render-ir';
import { applyHeadlessEffects } from '@joy-media/renderer-headless';
import { effectRegistry, type EffectInstanceV1 } from '@joy-media/visual-effects';
import { EyeIcon, FitWidthIcon, ZoomInIcon, ZoomOutIcon } from '../icons.js';

interface EffectStudioPreviewProps {
  readonly effects: readonly EffectInstanceV1[];
  readonly selectedEffectId: string | undefined;
  readonly comparisonEnabled: boolean;
  readonly playheadMs: number;
}

export function EffectStudioPreview({
  effects,
  comparisonEnabled,
  playheadMs,
}: EffectStudioPreviewProps) {
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(84);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const activeEffects = useMemo(() => effects.filter((effect) => effect.enabled), [effects]);
  const evaluatedEffects = useMemo(
    () => evaluateEffects(activeEffects, Math.round(playheadMs * 1_000)),
    [activeEffects, playheadMs],
  );
  const fallbackFilter = useMemo(() => buildCssFallbackFilter(activeEffects), [activeEffects]);
  const imageUrl = '/effects/preview/effects-test.png';
  const afterStyle = {
    '--es-split': comparisonEnabled ? `${split}%` : '0%',
  } as CSSProperties;

  useEffect(() => {
    let cancelled = false;
    setPreviewReady(false);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled || canvasRef.current === null) return;
      const canvas = canvasRef.current;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) return;
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = new Uint8Array(imageData.data);
      applyHeadlessEffects(pixels, canvas.width, canvas.height, evaluatedEffects);
      imageData.data.set(pixels);
      context.putImageData(imageData, 0, 0);
      setPreviewReady(true);
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [evaluatedEffects, imageUrl]);

  return (
    <main className="es-preview">
      <div className="es-preview-header">
        <div>
          <span className="es-live-dot" />
          Live preview
          <small>{previewReady ? 'Render-parity canvas' : 'Processing stack'}</small>
        </div>
        <div className="es-preview-time">{formatTime(playheadMs)}</div>
      </div>
      <div className="es-preview-viewport">
        <div className="es-preview-grid" />
        <div className="es-preview-frame" style={{ width: `${zoom}%` }}>
          <div className="es-preview-image es-preview-before">
            <img src={imageUrl} alt="Effect preview source" />
          </div>
          <div className="es-preview-image es-preview-after" style={afterStyle}>
            <canvas
              ref={canvasRef}
              aria-label="Processed effect stack preview"
              style={{ filter: fallbackFilter }}
            />
            {activeEffects.some((effect) => effect.effectId === 'crt') && (
              <div className="es-preview-scanlines" />
            )}
            {activeEffects.some((effect) => effect.effectId === 'vignette') && (
              <div className="es-preview-vignette" />
            )}
          </div>
          {comparisonEnabled && (
            <div className="es-split-line" style={{ left: `${split}%` }}>
              <span />
            </div>
          )}
          <div className="es-frame-label es-frame-label-before">Original</div>
          <div className="es-frame-label es-frame-label-after">Recipe</div>
        </div>
        <div className="es-preview-pipeline">
          <span className="es-pipeline-source">
            <EyeIcon /> Source
          </span>
          {activeEffects.map((effect) => (
            <span key={effect.id}>
              {effectRegistry.getEffect(effect.effectId)?.label ?? effect.effectId}
            </span>
          ))}
          <span className="es-pipeline-output">Output</span>
        </div>
      </div>
      <div className="es-preview-controls">
        <button type="button" onClick={() => setZoom((value) => Math.max(40, value - 10))}>
          <ZoomOutIcon />
        </button>
        <input
          type="range"
          min="40"
          max="100"
          value={zoom}
          aria-label="Preview zoom"
          onChange={(event) => setZoom(Number(event.currentTarget.value))}
        />
        <button type="button" onClick={() => setZoom((value) => Math.min(100, value + 10))}>
          <ZoomInIcon />
        </button>
        <button type="button" onClick={() => setZoom(84)} title="Fit preview">
          <FitWidthIcon />
        </button>
        <span>{zoom}%</span>
        {comparisonEnabled && (
          <label className="es-split-control">
            Compare
            <input
              type="range"
              min="5"
              max="95"
              value={split}
              onChange={(event) => setSplit(Number(event.currentTarget.value))}
            />
          </label>
        )}
      </div>
    </main>
  );
}

function evaluateEffects(
  effects: readonly EffectInstanceV1[],
  timeUs: number,
): readonly EffectInstanceIR[] {
  return effects.map((effect) => {
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries(effect.params)) {
      if (typeof value !== 'number') continue;
      const curve = effect.animations?.[key];
      if (curve === undefined || curve.keyframes.length === 0) {
        params[key] = value;
        continue;
      }
      try {
        params[key] = sampleCurve(curve, timeUs);
      } catch {
        params[key] = value;
      }
    }
    return {
      id: effect.id,
      kind: effect.effectId,
      enabled: effect.enabled,
      params,
    };
  });
}

function buildCssFallbackFilter(effects: readonly EffectInstanceV1[]): string {
  const filters: string[] = [];
  for (const effect of effects) {
    const number = (key: string, fallback = 0): number => {
      const value = effect.params[key];
      return typeof value === 'number' ? value : fallback;
    };
    switch (effect.effectId) {
      case 'radial-blur':
      case 'zoom-blur':
        filters.push(`blur(${number('amount') / 5}px)`);
        break;
      case 'glow':
      case 'bloom':
        filters.push(`drop-shadow(0 0 ${8 + number('amount') * 22}px rgba(79, 227, 255, .65))`);
        break;
    }
  }
  return filters.join(' ') || 'none';
}

function formatTime(timeMs: number): string {
  const seconds = Math.floor(timeMs / 1_000);
  const frames = Math.floor(((timeMs % 1_000) / 1_000) * 30);
  return `00:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}
