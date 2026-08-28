import { describe, expect, it, vi } from 'vitest';
import { ProviderUnavailableError } from '@joy-media/provider-sdk';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import type { SpikeProject } from '@joy-media/project-schema';
import type { BrowserControlPlaneClient } from './control-plane-client.js';
import {
  MAX_TRANSCRIPTION_MEDIA_BYTES,
  prepareCaptionTranscriptionSource,
  selectedOrCurrentTranscriptionCandidate,
  type CaptionTranscriptionSource,
} from './local-transcription.js';
import { transcribeReferenceCaption } from './caption-transcription-runner.js';

function source(overrides: Partial<CaptionTranscriptionSource> = {}): CaptionTranscriptionSource {
  return {
    assetId: 'asset-intro',
    candidateKey: 'intro',
    transport: 'reference',
    sourceStartUs: 1_000_000,
    sourceDurationUs: 2_000_000,
    playbackRate: 1,
    timelineStartUs: 4_000_000,
    timelineDurationUs: 2_000_000,
    ...overrides,
  };
}

function successfulClient(words: readonly { text: string; startUs: number; endUs: number }[]) {
  const calls: unknown[] = [];
  const client = {
    async transcribeSpeech(...args: unknown[]) {
      calls.push(args);
      return {
        language: 'en-US',
        words,
        speakers: [],
        provenance: {
          providerId: 'joy.faster-whisper',
          modelId: 'faster-whisper-tiny',
          createdAt: '2026-07-23T12:00:00.000Z',
        },
      };
    },
  } as unknown as BrowserControlPlaneClient;
  return { client, calls };
}

describe('transcribeReferenceCaption (live, fail-closed)', () => {
  it('uses only an explicitly known reference source', async () => {
    const { client, calls } = successfulClient([
      { text: 'live', startUs: 1_100_000, endUs: 1_600_000 },
    ]);
    const document = await transcribeReferenceCaption('caption-en', 'en-US', source(), client);
    expect(document.provenance?.modelId).toBe('faster-whisper-tiny');
    expect(Object.values(document.words)[0]).toMatchObject({ startUs: 100_000, endUs: 600_000 });
    expect(calls).toEqual([['en-US', { referenceAssetId: 'asset-intro' }]]);
  });

  it.each([
    {
      name: '2x',
      playbackRate: 2,
      durationUs: 2_000_000,
      words: [
        { text: 'left', startUs: 500_000, endUs: 1_500_000 },
        { text: 'right', startUs: 2_500_000, endUs: 3_500_000 },
      ],
      expected: [
        { startUs: 0, endUs: 250_000 },
        { startUs: 750_000, endUs: 1_000_000 },
      ],
    },
    {
      name: '0.5x',
      playbackRate: 0.5,
      durationUs: 1_000_000,
      words: [{ text: 'slow', startUs: 1_250_000, endUs: 1_500_000 }],
      expected: [{ startUs: 500_000, endUs: 1_000_000 }],
    },
  ])('maps and clips provider source times onto $name caption time', async (fixture) => {
    const { client } = successfulClient(fixture.words);
    const document = await transcribeReferenceCaption(
      'caption-en',
      'en-US',
      source({ playbackRate: fixture.playbackRate, sourceDurationUs: fixture.durationUs }),
      client,
    );
    expect(Object.values(document.words)).toMatchObject(fixture.expected);
  });

  it('fails closed when the authenticated provider is unavailable', async () => {
    const client = {
      async transcribeSpeech() {
        throw new Error('AUTH_REQUIRED');
      },
    } as unknown as BrowserControlPlaneClient;
    await expect(
      transcribeReferenceCaption('caption-fa', 'fa-IR', source(), client),
    ).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      message: expect.stringContaining('Live transcription is unavailable'),
    });
  });

  it('uses verified local media bytes and never turns their asset ID into a reference', async () => {
    const media = new Blob(['media'], { type: 'video/mp4' });
    const { client, calls } = successfulClient([]);
    await transcribeReferenceCaption(
      'caption-en',
      'en-US',
      source({
        assetId: 'asset-imported',
        transport: 'local-media',
        media,
        mediaType: 'video/mp4',
      }),
      client,
    );
    expect(calls[0]).toMatchObject(['en-US', { media, mediaType: 'video/mp4' }]);
    expect(calls[0]).not.toHaveProperty('1.referenceAssetId');
  });

  it('keeps ProviderUnavailableError typed for callers', () => {
    expect(ProviderUnavailableError.name).toBe('ProviderUnavailableError');
  });
});

