// @vitest-environment jsdom
import { act, StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMediaSource,
  useReleasableObjectUrl as useMediaObjectUrl,
  type MediaObjectUrlConsumer,
} from './media-object-url.js';
import { ProjectMediaResolver } from './project-media-resolver.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setupContainer(): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return container;
}

describe('useReleasableObjectUrl React lifecycle', () => {
  it('removes video src and poster before revoke on replace and unmount, outside state updaters', async () => {
    const target = setupContainer();
    const events: string[] = [];
    const owners = new Map<string, HTMLVideoElement>();
    let updatingState = false;
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      expect(updatingState).toBe(false);
      const video = owners.get(url) ?? target.querySelector('video');
      if (video !== null) {
        // On replace React reuses the node with the new src; what matters is
        // that nothing still references the URL being revoked.
        expect(video.getAttribute('src')).not.toBe(url);
        expect(video.getAttribute('poster')).not.toBe(url);
      }
      events.push(`revoke:${url}`);
    });
    function Harness() {
      const [url, setUrl] = useState('blob:first');
      const videoRef = useMediaObjectUrl<HTMLVideoElement>(url, `poster:${url}`);
      return (
        <>
          <video ref={videoRef} src={url} poster={`poster:${url}`} />
          <button
            onClick={() =>
              setUrl((current) => {
                updatingState = true;
                events.push(`updater:${current}`);
                try {
                  return 'blob:second';
                } finally {
                  updatingState = false;
                }
              })
            }
          />
        </>
      );
    }
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => events.push('pause'));
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => events.push('load'));
    await act(async () => root?.render(<Harness />));
    const firstVideo = target.querySelector('video')!;
    owners.set('blob:first', firstVideo);
    owners.set('poster:blob:first', firstVideo);
    await act(async () => target.querySelector('button')?.click());
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(events.indexOf('updater:blob:first')).toBeLessThan(events.indexOf('revoke:blob:first'));
    expect(events).toContain('revoke:poster:blob:first');
    // React already switched the reused node to the new URL, so releasing the
    // old one must not pause or reload the element (that would break playback).
    expect(events).not.toContain('pause');
    expect(events).not.toContain('load');
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:second');
    owners.set('blob:second', target.querySelector('video')!);
    owners.set('poster:blob:second', target.querySelector('video')!);

    events.length = 0;
    await act(async () => root?.unmount());
    root = undefined;
    expect(revoke).toHaveBeenCalledTimes(4);
    // On unmount the element still holds the URL: detach it before revoking.
    const finalRevokeIndex = events.indexOf('revoke:blob:second');
    expect(finalRevokeIndex).toBeGreaterThan(-1);
    expect(events.slice(0, finalRevokeIndex)).toContain('pause');
    expect(events.slice(0, finalRevokeIndex)).toContain('load');
    expect(events).toContain('revoke:blob:second');
    expect(events).toContain('revoke:poster:blob:second');
  });

  it('preserves the element source without revoking during a StrictMode replay on mount', async () => {
    const target = setupContainer();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    function StrictHarness() {
      const videoRef = useMediaObjectUrl<HTMLVideoElement>('blob:strict');
      return <video ref={videoRef} src="blob:strict" />;
    }
    await act(async () => {
      root?.render(
        <StrictMode>
          <StrictHarness />
        </StrictMode>,
      );
    });
    const video = target.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toBe('blob:strict');
    expect(revoke).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = undefined;
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:strict');
    expect(video.getAttribute('src')).toBeNull();
  });

  it('revokes each URL exactly once and detaches before revoke on replace then unmount', async () => {
    const target = setupContainer();
    const events: string[] = [];
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      const video = target.querySelector('video');
      if (video !== null) {
        expect(video.getAttribute('src')).not.toBe(url);
      }
      events.push(`revoke:${url}`);
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => events.push('pause'));
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => events.push('load'));

    function ReplaceHarness({ url }: { readonly url: string }) {
      const videoRef = useMediaObjectUrl<HTMLVideoElement>(url);
      return <video ref={videoRef} src={url} />;
    }

    await act(async () => root?.render(<ReplaceHarness url="blob:first" />));
    expect(revoke).not.toHaveBeenCalled();
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:first');

    await act(async () => root?.render(<ReplaceHarness url="blob:second" />));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['revoke:blob:first']);
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:second');

    events.length = 0;
    await act(async () => root?.unmount());
    root = undefined;
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['pause', 'load', 'revoke:blob:second']);
  });

  it('models real usage (A -> B -> A2): revokes each URL exactly once, never revokes while displayed, and keeps bookkeeping bounded', async () => {
    const target = setupContainer();
    const revoked: string[] = [];
    let currentDisplayedUrl = '';
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      expect(url).not.toBe(currentDisplayedUrl);
      revoked.push(url);
    });

    let lastRefCallback: ReturnType<typeof useMediaObjectUrl<HTMLVideoElement>> | undefined;

    function ReturnHarness({ url }: { readonly url: string }) {
      currentDisplayedUrl = url;
      const videoRef = useMediaObjectUrl<HTMLVideoElement>(url);
      lastRefCallback = videoRef;
      return <video ref={videoRef} src={url} />;
    }

    await act(async () => root?.render(<ReturnHarness url="blob:A" />));
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:A');
    expect(revoked).toEqual([]);
    expect(lastRefCallback?.testOnlyGetRetainedUrlCount?.()).toBe(1);

    await act(async () => root?.render(<ReturnHarness url="blob:B" />));
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:B');
    expect(revoked).toEqual(['blob:A']);
    expect(lastRefCallback?.testOnlyGetRetainedUrlCount?.()).toBe(1);

    await act(async () => root?.render(<ReturnHarness url="blob:A2" />));
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:A2');
    expect(revoked).toEqual(['blob:A', 'blob:B']);
    expect(lastRefCallback?.testOnlyGetRetainedUrlCount?.()).toBe(1);

    for (let i = 0; i < 1000; i++) {
      const nextUrl = `blob:swap-${i}`;
      await act(async () => root?.render(<ReturnHarness url={nextUrl} />));
      expect(lastRefCallback?.testOnlyGetRetainedUrlCount?.()).toBe(1);
    }
    expect(revoke).toHaveBeenCalledTimes(1002);
    expect(revoked).not.toContain('blob:swap-999');

    currentDisplayedUrl = '';
    await act(async () => root?.unmount());
    root = undefined;
    expect(revoked).toContain('blob:swap-999');
    expect(revoke).toHaveBeenCalledTimes(1003);
    expect(lastRefCallback?.testOnlyGetRetainedUrlCount?.()).toBe(0);
  });

  it('detaches video and audio elements before ProjectMediaResolver.clear revokes URLs across resolver replacement and unmount with retained refs', async () => {
    const target = setupContainer();
    const events: string[] = [];
    const makeResolver = (id: string) =>
      new ProjectMediaResolver({
        projectId: id,
        controlPlaneReady: false,
        client: {
          assets: vi.fn(async () => []),
          originalBytes: vi.fn(),
          sharedCloudOriginalBytes: vi.fn(),
        },
        originalCache: {
          get: vi.fn(async () => new Blob(['video-bytes'], { type: 'video/mp4' })),
        },
      });

    const resolverA = makeResolver('project-a');
    const resolverB = makeResolver('project-b');

    const retained = { video: null as HTMLVideoElement | null };
    let createCount = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      createCount += 1;
      return `blob:project-video-${createCount}`;
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      if (retained.video !== null && retained.video.getAttribute('src') === url) {
        expect.fail(`URL ${url} was revoked while still attached to video element!`);
      }
      events.push(`revoke:${url}`);
    });

    const resolvedA = await resolverA.resolve('asset-1');
    const resolvedB = await resolverB.resolve('asset-2');

    function AppMediaConsumerHarness({
      resolver,
      url,
    }: {
      readonly resolver: ProjectMediaResolver;
      readonly url: string;
    }) {
      const videoRef = useRef<HTMLVideoElement | null>(null);
      const lastVideoRef = useRef<HTMLVideoElement | null>(null);
      const playbackVideoRef = useCallback((element: HTMLVideoElement | null): void => {
        videoRef.current = element;
        if (element !== null) {
          lastVideoRef.current = element;
          retained.video = element;
        }
      }, []);

      useLayoutEffect(
        () => () =>
          resolver.clear(() => {
            resolver.detachConsumerIfOwned(videoRef.current ?? lastVideoRef.current);
          }),
        [resolver],
      );

      return <video ref={playbackVideoRef} src={url} />;
    }

    await act(async () =>
      root?.render(<AppMediaConsumerHarness resolver={resolverA} url={resolvedA.url} />),
    );
    const video = target.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('blob:project-video-1');
    expect(events).toEqual([]);

    await act(async () =>
      root?.render(<AppMediaConsumerHarness resolver={resolverB} url={resolvedB.url} />),
    );
    expect(events).toEqual(['revoke:blob:project-video-1']);
    expect(video.getAttribute('src')).toBe('blob:project-video-2');

    await act(async () => root?.unmount());
    root = undefined;

    expect(events).toEqual(['revoke:blob:project-video-1', 'revoke:blob:project-video-2']);
    expect(retained.video?.getAttribute('src')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('detaches active export consumer elements when resolver changes mid-export before revoking export URLs', async () => {
    setupContainer();
    const events: string[] = [];
    const makeResolver = (id: string) =>
      new ProjectMediaResolver({
        projectId: id,
        controlPlaneReady: false,
        client: {
          assets: vi.fn(async () => []),
          originalBytes: vi.fn(),
          sharedCloudOriginalBytes: vi.fn(),
        },
        originalCache: {
          get: vi.fn(async () => new Blob(['video-bytes'], { type: 'video/mp4' })),
        },
      });

    const resolverA = makeResolver('project-a');
    const resolverB = makeResolver('project-b');

    let createCount = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      createCount += 1;
      return `blob:export-${createCount}`;
    });

    const retainedExportVideo = { current: null as HTMLVideoElement | null };
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      if (
        retainedExportVideo.current !== null &&
        retainedExportVideo.current.getAttribute('src') === url
      ) {
        expect.fail(`Export URL ${url} was revoked while export element still holds it!`);
      }
      events.push(`revoke:${url}`);
    });

    const exportSource = await resolverA.resolve('export-clip-1');
    const activeConsumers = new Set<MediaObjectUrlConsumer>();

    function AppExportHarness({ resolver }: { readonly resolver: ProjectMediaResolver }) {
      useLayoutEffect(
        () => () =>
          resolver.clear(() => {
            for (const consumer of activeConsumers) {
              resolver.detachConsumerIfOwned(consumer);
            }
          }),
        [resolver],
      );
      return <div />;
    }

    await act(async () => root?.render(<AppExportHarness resolver={resolverA} />));

    const exportVideo = document.createElement('video');
    retainedExportVideo.current = exportVideo;
    activeConsumers.add(exportVideo);
    exportVideo.setAttribute('src', exportSource.url);
    expect(exportVideo.getAttribute('src')).toBe('blob:export-1');

    await act(async () => root?.render(<AppExportHarness resolver={resolverB} />));

    expect(events).toEqual(['revoke:blob:export-1']);
    expect(exportVideo.getAttribute('src')).toBeNull();

    activeConsumers.delete(exportVideo);
    expect(activeConsumers.size).toBe(0);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:export-1');
  });

  it('detaches transition partner video consumer element when resolver changes and on unmount before revoking URLs', async () => {
    setupContainer();
    const events: string[] = [];
    const makeResolver = (id: string) =>
      new ProjectMediaResolver({
        projectId: id,
        controlPlaneReady: false,
        client: {
          assets: vi.fn(async () => []),
          originalBytes: vi.fn(),
          sharedCloudOriginalBytes: vi.fn(),
        },
        originalCache: {
          get: vi.fn(async () => new Blob(['partner-bytes'], { type: 'video/mp4' })),
        },
      });

    const resolverA = makeResolver('project-a');
    const resolverB = makeResolver('project-b');

    let createCount = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      createCount += 1;
      return `blob:partner-${createCount}`;
    });

    const retainedPartnerVideo = { current: null as HTMLVideoElement | null };
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      if (
        retainedPartnerVideo.current !== null &&
        retainedPartnerVideo.current.getAttribute('src') === url
      ) {
        expect.fail(`Partner video URL ${url} was revoked while partner video still holds it!`);
      }
      events.push(`revoke:${url}`);
    });

    let triggerCaptureA!: () => Promise<void>;
    let triggerCaptureB!: () => Promise<void>;

    function AppTransitionPartnerHarness({
      resolver,
      onReady,
    }: {
      readonly resolver: ProjectMediaResolver;
      readonly onReady: (capture: () => Promise<void>) => void;
    }) {
      const partnerVideoRef = useRef<HTMLVideoElement | null>(null);
      const activeMediaConsumersRef = useRef(new Set<MediaObjectUrlConsumer>());

      useLayoutEffect(
        () => () =>
          resolver.clear(() => {
            resolver.detachConsumerIfOwned(partnerVideoRef.current);
            if (
              partnerVideoRef.current !== null &&
              !resolver.ownsConsumer(partnerVideoRef.current)
            ) {
              activeMediaConsumersRef.current.delete(partnerVideoRef.current);
            }
            for (const consumer of Array.from(activeMediaConsumersRef.current)) {
              if (resolver.detachConsumerIfOwned(consumer)) {
                activeMediaConsumersRef.current.delete(consumer);
              }
            }
          }),
        [resolver],
      );

      useEffect(
        () => () => {
          const partnerVideo = partnerVideoRef.current;
          if (partnerVideo !== null) {
            activeMediaConsumersRef.current.delete(partnerVideo);
          }
          partnerVideo?.pause();
          partnerVideo?.removeAttribute('src');
          partnerVideo?.load();
          partnerVideoRef.current = null;
        },
        [],
      );

      const ensurePartnerVideo = useCallback((): HTMLVideoElement => {
        if (partnerVideoRef.current === null) {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          partnerVideoRef.current = video;
          retainedPartnerVideo.current = video;
        }
        return partnerVideoRef.current;
      }, []);

      const captureTransitionPartnerFrames = useCallback(async (): Promise<void> => {
        const video = ensurePartnerVideo();
        const source = await resolver.resolve('partner-clip');
        const sourceUrl = new URL(source.url, window.location.href).href;
        activeMediaConsumersRef.current.add(video);
        if (video.src !== sourceUrl) {
          video.src = sourceUrl;
        }
      }, [ensurePartnerVideo, resolver]);

      useLayoutEffect(() => {
        onReady(captureTransitionPartnerFrames);
      }, [captureTransitionPartnerFrames, onReady]);

      return <div />;
    }

    await act(async () =>
      root?.render(
        <AppTransitionPartnerHarness
          resolver={resolverA}
          onReady={(capture) => {
            triggerCaptureA = capture;
          }}
        />,
      ),
    );

    await act(async () => {
      await triggerCaptureA();
    });

    const partnerVideo = retainedPartnerVideo.current!;
    expect(partnerVideo).not.toBeNull();
    expect(partnerVideo.getAttribute('src')).toBe('blob:partner-1');
    expect(events).toEqual([]);

    await act(async () =>
      root?.render(
        <AppTransitionPartnerHarness
          resolver={resolverB}
          onReady={(capture) => {
            triggerCaptureB = capture;
          }}
        />,
      ),
    );

    expect(events).toEqual(['revoke:blob:partner-1']);
    expect(partnerVideo.getAttribute('src')).toBeNull();

    await act(async () => {
      await triggerCaptureB();
    });

    expect(partnerVideo.getAttribute('src')).toBe('blob:partner-2');

    events.length = 0;
    await act(async () => root?.unmount());
    root = undefined;

    expect(events).toEqual(['revoke:blob:partner-2']);
    expect(partnerVideo.getAttribute('src')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('detaches preview media consumer before revoke even when conditionally hidden prior to release', async () => {
    const target = setupContainer();
    const events: string[] = [];
    const retained = { element: null as HTMLVideoElement | null };
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      if (retained.element !== null) {
        expect(retained.element.getAttribute('src')).toBeNull();
      }
      events.push(`revoke:${url}`);
    });

    function AssetPreviewHarness({
      showingStockVideos,
      previewUrl,
    }: {
      readonly showingStockVideos: boolean;
      readonly previewUrl?: string | undefined;
    }) {
      const previewMediaRef = useMediaObjectUrl<HTMLVideoElement>(previewUrl);
      return (
        <div>
          {!showingStockVideos && previewUrl !== undefined && (
            <video
              ref={(element) => {
                previewMediaRef(element);
                if (element !== null) retained.element = element;
              }}
              src={previewUrl}
            />
          )}
        </div>
      );
    }

    await act(async () =>
      root?.render(
        <AssetPreviewHarness showingStockVideos={false} previewUrl="blob:asset-preview" />,
      ),
    );
    expect(retained.element).not.toBeNull();
    expect(retained.element?.getAttribute('src')).toBe('blob:asset-preview');
    expect(revoke).not.toHaveBeenCalled();

    await act(async () =>
      root?.render(
        <AssetPreviewHarness showingStockVideos={true} previewUrl="blob:asset-preview" />,
      ),
    );
    expect(target.querySelector('video')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    expect(retained.element?.getAttribute('src')).toBe('blob:asset-preview');

    await act(async () =>
      root?.render(<AssetPreviewHarness showingStockVideos={true} previewUrl={undefined} />),
    );
    expect(retained.element?.getAttribute('src')).toBeNull();
    expect(events).toEqual(['revoke:blob:asset-preview']);
  });
});
