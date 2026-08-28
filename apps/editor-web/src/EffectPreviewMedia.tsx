import { useEffect, useRef, useState } from 'react';
import { effectMotionPreviewUrl, effectPreviewUrl } from './effect-preview-url.js';

interface EffectPreviewMediaProps {
  readonly effectId: string;
  readonly className?: string | undefined;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** A muted loop keeps the catalog alive without requiring a timeline selection. */
export function EffectPreviewMedia({ effectId, className }: EffectPreviewMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fallback, setFallback] = useState(() => prefersReducedMotion() || isDocumentHidden());

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const shouldUseFallback = () => prefersReducedMotion() || isDocumentHidden();
    setFallback(shouldUseFallback());
    if (shouldUseFallback()) return;

    let disposed = false;
    const showFallback = () => {
      if (!disposed) setFallback(true);
    };
    const start = () => {
      if (disposed || shouldUseFallback()) return;
      // Autoplay can be rejected by browser policy. The poster is a stable,
      // deterministic rendering path for that case rather than a blank card.
      if (typeof video.play !== 'function') {
        showFallback();
        return;
      }
      void video.play().catch(showFallback);
    };
    const onVisibilityChange = () => {
      if (isDocumentHidden()) showFallback();
      else if (!shouldUseFallback()) start();
    };
    const mediaQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : undefined;
    const onMotionPreferenceChange = () => {
      if (shouldUseFallback()) showFallback();
    };

    start();
    video.addEventListener('canplay', start);
    document.addEventListener('visibilitychange', onVisibilityChange);
    mediaQuery?.addEventListener?.('change', onMotionPreferenceChange);
    mediaQuery?.addListener?.(onMotionPreferenceChange);
    return () => {
      disposed = true;
      video.removeEventListener('canplay', start);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      mediaQuery?.removeEventListener?.('change', onMotionPreferenceChange);
      mediaQuery?.removeListener?.(onMotionPreferenceChange);
    };
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