describe('transcription source selection and availability', () => {
  it('prefers selected valid media and otherwise uses the top valid enabled clip', () => {
    const project = buildReferenceSpikeProject();
    expect(
      selectedOrCurrentTranscriptionCandidate(project, ['product'], 1_000_000, {}),
    ).toMatchObject({
      state: 'candidate',
      source: { assetId: 'asset-product', timelineStartUs: 10_000_000 },
    });
    expect(selectedOrCurrentTranscriptionCandidate(project, [], 1_000_000, {})).toMatchObject({
      state: 'candidate',
      source: { assetId: 'asset-intro', timelineStartUs: 0 },
    });
  });

  it('filters stills, freeze frames, scene pseudo-assets, and disabled tracks before choosing', () => {
    const base = buildReferenceSpikeProject();
    const root = base.compositions.root!;
    const tracks = root.tracks.map((track, trackIndex) => ({
      ...track,
      enabled: trackIndex === 0,
      clips: track.clips.map((clip, clipIndex) =>
        clip.kind !== 'video'
          ? clip
          : trackIndex === 0 && clipIndex === 0
            ? { ...clip, assetId: 'still-1' }
            : trackIndex === 0 && clipIndex === 1
              ? { ...clip, playbackRate: 0 }
              : clip,
      ),
    }));
    const project: SpikeProject = {
      ...base,
      compositions: { ...base.compositions, root: { ...root, tracks } },
    };
    const assets = {
      'still-1': { kind: 'image' as const, bytes: 10, descriptor: { mimeType: 'image/png' } },
    };
    expect(
      selectedOrCurrentTranscriptionCandidate(
        project,
        ['intro', 'product', 'outro'],
        1_000_000,
        assets,
      ),
    ).toMatchObject({ state: 'candidate', source: { assetId: 'asset-outro' } });
    expect(
      selectedOrCurrentTranscriptionCandidate(project, ['intro'], 1_000_000, assets),
    ).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('audio or video') });
    expect(
      selectedOrCurrentTranscriptionCandidate(
        {
          ...base,
          compositions: {
            ...base.compositions,
            root: {
              ...root,
              tracks: root.tracks.map((track) => ({ ...track, enabled: false })),
            },
          },
        },
        [],
        1_000_000,
        {},
      ),
    ).toMatchObject({ state: 'unavailable' });
    for (const assetId of ['motion-scene:scene', 'html-scene:scene']) {
      const pseudo: SpikeProject = {
        ...base,
        compositions: {
          ...base.compositions,
          root: {
            ...root,
            tracks: root.tracks.map((track, index) =>
              index === 0
                ? {
                    ...track,
                    clips: track.clips.map((clip) =>
                      clip.kind === 'video' ? { ...clip, assetId } : clip,
                    ),
                  }
                : { ...track, enabled: false },
            ),
          },
        },
      };
      expect(selectedOrCurrentTranscriptionCandidate(pseudo, [], 1_000_000, {})).toMatchObject({
        state: 'unavailable',
      });
    }
  });

  it('skips an invalid overlapping top clip and chooses the valid lower source deterministically', () => {
    const base = buildReferenceSpikeProject();
    const root = base.compositions.root!;
    const top = root.tracks[1]!;
    const project: SpikeProject = {
      ...base,
      compositions: {
        ...base.compositions,
        root: {
          ...root,
          tracks: root.tracks.map((track) =>
            track.id === top.id
              ? {
                  ...track,
                  clips: track.clips.map((clip) =>
                    clip.kind === 'video' ? { ...clip, assetId: 'still-top' } : clip,
                  ),
                }
              : track,
          ),
        },
      },
    };
    expect(
      selectedOrCurrentTranscriptionCandidate(project, [], 1_000_000, {
        'still-top': { kind: 'image', bytes: 10, descriptor: { mimeType: 'image/png' } },
      }),
    ).toMatchObject({ state: 'candidate', source: { assetId: 'asset-intro' } });
  });

  it('fails before network for arbitrary missing media and enforces the exact 64 MiB boundary', async () => {
    const project = buildReferenceSpikeProject();
    const root = project.compositions.root!;
    const imported: SpikeProject = {
      ...project,
      compositions: {
        ...project.compositions,
        root: {
          ...root,
          tracks: root.tracks.map((track, index) =>
            index === 0
              ? {
                  ...track,
                  clips: track.clips.map((clip) =>
                    clip.kind === 'video' ? { ...clip, assetId: 'user-video' } : clip,
                  ),
                }
              : { ...track, enabled: false },
          ),
        },
      },
    };
    const metadata = {
      'user-video': {
        kind: 'video' as const,
        bytes: MAX_TRANSCRIPTION_MEDIA_BYTES,
        descriptor: { mimeType: 'video/mp4' },
      },
    };
    const candidate = selectedOrCurrentTranscriptionCandidate(imported, [], 1_000_000, metadata);
    expect(await prepareCaptionTranscriptionSource(candidate, async () => undefined)).toMatchObject(
      {
        state: 'unavailable',
        reason: expect.stringContaining('missing'),
      },
    );
    const atLimit = { size: MAX_TRANSCRIPTION_MEDIA_BYTES, type: 'video/mp4' } as Blob;
    expect(await prepareCaptionTranscriptionSource(candidate, async () => atLimit)).toMatchObject({
      state: 'ready',
    });
    const overLimit = { size: MAX_TRANSCRIPTION_MEDIA_BYTES + 1, type: 'video/mp4' } as Blob;
    expect(await prepareCaptionTranscriptionSource(candidate, async () => overLimit)).toMatchObject(
      {
        state: 'unavailable',
        reason: expect.stringContaining('64 MiB'),
      },
    );

    const referenceLoader = vi.fn(async () => undefined);
    const known = selectedOrCurrentTranscriptionCandidate(project, ['intro'], 0, {});
    expect(await prepareCaptionTranscriptionSource(known, referenceLoader)).toMatchObject({
      state: 'ready',
      source: { transport: 'reference' },
    });
    expect(referenceLoader).not.toHaveBeenCalled();
  });
});
