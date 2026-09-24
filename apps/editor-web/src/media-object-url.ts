import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react';

export type MediaObjectUrlConsumer = HTMLImageElement | HTMLMediaElement | HTMLSourceElement;

/** Clear a media consumer before releasing the object URL it may still load. */
export function clearMediaSource(element: MediaObjectUrlConsumer | null): void {
  if (element === null) return;
  if (typeof HTMLSourceElement !== 'undefined' && element instanceof HTMLSourceElement) {
    const parent = element.parentElement;
    element.removeAttribute('src');
    if (typeof HTMLMediaElement !== 'undefined' && parent instanceof HTMLMediaElement) {
      parent.pause();
      parent.load();
    }
    return;
  }
  if ('pause' in element && 'load' in element) {
    const media = element as HTMLMediaElement;
    media.pause();
    media.removeAttribute('src');
    media.removeAttribute('poster');
    media.load();
    return;
  }
  element.removeAttribute('src');
}

export function releaseMediaObjectUrl(
  element: MediaObjectUrlConsumer | null,
  url: string,
  revoke: (url: string) => void = (value) => URL.revokeObjectURL(value),
): void {
  if (
    element?.getAttribute('src') === url ||
    (typeof HTMLVideoElement !== 'undefined' &&
      element instanceof HTMLVideoElement &&
      element.getAttribute('poster') === url)
  )
    clearMediaSource(element);
  revoke(url);
}

/** Revoke a URL that was never attached to a mounted DOM media consumer. */
export function revokeDetachedObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/** Own a DOM-backed URL and detach its consumer before releasing it on replace or unmount. */
export function useReleasableObjectUrl<T extends MediaObjectUrlConsumer>(
  url: string | undefined,
  relatedUrl?: string,
  revoke: (url: string) => void = revokeDetachedObjectUrl,
): RefCallback<T> {
  const elementRef = useRef<T | null>(null);
  const currentUrlsRef = useRef({ url, relatedUrl, revoke });
  currentUrlsRef.current = { url, relatedUrl, revoke };
  const revokedUrlsRef = useRef(new Set<string>());
  const revokeMapRef = useRef(new Map<string, (url: string) => void>());
  const pendingReleaseSeqRef = useRef(0);

  if (url !== undefined) revokeMapRef.current.set(url, revoke);
  if (relatedUrl !== undefined) revokeMapRef.current.set(relatedUrl, revoke);

  const releaseImmediate = useCallback(
    (element: T | null, targetUrl: string | undefined): void => {
      if (targetUrl === undefined) return;
      if (
        element?.getAttribute('src') === targetUrl ||
        (typeof HTMLVideoElement !== 'undefined' &&
          element instanceof HTMLVideoElement &&
          element.getAttribute('poster') === targetUrl)
      ) {
        clearMediaSource(element);
      }
      if (!revokedUrlsRef.current.has(targetUrl)) {
        revokedUrlsRef.current.add(targetUrl);
        const doRevoke = revokeMapRef.current.get(targetUrl) ?? revoke;
        doRevoke(targetUrl);
      }
    },
    [revoke],
  );
  const callbackRef = useCallback((element: T | null): void => {
    // Keep the last node when React temporarily removes a conditional consumer.
    // The URL remains owned until it changes or the hook's owner unmounts.
    if (element !== null) elementRef.current = element;
  }, []);

  useLayoutEffect(() => {
    pendingReleaseSeqRef.current += 1;
    return () => {
      const element = elementRef.current;
      const next = currentUrlsRef.current;

      const shouldDeferUrl = url !== undefined && next.url === url;
      const shouldDeferRelated =
        relatedUrl !== undefined && relatedUrl !== url && next.relatedUrl === relatedUrl;

      if (url !== undefined && !shouldDeferUrl) {
        releaseImmediate(element, url);
      }
      if (relatedUrl !== undefined && relatedUrl !== url && !shouldDeferRelated) {
        releaseImmediate(element, relatedUrl);
      }

      if (!shouldDeferUrl && !shouldDeferRelated) return;

      const releaseId = ++pendingReleaseSeqRef.current;
      queueMicrotask(() => {
        if (pendingReleaseSeqRef.current === releaseId) {
          const consumer = elementRef.current;
          if (shouldDeferUrl) {
            releaseImmediate(consumer, url);
          }
          if (shouldDeferRelated) {
            releaseImmediate(consumer, relatedUrl);
          }
        }
      });
    };
  }, [relatedUrl, releaseImmediate, url]);

  return callbackRef;
}
