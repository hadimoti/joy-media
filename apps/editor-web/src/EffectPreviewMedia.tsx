import { effectPreviewUrl } from './effect-preview-url.js';

interface EffectPreviewMediaProps {
  readonly effectId: string;
  readonly className?: string;
}

/**
 * Renders the pre-rendered WebP still preview for an effect or filter card.
 * T-V07 replaces this card media with the full interactive before/after LibraryCard.
 */
export function EffectPreviewMedia({ effectId, className }: EffectPreviewMediaProps) {
  const classes = ['effect-preview-media', className, 'is-fallback']
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div
      className={classes}
      data-effect-id={effectId}
      data-preview-mounted="true"
      data-preview-playing="false"
    >
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
  );
}
