import { useEffect, useRef, useState } from 'react';
import { effectMotionPreviewUrl, effectPreviewUrl } from './effect-preview-url.js';

interface EffectPreviewMediaProps {
  readonly effectId: string;
  readonly className?: string | undefined;
}

/** A muted loop keeps the catalog alive without requiring a timeline selection. */
export function EffectPreviewMedia({ effectId, className }: EffectPreviewMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const start = () => void video.play().catch(() => undefined);
    start();
    video.addEventListener('canplay', start);
    return () => video.removeEventListener('canplay', start);
  }, [effectId]);

  const classes = ['effect-preview-media', className, fallback ? 'is-fallback' : undefined]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div className={classes} data-effect-id={effectId}>
      {fallback ? (
        <img
          className="effect-preview-media-fallback"
          src={effectPreviewUrl(effectId)}
          alt=""
          width="192"
          height="192"
        />
      ) : (
        <video
          ref={videoRef}
          className="effect-preview-media-video"
          src={effectMotionPreviewUrl(effectId)}
          poster={effectPreviewUrl(effectId)}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          onError={() => setFallback(true)}
        />
      )}
      {!fallback && (
        <img
          className="effect-preview-media-treatment"
          src={effectPreviewUrl(effectId)}
          alt=""
          width="120"
          height="120"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
