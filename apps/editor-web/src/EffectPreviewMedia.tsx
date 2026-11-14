import { useState } from 'react';
import { effectBeforePreviewUrl, effectPreviewUrl } from './effect-preview-url.js';

interface EffectPreviewMediaProps {
  readonly effectId: string;
  readonly label?: string;
  readonly className?: string;
}

/**
 * Renders the pre-rendered WebP still preview for an effect or filter card as a
 * before/after comparison. If either picture is missing, the card shows the
 * `is-fallback` state instead of a broken image.
 */
export function EffectPreviewMedia({ effectId, label, className }: EffectPreviewMediaProps) {
  const [split, setSplit] = useState(50);
  const [failed, setFailed] = useState(false);
  const classes = [
    'effect-preview-media',
    'library-compare-preview',
    failed ? 'is-fallback' : undefined,
    className,
  ]
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
      {!failed && (
        <>
          <img
            className="library-compare-before"
            src={effectBeforePreviewUrl()}
            alt=""
            width="320"
            height="240"
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
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
              onError={() => setFailed(true)}
            />
          </div>
          <span className="library-compare-label library-compare-label--before" aria-hidden="true">
            Before
          </span>
          <span className="library-compare-label library-compare-label--after" aria-hidden="true">
            After
          </span>
          <span
            className="library-compare-divider"
            style={{ left: `${split}%` }}
            aria-hidden="true"
          />
          <input
            className="library-compare-slider"
            type="range"
            min={0}
            max={100}
            value={split}
            aria-label={`Before and after preview for ${label ?? effectId}`}
            aria-valuetext={`Before ${split}%, after ${100 - split}%`}
            title="Drag to compare before and after"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setSplit(Number(event.currentTarget.value))}
          />
        </>
      )}
    </div>
  );
}
