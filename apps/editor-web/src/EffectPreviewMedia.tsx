import { useState } from 'react';
import { effectBeforePreviewUrl, effectPreviewUrl } from './effect-preview-url.js';

interface EffectPreviewMediaProps {
  readonly effectId: string;
  readonly label?: string;
  readonly className?: string;
}

/**
 * Renders the pre-rendered WebP still preview for an effect or filter card.
 * T-V07 replaces this card media with the full interactive before/after LibraryCard.
 */
export function EffectPreviewMedia({ effectId, label, className }: EffectPreviewMediaProps) {
  const [split, setSplit] = useState(50);
  const classes = ['effect-preview-media', 'library-compare-preview', className]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div
      className={classes}
      data-effect-id={effectId}
      data-preview-mounted="true"
      data-preview-playing="false"
      data-preview-before-after="true"
    >
      <img
        className="library-compare-before"
        src={effectBeforePreviewUrl()}
        alt=""
        width="320"
        height="240"
        loading="lazy"
        decoding="async"
      />
      <div className="library-compare-after" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
        <img
          className="effect-preview-media-fallback"
          src={effectPreviewUrl(effectId)}
          alt=""
          width="320"
          height="240"
          loading="lazy"
          decoding="async"
        />
      </div>
      <span className="library-compare-label library-compare-label--before" aria-hidden="true">
        Before
      </span>
      <span className="library-compare-label library-compare-label--after" aria-hidden="true">
        After
      </span>
      <span className="library-compare-divider" style={{ left: `${split}%` }} aria-hidden="true" />
      <input
        className="library-compare-slider"
        type="range"
        min={0}
        max={100}
        value={split}
        aria-label={`Before and after preview for ${label ?? effectId}`}
        title="Drag to compare before and after"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setSplit(Number(event.currentTarget.value))}
      />
    </div>
  );
}
