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

export interface ReleasableObjectUrlRefCallback<
  T extends MediaObjectUrlConsumer,
> extends RefCallback<T> {
  /** Test-only accessor for the number of URLs currently tracked by internal bookkeeping. */
  testOnlyGetRetainedUrlCount?: () => number;
}

/** Own a DOM-backed URL and detach its consumer before releasing it on replace or unmount. */
export interface PendingObjectUrlOwner {
  /**
   * Track a newly created URL (and optional related URL) pending adoption by React commit.
   * Any previously pending unadopted URLs are superseded and revoked.
   * Returns the primary tracked URL.
   */
  track(url: string, revoke?: (url: string) => void): string;
  track(url: string, relatedUrl: string | undefined, revoke?: (url: string) => void): string;
  track<U extends string | undefined>(
    url: U,
    relatedOrRevoke?: string | ((url: string) => void),
    maybeRevoke?: (url: string) => void,
  ): U;

  /**
   * Track multiple newly created URLs in one operation.
   * Any previously pending unadopted URLs not in this batch are superseded and revoked.
   */
  trackAll(urls: readonly (string | undefined)[], revoke?: (url: string) => void): void;

  /**
   * Mark URL(s) as adopted once committed (e.g. in a layout effect or hook).
   * Adopted URLs will no longer be revoked by `revokePending()`.
   */
  adopt(url: string | undefined, ...relatedUrls: (string | undefined)[]): void;

  /**
   * Revoke all pending URLs that were never adopted.
   * Safe to call on effect cleanup or component unmount.
   */
  revokePending(): void;

  /**
   * Number of pending URLs currently tracked (useful for tests and inspection).
   */
  readonly pendingCount: number;
}

/**
 * Creates an owner for object URLs that are created asynchronously before their
 * component state update commits.
 */
export function createPendingObjectUrlOwner(
  defaultRevoke: (url: string) => void = revokeDetachedObjectUrl,
): PendingObjectUrlOwner {
  const pending = new Map<string, (url: string) => void>();

  const revokeAll = (): void => {
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [url, revoke] of entries) {
      revoke(url);
    }
  };

  return {
    track<U extends string | undefined>(
      url: U,
      relatedOrRevoke?: string | ((url: string) => void),
      maybeRevoke?: (url: string) => void,
    ): U {
      let relatedUrl: string | undefined;
      let revoke: (url: string) => void = defaultRevoke;
      if (typeof relatedOrRevoke === 'function') {
        revoke = relatedOrRevoke;
      } else if (typeof relatedOrRevoke === 'string') {
        relatedUrl = relatedOrRevoke;
        if (typeof maybeRevoke === 'function') {
          revoke = maybeRevoke;
        }
      } else if (typeof maybeRevoke === 'function') {
        revoke = maybeRevoke;
      }

      const nextUrls = [url, relatedUrl].filter((u): u is string => typeof u === 'string');
      const nextSet = new Set(nextUrls);
      for (const [pendingUrl, doRevoke] of Array.from(pending.entries())) {
        if (!nextSet.has(pendingUrl)) {
          pending.delete(pendingUrl);
          doRevoke(pendingUrl);
        }
      }
      for (const u of nextUrls) {
        pending.set(u, revoke);
      }
      return url;
    },

    trackAll(
      urls: readonly (string | undefined)[],
      revoke: (url: string) => void = defaultRevoke,
    ): void {
      const nextUrls = urls.filter((u): u is string => typeof u === 'string');
      const nextSet = new Set(nextUrls);
      for (const [pendingUrl, doRevoke] of Array.from(pending.entries())) {
        if (!nextSet.has(pendingUrl)) {
          pending.delete(pendingUrl);
          doRevoke(pendingUrl);
        }
      }
      for (const u of nextUrls) {
        pending.set(u, revoke);
      }
    },

    adopt(url: string | undefined, ...relatedUrls: (string | undefined)[]): void {
      if (url !== undefined) pending.delete(url);
      for (const related of relatedUrls) {
        if (related !== undefined) pending.delete(related);
      }
    },

    revokePending(): void {
      revokeAll();
    },

    get pendingCount(): number {
      return pending.size;
    },
  };
}

/**
 * Hook managing pending object URLs created during async operations before
 * state updates commit. Automatically revokes unadopted pending URLs on unmount.
 */
export function usePendingObjectUrlOwner(
  defaultRevoke: (url: string) => void = revokeDetachedObjectUrl,
): PendingObjectUrlOwner {
  const defaultRevokeRef = useRef(defaultRevoke);
  defaultRevokeRef.current = defaultRevoke;
  const ownerRef = useRef<PendingObjectUrlOwner | null>(null);
  if (ownerRef.current === null) {
    ownerRef.current = createPendingObjectUrlOwner((url) => defaultRevokeRef.current(url));
  }
  const owner = ownerRef.current;

  useLayoutEffect(() => {
    return () => {
      owner.revokePending();
    };
  }, [owner]);

  return owner;
}

/** Own a DOM-backed URL and detach its consumer before releasing it on replace or unmount. */
export function useReleasableObjectUrl<T extends MediaObjectUrlConsumer>(
  url: string | undefined,
  relatedUrl?: string,
  revoke: (url: string) => void = revokeDetachedObjectUrl,
  pendingOwner?: PendingObjectUrlOwner,
): ReleasableObjectUrlRefCallback<T> {
  const elementRef = useRef<T | null>(null);
  const currentUrlsRef = useRef({ url, relatedUrl, revoke });
  currentUrlsRef.current = { url, relatedUrl, revoke };
  const revokeMapRef = useRef(new Map<string, (url: string) => void>());
  const pendingReleaseSeqRef = useRef(0);

  if (url !== undefined) revokeMapRef.current.set(url, revoke);
  if (relatedUrl !== undefined) revokeMapRef.current.set(relatedUrl, revoke);

  const releaseImmediate = useCallback((element: T | null, targetUrl: string | undefined): void => {
    if (targetUrl === undefined) return;
    if (
      element?.getAttribute('src') === targetUrl ||
      (typeof HTMLVideoElement !== 'undefined' &&
        element instanceof HTMLVideoElement &&
        element.getAttribute('poster') === targetUrl)
    ) {
      clearMediaSource(element);
    }
    const doRevoke = revokeMapRef.current.get(targetUrl);
    if (doRevoke !== undefined) {
      revokeMapRef.current.delete(targetUrl);
      doRevoke(targetUrl);
    }
  }, []);
  const callbackRef = useCallback((element: T | null): void => {
    // Keep the last node when React temporarily removes a conditional consumer.
    // The URL remains owned until it changes or the hook's owner unmounts.
    if (element !== null) elementRef.current = element;
  }, []) as ReleasableObjectUrlRefCallback<T>;
  callbackRef.testOnlyGetRetainedUrlCount = () => revokeMapRef.current.size;

  useLayoutEffect(() => {
    pendingOwner?.adopt(url, relatedUrl);
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
  }, [pendingOwner, relatedUrl, releaseImmediate, url]);

  return callbackRef;
}
