import { describe, expect, it, vi } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  loadCompositionAudioForLook,
  selectCompositionAudioClip,
} from './living-look-audio-source.js';

function projectWithAudioClip(overrides: Partial<JoyProjectV1> = {}): JoyProjectV1 {
  return {
    ...INITIAL_EDITOR_PROJECT,
    assets: {
      ...INITIAL_EDITOR_PROJECT.assets,
      'audio-1': { id: 'audio-1', kind: 'audio', displayName: 'track.mp3' } as never,
    },
    universalTimeline: {
      schemaVersion: 1,
      items: [
        {
          id: 'music-clip',
          compositionId: INITIAL_EDITOR_PROJECT.rootCompositionId,
          trackId: 'audio-track',
          elementKind: 'audio',
          startUs: 500_000,
          durationUs: 8_000_000,
          source: { kind: 'asset', id: 'audio-1' },
          sourceInUs: 120_000,
          withinTrackOrder: 0,
        },
      ],
    },
    ...overrides,
  } as JoyProjectV1;
}

describe('selectCompositionAudioClip', () => {
  it('picks the earliest audio-asset item in the root composition', () => {
    expect(selectCompositionAudioClip(projectWithAudioClip())).toEqual({
      clipId: 'music-clip',
      assetId: 'audio-1',
      startUs: 500_000,
      durationUs: 8_000_000,
      sourceInUs: 120_000,
    });
  });

  it('returns undefined when the composition has no audio', () => {
    expect(selectCompositionAudioClip(INITIAL_EDITOR_PROJECT)).toBeUndefined();
  });
});

describe('loadCompositionAudioForLook', () => {
  const fakeDecoded = {
    sampleRate: 48_000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(48_000),
  };

  it('resolves, fetches and decodes the audio, mapping the clip placement', async () => {
    const resolveAssetUrl = vi.fn(async () => 'blob:audio-1');
    const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
    const close = vi.fn();
    const result = await loadCompositionAudioForLook({
      visual: projectWithAudioClip(),
      resolveAssetUrl,
      fetchBytes,
      createAudioContext: () => ({ decodeAudioData: async () => fakeDecoded, close }),
    });
    expect(resolveAssetUrl).toHaveBeenCalledWith('audio-1');
    expect(fetchBytes).toHaveBeenCalledWith('blob:audio-1');
    expect(close).toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'ready',
      audio: { sampleRate: 48_000, sourceOffsetUs: 120_000 },
      clip: {
        compositionStartUs: 500_000,
        compositionDurationUs: 8_000_000,
        sourceAnchorUs: 120_000,
        sourcePerComposition: { numerator: 1, denominator: 1 },
      },
    });
  });

  it('reports no-audio without touching the resolver', async () => {
    const resolveAssetUrl = vi.fn(async () => 'x');
    const result = await loadCompositionAudioForLook({
      visual: INITIAL_EDITOR_PROJECT,
      resolveAssetUrl,
      fetchBytes: async () => new ArrayBuffer(0),
      createAudioContext: () => ({ decodeAudioData: async () => fakeDecoded }),
    });
    expect(result).toEqual({ kind: 'no-audio' });
    expect(resolveAssetUrl).not.toHaveBeenCalled();
  });

  it('returns a redacted error when decode fails', async () => {
    const result = await loadCompositionAudioForLook({
      visual: projectWithAudioClip(),
      resolveAssetUrl: async () => 'blob:x',
      fetchBytes: async () => new ArrayBuffer(8),
      createAudioContext: () => ({
        decodeAudioData: async () => {
          throw new Error('bad audio bytes');
        },
      }),
    });
    expect(result).toEqual({ kind: 'error', message: 'bad audio bytes' });
  });

  it('rejects more than two channels', async () => {
    const result = await loadCompositionAudioForLook({
      visual: projectWithAudioClip(),
      resolveAssetUrl: async () => 'blob:x',
      fetchBytes: async () => new ArrayBuffer(8),
      createAudioContext: () => ({
        decodeAudioData: async () => ({
          sampleRate: 48_000,
          numberOfChannels: 6,
          getChannelData: () => new Float32Array(1),
        }),
      }),
    });
    expect(result).toEqual({
      kind: 'error',
      message: 'Audio must be mono or stereo to bake motion from it.',
    });
  });
});
