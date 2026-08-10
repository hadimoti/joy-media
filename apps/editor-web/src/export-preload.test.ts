import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDetachedVideo, runExportPreloadStage } from './export-preload.js';

class FakeVideo extends EventTarget {
  preload = '';
  playsInline = false;
  muted = false;
  src = '';
  readyState = 0;
  currentTime = 0;
  load = vi.fn();
  readonly added: string[] = [];
  readonly removed: string[] = [];

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.added.push(type);
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.removed.push(type);
    super.removeEventListener(type, listener);
  }
}

afterEach(() => vi.useRealTimers());

describe('export preload stages', () => {
  it('accepts video that became ready before listener registration and removes listeners', async () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    video.readyState = 2;

    await loadDetachedVideo(
      video as unknown as HTMLVideoElement,
      'blob:ready',
      new AbortController().signal,
    );

    expect(video.load).not.toHaveBeenCalled();
    expect(video.removed).toEqual(expect.arrayContaining(['loadeddata', 'error']));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an actionable stage timeout and clears its timer', async () => {
    vi.useFakeTimers();
    const promise = runExportPreloadStage(
      'decoding authored audio',
      () => new Promise(() => undefined),
      new AbortController().signal,
      20,
    );
    const rejection = expect(promise).rejects.toThrow(
      'Export preload timed out while decoding authored audio after 0.02 seconds',
    );
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a detached load and removes media listeners and timer', async () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    const controller = new AbortController();
    const promise = loadDetachedVideo(
      video as unknown as HTMLVideoElement,
      'blob:waiting',
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(video.removed).toEqual(expect.arrayContaining(['loadeddata', 'error']));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes detached media listeners when its stage times out', async () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    const promise = loadDetachedVideo(
      video as unknown as HTMLVideoElement,
      'blob:timeout',
      new AbortController().signal,
    );
    const rejection = expect(promise).rejects.toThrow(
      'Export preload timed out while loading detached video after 15 seconds',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(video.removed).toEqual(expect.arrayContaining(['loadeddata', 'error']));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears listeners and timer after a normal media event', async () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    const promise = loadDetachedVideo(
      video as unknown as HTMLVideoElement,
      'blob:loaded',
      new AbortController().signal,
    );
    video.dispatchEvent(new Event('loadeddata'));

    await promise;
    expect(video.removed).toEqual(expect.arrayContaining(['loadeddata', 'error']));
    expect(vi.getTimerCount()).toBe(0);
  });
});
