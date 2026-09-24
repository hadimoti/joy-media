// @vitest-environment jsdom
import { act, StrictMode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMediaSource,
  useReleasableObjectUrl as useMediaObjectUrl,
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

  it('handles a same-value return (A -> B -> A) without revoking while displayed and revoking each URL at most once overall', async () => {
    const target = setupContainer();
    const revoked: string[] = [];
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url);
    });

    function ReturnHarness({ url }: { readonly url: string }) {
      const videoRef = useMediaObjectUrl<HTMLVideoElement>(url);
      return <video ref={videoRef} src={url} />;
    }

    await act(async () => root?.render(<ReturnHarness url="blob:A" />));
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:A');
    expect(revoked).toEqual([]);

    await act(async () => root?.render(<ReturnHarness url="blob:B" />));
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:B');
    expect(revoked).toEqual(['blob:A']);

    await act(async () => root?.render(<ReturnHarness url="blob:A" />));
    expect(target.querySelector('video')?.getAttribute('src')).toBe('blob:A');
    expect(revoked).toEqual(['blob:A', 'blob:B']);

    await act(async () => root?.unmount());
    root = undefined;
    expect(revoked).toEqual(['blob:A', 'blob:B']);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('detaches video and audio elements before ProjectMediaResolver.clear revokes URLs during unmount with retained refs', async () => {
    const target = setupContainer();
    const events: string[] = [];
    const resolver = new ProjectMediaResolver({
      projectId: 'project-test',
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

    const retained = { video: null as HTMLVideoElement | null };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project-video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      if (retained.video !== null) {
        expect(retained.video.getAttribute('src')).toBeNull();
      }
      events.push(`revoke:${url}`);
    });

    const resolved = await resolver.resolve('asset-1');

    function AppMediaConsumerHarness() {
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
            clearMediaSource(videoRef.current ?? lastVideoRef.current);
            lastVideoRef.current = null;
          }),
        [],
      );

      return <video ref={playbackVideoRef} src={resolved.url} />;
    }

    await act(async () => root?.render(<AppMediaConsumerHarness />));
    const video = target.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('blob:project-video');

    await act(async () => root?.unmount());
    root = undefined;

    expect(events).toEqual(['revoke:blob:project-video']);
    expect(retained.video?.getAttribute('src')).toBeNull();
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
