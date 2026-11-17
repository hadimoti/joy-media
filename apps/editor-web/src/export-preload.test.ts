import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExportMissingMediaError,
  formatMissingExportMediaMessage,
  loadDetachedVideo,
  preflightExportClipSources,
  runExportPreloadStage,
} from './export-preload.js';
import { MediaUnavailableError } from './media-unavailable-error.js';

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
  it('preflights clip sources in timeline order and reports the first offending clip with recovery', async () => {
    const resolve = vi.fn(async (assetId: string) => {
      if (assetId === 'asset-intro')
        throw new Error('Media Intro is unavailable in local cache and owner storage');
      if (assetId === 'asset-product')
        throw new Error('Media Product is unavailable in local cache and owner storage');
      return { url: `blob:${assetId}` };
    });

    await expect(
      preflightExportClipSources(
        [
          {
            clipId: 'showcase-intro',
            clipLabel: 'Showcase Intro',
            visualAssetId: 'asset-intro',
            visualAssetLabel: 'Intro',
            audioAssetId: 'asset-intro',
            audioAssetLabel: 'Intro',
          },
          {
            clipId: 'showcase-product',
            clipLabel: 'Showcase Product',
            visualAssetId: 'asset-product',
            visualAssetLabel: 'Product',
            audioAssetId: 'asset-product',
            audioAssetLabel: 'Product',
          },
        ],
        resolve,
      ),
    ).rejects.toThrow(
      'Clip "Showcase Intro" (showcase-intro) cannot resolve visual asset "Intro" (asset-intro). Restore the original media in Project Assets, reconnect owner storage if needed, or replace the clip before exporting. Media Intro is unavailable in local cache and owner storage',
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('asset-intro');
  });

  it('reuses one resolved source when a clip audio source matches its visual asset', async () => {
    const resolve = vi.fn(async (assetId: string) => ({ url: `blob:${assetId}` }));

    const prepared = await preflightExportClipSources(
      [
        {
          clipId: 'clip-1',
          visualAssetId: 'asset-1',
          audioAssetId: 'asset-1',
        },
      ],
      resolve,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(prepared.get('clip-1')).toEqual({
      visualSource: { url: 'blob:asset-1' },
      audioSource: { url: 'blob:asset-1' },
    });
  });

  it('names an alternate clip audio asset when audio preflight fails', async () => {
    const resolve = vi.fn(async (assetId: string) => {
      if (assetId === 'voiceover-1') throw new Error('Authenticated media session is not ready');
      return { url: `blob:${assetId}` };
    });

    await expect(
      preflightExportClipSources(
        [
          {
            clipId: 'clip-voiceover',
            clipLabel: 'Voiceover Clip',
            visualAssetId: 'video-1',
            visualAssetLabel: 'Main take',
            audioAssetId: 'voiceover-1',
            audioAssetLabel: 'Voiceover stem',
          },
        ],
        resolve,
      ),
    ).rejects.toThrow(
      'Clip "Voiceover Clip" (clip-voiceover) cannot resolve audio asset "Voiceover stem" (voiceover-1). Restore the original media in Project Assets, reconnect owner storage if needed, or replace the clip audio before exporting. Authenticated media session is not ready',
    );
  });

  it('names every clip whose media is missing in plain words, without the internal asset text', async () => {
    const resolve = vi.fn(async (assetId: string) => {
      if (assetId === 'asset-b-roll-a' || assetId === 'asset-b-roll-b')
        throw new MediaUnavailableError(`Media ${assetId} is unavailable in the local cache`);
      return { url: `blob:${assetId}` };
    });

    const failure = await preflightExportClipSources(
      [
        { clipId: 'intro', visualAssetId: 'asset-intro', audioAssetId: 'asset-intro' },
        { clipId: 'b-roll-a', visualAssetId: 'asset-b-roll-a', audioAssetId: 'asset-b-roll-a' },
        { clipId: 'b-roll-b', visualAssetId: 'asset-b-roll-b', audioAssetId: 'asset-b-roll-b' },
      ],
      resolve,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ExportMissingMediaError);
    expect((failure as ExportMissingMediaError).message).toBe(
      'Missing media in this export: b-roll-a, b-roll-b. Relink or replace the clips.',
    );
    expect((failure as ExportMissingMediaError).clipNames).toEqual(['b-roll-a', 'b-roll-b']);
    expect((failure as Error).message).not.toMatch(/cannot resolve|asset-/u);
  });

  it('still refuses a missing clip when the resolver error reaches the preflight through a preload stage', async () => {
    const resolve = vi.fn((assetId: string) =>
      runExportPreloadStage(
        'resolving source',
        () => Promise.reject(new MediaUnavailableError(`Media ${assetId} is unavailable`)),
        new AbortController().signal,
      ),
    );

    await expect(
      preflightExportClipSources(
        [
          {
            clipId: 'clip-missing',
            clipLabel: 'Missing Clip',
            visualAssetId: 'asset-missing',
            audioAssetId: 'asset-missing',
          },
        ],
        resolve,
      ),
    ).rejects.toThrow('Missing media in this export: Missing Clip. Relink or replace the clip.');
  });

  it('keeps the detailed message for a resolve failure that is not a missing file', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('Authenticated media session is not ready');
    });

    await expect(
      preflightExportClipSources(
        [{ clipId: 'clip-1', visualAssetId: 'asset-1', audioAssetId: 'asset-1' }],
        resolve,
      ),
    ).rejects.toThrow(
      'Clip clip-1 cannot resolve visual asset "asset-1" (asset-1). Restore the original media in Project Assets, reconnect owner storage if needed, or replace the clip before exporting. Authenticated media session is not ready',
    );
  });

  it('formats the missing-media refusal for one clip and for several', () => {
    expect(formatMissingExportMediaMessage(['b-roll-a'])).toBe(
      'Missing media in this export: b-roll-a. Relink or replace the clip.',
    );
    expect(formatMissingExportMediaMessage(['b-roll-a', 'b-roll-b'])).toBe(
      'Missing media in this export: b-roll-a, b-roll-b. Relink or replace the clips.',
    );
  });

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
