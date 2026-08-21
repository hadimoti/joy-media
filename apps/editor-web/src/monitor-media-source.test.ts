import { describe, expect, it, vi } from 'vitest';
import type { VideoClip } from '@joy-media/project-schema';
import type { PlayableAssetRequest, PlayableAssetResolution } from './asset-resolver.js';
import {
  MonitorMediaElementBinding,
  createReferenceFixturePlayableResolverForTests,
  disposeInactiveMonitorPlayback,
  resolveReadyMonitorMediaSources,
  resolveMonitorMediaSource,
  type MonitorPlayableAsset,
} from './monitor-media-source.js';

const CLIP: VideoClip = {
  id: 'clip-1',
  kind: 'video',
  assetId: 'client-footage.2026',
  startUs: 0,
  durationUs: 5_000_000,
  sourceInUs: 0,
};

const ASSET: MonitorPlayableAsset = {
  id: 'client-footage.2026',
  projectId: 'project-1',
  kind: 'video',
  sha256: 'a'.repeat(64),
  bytes: 1234,
  descriptor: { mimeType: 'video/mp4' },
  displayName: 'Client footage',
};

describe('monitor media source resolution', () => {
  it('resolves an arbitrary imported asset id to the OPFS blob URL returned by the playable resolver', async () => {
    let requested: PlayableAssetRequest | undefined;
    const resolver = resolverReturning(async (request) => {
      requested = request;
      return {
        state: 'ready',
        source: 'opfs-original',
        url: 'blob:opfs-client-footage',
        mimeType: 'video/mp4',
        release: () => undefined,
      };
    });

    const source = await resolveMonitorMediaSource({
      projectId: 'project-1',
      clip: CLIP,
      asset: ASSET,
      resolver,
    });

    expect(source).toMatchObject({
      state: 'ready',
      clipId: 'clip-1',
      assetId: 'client-footage.2026',
      url: 'blob:opfs-client-footage',
      mimeType: 'video/mp4',
    });
    expect(requested).toEqual({
      projectId: 'project-1',
      asset: {
        assetId: 'client-footage.2026',
        kind: 'video',
        sha256: 'a'.repeat(64),
        byteLength: 1234,
        mimeType: 'video/mp4',
      },
    });
  });

  it('rejects reference fixtures unless a test fixture adapter explicitly opts in', async () => {
    expect(() =>
      createReferenceFixturePlayableResolverForTests({
        fixtures: {
          'asset-intro': { url: '/media/reference/asset-intro.mp4', mimeType: 'video/mp4' },
        },
      }),
    ).toThrow(/explicit test fixture adapter/i);

    const resolver = createReferenceFixturePlayableResolverForTests({
      allowFixtures: true,
      fixtures: {
        'asset-intro': { url: '/media/reference/asset-intro.mp4', mimeType: 'video/mp4' },
      },
    });

    await expect(
      resolver.resolve({
        projectId: 'project-1',
        asset: {
          assetId: 'asset-intro',
          kind: 'video',
          sha256: 'b'.repeat(64),
          byteLength: 100,
          mimeType: 'video/mp4',
        },
      }),
    ).resolves.toMatchObject({
      state: 'ready',
      source: 'fixture',
      url: '/media/reference/asset-intro.mp4',
    });
  });

  it.each([
    ['pending', 'wait'],
    ['unavailable', 'reconnect'],
    ['revoked', 'sign-in'],
  ] as const)('returns an actionable %s state instead of a blank monitor', async (state, action) => {
    const source = await resolveMonitorMediaSource({
      projectId: 'project-1',
      clip: CLIP,
      asset: ASSET,
      resolver: resolverReturning(async () => ({ state })),
    });

    expect(source.state).toBe(state);
    expect(source).toMatchObject({
      clipId: 'clip-1',
      assetId: 'client-footage.2026',
      action: { kind: action },
    });
    expect(source.message).toMatch(/\S/);
  });

  it('releases stale handles and detaches stale element sources before applying the next source', () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const video = fakeVideoElement();
    const binding = new MonitorMediaElementBinding();

    binding.apply(video, readySource('clip-1', 'blob:first', firstRelease));
    binding.apply(video, readySource('clip-2', 'blob:second', secondRelease));

    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(video.pauseCalls).toBe(1);
    expect(video.removedAttributes).toEqual(['src']);
    expect(video.loadCalls).toBe(1);
    expect(video.src).toBe('blob:second');

    binding.dispose(video);

    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(video.pauseCalls).toBe(2);
    expect(video.loadCalls).toBe(2);
    expect(video.removedAttributes).toEqual(['src', 'src']);
  });

  it('releases all ready handles when one export media source cannot be prepared', async () => {
    const firstRelease = vi.fn();
    const thirdRelease = vi.fn();

    await expect(
      resolveReadyMonitorMediaSources([CLIP, clip('clip-2'), clip('clip-3')], async (item) => {
        if (item.id === 'clip-1') return readySource(item.id, 'blob:first', firstRelease);
        if (item.id === 'clip-2') throw new Error('source preparation failed');
        return readySource(item.id, 'blob:third', thirdRelease);
      }),
    ).rejects.toThrow('source preparation failed');

    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(thirdRelease).toHaveBeenCalledTimes(1);
  });

  it('detaches idle live preview media and clears stale active-frame state', () => {
    const release = vi.fn();
    const video = fakeVideoElement();
    const binding = new MonitorMediaElementBinding();
    let activeClipId: string | undefined = 'clip-1';
    let previewCleared = false;
    binding.apply(video, readySource('clip-1', 'blob:first', release));

    disposeInactiveMonitorPlayback({
      video,
      binding,
      clearActiveClipId: () => {
        activeClipId = undefined;
      },
      clearPreviewFrame: () => {
        previewCleared = true;
      },
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(video.src).toBe('');
    expect(video.pauseCalls).toBe(1);
    expect(video.loadCalls).toBe(1);
    expect(activeClipId).toBeUndefined();
    expect(previewCleared).toBe(true);
  });
});

function resolverReturning(
  resolve: (request: PlayableAssetRequest) => Promise<PlayableAssetResolution>,
) {
  return { resolve };
}

function readySource(clipId: string, url: string, release: () => void) {
  return {
    state: 'ready' as const,
    clipId,
    assetId: `asset-${clipId}`,
    url,
    mimeType: 'video/mp4',
    release,
  };
}

function clip(id: string): VideoClip {
  return { ...CLIP, id, assetId: `asset-${id}` };
}

function fakeVideoElement(): HTMLVideoElement & {
  pauseCalls: number;
  loadCalls: number;
  removedAttributes: string[];
} {
  return {
    src: '',
    pauseCalls: 0,
    loadCalls: 0,
    removedAttributes: [],
    pause() {
      this.pauseCalls++;
    },
    load() {
      this.loadCalls++;
    },
    removeAttribute(name: string) {
      this.removedAttributes.push(name);
      if (name === 'src') this.src = '';
    },
  } as HTMLVideoElement & {
    pauseCalls: number;
    loadCalls: number;
    removedAttributes: string[];
  };
}
