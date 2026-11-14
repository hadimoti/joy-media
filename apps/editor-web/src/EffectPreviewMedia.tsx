import { useState } from 'react';
import { effectPreviewUrl } from './effect-preview-url.js';

interface EffectPreviewMediaProps {
  readonly effectId: string;
  readonly label?: string;
  readonly className?: string;
}

/**
 * Renders the pre-rendered WebP still preview for an effect or filter card: the result only, with
 * no before picture, no labels and no slider. If the picture is missing, the card shows the
 * `is-fallback` state instead of a broken image.
 */
export function EffectPreviewMedia({ effectId, className }: EffectPreviewMediaProps) {
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
    >
      {!failed && (
        <img
          className="effect-preview-media-fallback"
          src={effectPreviewUrl(effectId)}
          alt=""
          draggable={false}
          width="320"
          height="240"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
