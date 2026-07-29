import { useMemo, useState, type CSSProperties } from 'react';
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
  selectedEffectId,
  comparisonEnabled,
  playheadMs,
}: EffectStudioPreviewProps) {
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(84);
  const activeEffects = effects.filter((effect) => effect.enabled);
  const selected = effects.find((effect) => effect.id === selectedEffectId) ?? activeEffects.at(-1);
  const sourceId = selected?.effectId ?? 'effects-test';
  const filter = useMemo(() => buildCssFilter(activeEffects), [activeEffects]);
  const imageUrl = `/effects/preview/${sourceId}.png`;
  const afterStyle = {
    filter,
    '--es-split': comparisonEnabled ? `${split}%` : '100%',
  } as CSSProperties;

  return (
    <main className="es-preview">
      <div className="es-preview-header">
        <div>
          <span className="es-live-dot" />
          Live preview
          <small>GPU pipeline proxy</small>
        </div>
        <div className="es-preview-time">{formatTime(playheadMs)}</div>
      </div>
      <div className="es-preview-viewport">
        <div className="es-preview-grid" />
        <div className="es-preview-frame" style={{ width: `${zoom}%` }}>
          <div className="es-preview-image es-preview-before">
            <img src={imageUrl} alt="Effect preview source" />
            <div className="es-preview-aurora" />
          </div>
          <div className="es-preview-image es-preview-after" style={afterStyle}>
            <img src={imageUrl} alt="" />
            <div className="es-preview-aurora" />
            {activeEffects.some((effect) => effect.effectId === 'noise') && (
              <div className="es-preview-noise" />
            )}
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

function buildCssFilter(effects: readonly EffectInstanceV1[]): string {
  const filters: string[] = [];
  for (const effect of effects) {
    const number = (key: string, fallback = 0): number => {
      const value = effect.params[key];
      return typeof value === 'number' ? value : fallback;
    };
    switch (effect.effectId) {
      case 'brightness-contrast':
        filters.push(
          `brightness(${Math.max(0, 1 + number('brightness'))})`,
          `contrast(${Math.max(0, 1 + number('contrast'))})`,
        );
        break;
      case 'hue-saturation':
        filters.push(
          `hue-rotate(${number('hue') * 360}deg)`,
          `saturate(${Math.max(0, 1 + number('saturation'))})`,
        );
        break;
      case 'vibrance':
        filters.push(`saturate(${Math.max(0, 1 + number('amount'))})`);
        break;
      case 'sepia':
        filters.push(`sepia(${number('amount', 0.5)})`);
        break;
      case 'gaussian-blur':
      case 'radial-blur':
      case 'zoom-blur':
        filters.push(`blur(${number('amount') / 5}px)`);
        break;
      case 'glow':
      case 'bloom':
        filters.push(`drop-shadow(0 0 ${8 + number('amount') * 22}px rgba(79, 227, 255, .65))`);
        break;
      case 'posterize':
        filters.push(`contrast(${1.15 + number('levels') / 80})`);
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
