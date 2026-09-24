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
  const ownedUrlsRef = useRef({ url, relatedUrl });
  const releasedUrlsRef = useRef(new Set<string>());
  const release = useCallback(
    (element: T | null, targetUrl: string | undefined): void => {
      if (targetUrl === undefined || releasedUrlsRef.current.has(targetUrl)) return;
      releaseMediaObjectUrl(element, targetUrl, revoke);
      releasedUrlsRef.current.add(targetUrl);
    },
    [revoke],
  );
  const callbackRef = useCallback((element: T | null): void => {
    // Keep the last node when React temporarily removes a conditional consumer.
    // The URL remains owned until it changes or the hook's owner unmounts.
    if (element !== null) elementRef.current = element;
  }, []);

  useLayoutEffect(() => {
    ownedUrlsRef.current = { url, relatedUrl };
    if (url !== undefined) releasedUrlsRef.current.delete(url);
    if (relatedUrl !== undefined) releasedUrlsRef.current.delete(relatedUrl);
    return () => {
      const element = elementRef.current;
      release(element, url);
      if (relatedUrl !== url) release(element, relatedUrl);
    };
  }, [relatedUrl, release, url]);

  return callbackRef;
}
