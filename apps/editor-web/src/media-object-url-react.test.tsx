// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReleasableObjectUrl as useMediaObjectUrl } from './media-object-url.js';

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
});
