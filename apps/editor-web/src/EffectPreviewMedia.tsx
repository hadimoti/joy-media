import { useEffect, useRef, useState } from 'react';
import { effectMotionPreviewUrl, effectPreviewUrl } from './effect-preview-url.js';
import {
  acquireEffectPreviewMount,
  acquireEffectPreviewPlayback,
  createEffectPreviewToken,
} from './effect-preview-coordinator.js';

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

/**
 * A poster-first preview that only mounts near the viewport and participates
 * in a bounded mount/playback queue. The catalog can contain many effects,
 * but the browser never needs to decode all of them at once.
 */
export function EffectPreviewMedia({ effectId, className }: EffectPreviewMediaProps) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tokenRef = useRef<string | undefined>(undefined);
  if (tokenRef.current === undefined) tokenRef.current = createEffectPreviewToken();
  const token = tokenRef.current;
  const [nearViewport, setNearViewport] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [documentHidden, setDocumentHidden] = useState(isDocumentHidden);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    const element = mediaRef.current;
    if (element === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry?.isIntersecting === true),
      { threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const mediaQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : undefined;
    const updateVisibility = () => setDocumentHidden(isDocumentHidden());
    const updateMotion = () => setReducedMotion(prefersReducedMotion());
    document.addEventListener('visibilitychange', updateVisibility);
    mediaQuery?.addEventListener?.('change', updateMotion);
    if (mediaQuery?.addEventListener === undefined) mediaQuery?.addListener?.(updateMotion);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      mediaQuery?.removeEventListener?.('change', updateMotion);
      if (mediaQuery?.removeEventListener === undefined) mediaQuery?.removeListener?.(updateMotion);
    };
  }, []);

  useEffect(() => {
    if (!nearViewport) {
      setMounted(false);
      return;
    }
    return acquireEffectPreviewMount(token, () => setMounted(true));
  }, [nearViewport, token]);

  const blocked = documentHidden || reducedMotion || playbackFailed;
  useEffect(() => {
    if (!nearViewport || !mounted || blocked) {
      setPlaying(false);
      return;
    }
    return acquireEffectPreviewPlayback(token, () => setPlaying(true));
  }, [blocked, mounted, nearViewport, token]);

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || video === null) return;
    let disposed = false;
    const fail = () => {
      if (!disposed) setPlaybackFailed(true);
    };
    try {
      const result = video.play();
      result?.catch(fail);
    } catch {
      fail();
    }
    return () => {
      disposed = true;
      video.pause();
    };
  }, [playing]);

  useEffect(() => {
    if (!blocked) return;
    videoRef.current?.pause();
  }, [blocked]);

  const showVideo = mounted && nearViewport && playing && !blocked;
  const showPoster = mounted && !showVideo;
  const classes = ['effect-preview-media', className, showPoster ? 'is-fallback' : undefined]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div
      ref={mediaRef}
      className={classes}
      data-effect-id={effectId}
      data-preview-mounted={mounted ? 'true' : 'false'}
      data-preview-playing={showVideo ? 'true' : 'false'}
    >
      {!mounted ? (
        <div className="effect-preview-media-placeholder" aria-hidden="true" />
      ) : showPoster ? (
        <img
          className="effect-preview-media-fallback"
          src={effectPreviewUrl(effectId)}
          alt=""
          width="192"
          height="192"
          loading="lazy"
          decoding="async"
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
          onError={() => setPlaybackFailed(true)}
        />
      )}
      {showVideo && (
        <span
          className="effect-preview-media-treatment"
          aria-hidden="true"
          style={{ backgroundImage: `url(${effectPreviewUrl(effectId)})` }}
        />
      )}
      {playbackFailed && mounted && nearViewport && (
        <button
          type="button"
          className="effect-preview-media-retry"
          aria-label="Retry motion preview"
          title="Retry motion preview"
          onClick={(event) => {
            event.stopPropagation();
            setPlaybackFailed(false);
          }}
        >
          ↻
        </button>
      )}
    </div>
  );
}
