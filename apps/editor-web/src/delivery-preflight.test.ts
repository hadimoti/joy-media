import { describe, expect, it } from 'vitest';
import {
  deliveryMediaStateFromEvidence,
  deliveryPreflight,
  deliveryTimelineClipsFromProject,
  type DeliveryTimelineClip,
} from './delivery-preflight.js';
import {
  captionBurnInDigestV2,
  type CompositionPlanV2,
} from '../../../packages/render-planner/src/v2.js';

const CLIP: DeliveryTimelineClip = { id: 'clip-1', assetId: 'asset-1', durationUs: 1_000_000 };

function run(overrides: Partial<Parameters<typeof deliveryPreflight>[0]> = {}) {
  return deliveryPreflight({
    channel: 'quick-browser-export',
    clips: [CLIP],
    mediaStates: new Map([[CLIP.id, 'ready']]),
    capabilities: ['browser-mp4'],
    ...overrides,
  });
}

describe('deliveryPreflight', () => {
  function plannerPlan(overrides: Partial<CompositionPlanV2> = {}): CompositionPlanV2 {
    return {
      version: 2,
      composition: { id: 'root', width: 64, height: 64 },
      viewport: { width: 64, height: 64 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#000',
      layers: [{ id: 'image', kind: 'image', assetId: 'image' } as never],
      audio: [],
      outputPreset: 'preview',
      planSha256: '0'.repeat(64),
      ...overrides,
    };
  }

  it('allows static image/text layers only when the V2 planner accepts them', () => {
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {
          visualObjectCount: 1,
          verifiedRenderPlan: plannerPlan(),
        },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {
          visualObjectCount: 1,
          verifiedRenderPlan: plannerPlan({
            layers: [{ id: 'image', kind: 'image', assetId: 'image', effects: ['blur'] } as never],
          }),
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'Static image effect on image is malformed or animated.',
    });
  });

  it('requires a planner-normalized signed caption payload', () => {
    const base = {
      intent: 'burn-in' as const,
      styleRef: 'joy-clean' as const,
      segments: [{ id: 'cue', startUs: 0, endUs: 500_000, text: 'JOY', direction: 'ltr' as const }],
    };
    const signed = { ...base, payloadSha256: captionBurnInDigestV2(base) };
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {
          captionBurnIn: true,
          captionBurnInPayload: signed,
          verifiedRenderPlan: plannerPlan({ captionBurnIn: signed }),
        },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {
          captionBurnIn: true,
          captionBurnInPayload: { ...signed, payloadSha256: 'f'.repeat(64) },
          verifiedRenderPlan: plannerPlan({
            captionBurnIn: { ...signed, payloadSha256: 'f'.repeat(64) },
          }),
        },
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('caption') });
  });
  it('does not treat metadata-only ready evidence as playable media', () => {
    expect(deliveryMediaStateFromEvidence({ state: 'ready' })).toBe('unavailable');
    expect(
      deliveryPreflight({
        channel: 'quick-browser-export',
        clips: [CLIP],
        mediaStates: new Map([[CLIP.id, deliveryMediaStateFromEvidence({ state: 'ready' })]]),
        capabilities: ['browser-mp4'],
      }),
    ).toMatchObject({ allowed: false, code: 'media-not-ready' });
  });

  it('blocks an empty timeline with an actionable reason', () => {
    expect(run({ clips: [] })).toMatchObject({
      allowed: false,
      code: 'no-renderable-media',
      reason: expect.stringContaining('Add a video clip'),
    });
  });

  it('blocks verified delivery for an audio-only V2 timeline', () => {
    const audioClip: DeliveryTimelineClip = {
      id: 'audio-only',
      assetId: 'audio-asset',
      durationUs: 1_000_000,
      kind: 'audio',
    };
    expect(
      run({
        channel: 'verified-delivery',
        clips: [audioClip],
        mediaStates: new Map([[audioClip.id, 'ready']]),
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {
          verifiedRenderPlan: plannerPlan({
            layers: [],
            audio: [
              {
                id: 'audio-only',
                sourceKind: 'audio-asset',
                assetId: 'audio',
                startUs: 0,
                durationUs: 1_000_000,
                sourceInUs: 0,
                gain: 1,
                pan: 0,
                mute: false,
              },
            ],
          }),
        },
      }),
    ).toMatchObject({
      allowed: false,
      code: 'unsupported-render-envelope',
      reason: expect.stringContaining('at least one video'),
    });
  });

  it('keeps catalog-only video blocked without resolver evidence', () => {
    expect(run({ mediaStates: new Map() })).toMatchObject({
      allowed: false,
      code: 'media-not-ready',
      reason: expect.stringContaining('missing'),
    });
    expect(run({ mediaStates: new Map([[CLIP.id, 'pending']]) })).toMatchObject({
      allowed: false,
      code: 'media-not-ready',
      reason: expect.stringContaining('preparing'),
    });
  });

  it('blocks a delivery channel without its supported capability', () => {
    expect(run({ capabilities: [] })).toMatchObject({
      allowed: false,
      code: 'capability-unavailable',
      reason: expect.stringContaining('Browser MP4'),
    });
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {},
      }),
    ).toMatchObject({ allowed: true });
  });

  it('keeps quick export available while the Worker envelope is unsupported', () => {
    const envelope = { visualObjectCount: 1, transitionCount: 1, captionBurnIn: true };
    expect(
      run({ channel: 'quick-browser-export', verifiedRenderEnvelope: envelope }),
    ).toMatchObject({ allowed: true });
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: envelope,
      }),
    ).toMatchObject({
      allowed: false,
      code: 'unsupported-render-envelope',
      reason: expect.stringContaining('visual overlays'),
    });
  });

  it.each([
    [{ transitionCount: 1 }, 'transitions'],
    [{ captionBurnIn: true }, 'burned-in captions'],
    [{ audioEffectCount: 1 }, 'audio effects'],
    [{ nonContiguous: true }, 'contiguous'],
    [{ nonOneXPlaybackCount: 1 }, '1× speed'],
    [{ unsupportedAssetCount: 1 }, 'file-backed video assets'],
  ] as const)('mirrors Worker rejection for %s', (verifiedRenderEnvelope, text) => {
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope,
      }),
    ).toMatchObject({
      allowed: false,
      code: 'unsupported-render-envelope',
      reason: expect.stringContaining(text),
    });
  });

  it('rejects unsupported dissolve cardinality before queueing verified delivery', () => {
    const clips = [
      { id: 'left', assetId: 'a', durationUs: 1_000_000, kind: 'video' as const },
      { id: 'right', assetId: 'b', durationUs: 1_000_000, kind: 'video' as const },
      { id: 'third', assetId: 'c', durationUs: 1_000_000, kind: 'video' as const },
    ];
    const mediaStates = new Map(clips.map((clip) => [clip.id, 'ready' as const]));
    expect(
      run({
        channel: 'verified-delivery',
        clips,
        mediaStates,
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: { transitionCount: 1, supportedTransitionCount: 1 },
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('exactly two') });
    expect(
      run({
        channel: 'verified-delivery',
        clips: clips.slice(0, 2),
        mediaStates,
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: { transitionCount: 2 },
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('at most one') });
  });

  it('rejects unsupported clip classes and non-1x clips for verified delivery', () => {
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {},
        clips: [{ ...CLIP, kind: 'composition' }],
      }),
    ).toMatchObject({ allowed: false, code: 'unsupported-render-envelope' });
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {},
        clips: [{ ...CLIP, playbackRate: 2 }],
      }),
    ).toMatchObject({ allowed: false, code: 'unsupported-render-envelope' });
  });

  it.each([0.1, 2, 8])('allows normalized V2 video playback rate %sx', (playbackRate) => {
    const videoClip: DeliveryTimelineClip = {
      ...CLIP,
      kind: 'video',
      playbackRate,
    };
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        clips: [videoClip],
        mediaStates: new Map([[videoClip.id, 'ready']]),
        verifiedRenderEnvelope: {
          verifiedRenderPlan: plannerPlan({
            layers: [
              {
                id: videoClip.id,
                kind: 'video',
                assetId: videoClip.assetId,
                startUs: 0,
                durationUs: videoClip.durationUs,
                sourceInUs: 0,
                playbackRate,
                zIndex: 0,
                x: 0,
                y: 0,
                scaleX: 1,
                scaleY: 1,
                opacity: 1,
              },
            ],
          }),
        },
      }),
    ).toMatchObject({ allowed: true });
  });

  it.each([0, 0.099, 8.001, Number.NaN])(
    'blocks normalized V2 video playback rate %s outside the host envelope',
    (playbackRate) => {
      const videoClip: DeliveryTimelineClip = { ...CLIP, kind: 'video', playbackRate };
      expect(
        run({
          channel: 'verified-delivery',
          capabilities: ['worker-render-export'],
          clips: [videoClip],
          mediaStates: new Map([[videoClip.id, 'ready']]),
          verifiedRenderEnvelope: { verifiedRenderPlan: plannerPlan() },
        }),
      ).toMatchObject({
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: expect.stringContaining('0.1×–8×'),
      });
    },
  );

  it.each([0.5, 2])('allows normalized V2 standalone audio playback rate %sx', (playbackRate) => {
    const audioClip: DeliveryTimelineClip = {
      id: 'audio-only-rate',
      assetId: 'audio-asset',
      durationUs: 1_000_000,
      kind: 'audio',
      playbackRate,
    };
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        clips: [CLIP, audioClip],
        mediaStates: new Map([
          [CLIP.id, 'ready'],
          [audioClip.id, 'ready'],
        ]),
        verifiedRenderEnvelope: {
          verifiedRenderPlan: plannerPlan({
            audio: [
              {
                id: audioClip.id,
                sourceKind: 'audio-asset',
                assetId: audioClip.assetId,
                startUs: 0,
                durationUs: audioClip.durationUs,
                sourceInUs: 0,
                playbackRate,
                gain: 1,
                pan: 0,
                mute: false,
              },
            ],
          }),
        },
      }),
    ).toMatchObject({ allowed: true });
  });

  it.each([0, 0.09, 8.01, Number.NaN])(
    'rejects invalid normalized V2 standalone audio playback rate %s',
    (playbackRate) => {
      const audioClip: DeliveryTimelineClip = {
        id: 'audio-only-rate',
        assetId: 'audio-asset',
        durationUs: 1_000_000,
        kind: 'audio',
        playbackRate,
      };
      expect(
        run({
          channel: 'verified-delivery',
          capabilities: ['worker-render-export'],
          clips: [CLIP, audioClip],
          mediaStates: new Map([
            [CLIP.id, 'ready'],
            [audioClip.id, 'ready'],
          ]),
          verifiedRenderEnvelope: { verifiedRenderPlan: plannerPlan() },
        }),
      ).toMatchObject({
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: expect.stringContaining('0.1×–8×'),
      });
    },
  );

  it('keeps non-1x standalone audio fail-closed for legacy envelopes', () => {
    const audioClip: DeliveryTimelineClip = {
      id: 'legacy-audio-rate',
      assetId: 'audio-asset',
      durationUs: 1_000_000,
      kind: 'audio',
      playbackRate: 2,
    };
    expect(
      run({
        channel: 'verified-delivery',
        capabilities: ['worker-render-export'],
        clips: [CLIP, audioClip],
        mediaStates: new Map([
          [CLIP.id, 'ready'],
          [audioClip.id, 'ready'],
        ]),
        verifiedRenderEnvelope: {},
      }),
    ).toMatchObject({
      allowed: false,
      code: 'unsupported-render-envelope',
      reason: 'Standalone audio clips must use 1× speed before using verified delivery.',
    });
  });

  it('preserves project audio playback rates when applying normalized and legacy rules', () => {
    const projectWithAudioRate = (playbackRate: number) => ({
      schemaVersion: 0 as const,
      id: 'project-audio-rate',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'root',
          width: 64,
          height: 36,
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          tracks: [
            {
              id: 'V1',
              kind: 'video' as const,
              order: 0,
              enabled: true,
              clips: [
                {
                  id: 'video',
                  kind: 'video' as const,
                  assetId: 'video',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
            {
              id: 'A1',
              kind: 'audio' as const,
              order: 1,
              enabled: true,
              clips: [
                {
                  id: 'music',
                  kind: 'audio' as const,
                  assetId: 'music',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                  playbackRate,
                },
              ],
            },
          ],
        },
      },
    });
    const project = projectWithAudioRate(2);
    const clips = deliveryTimelineClipsFromProject(project);
    expect(clips.find((clip) => clip.kind === 'audio')?.playbackRate).toBe(2);
    const mediaStates = new Map(clips.map((clip) => [clip.id, 'ready' as const]));
    expect(
      deliveryPreflight({
        channel: 'verified-delivery',
        clips,
        mediaStates,
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {},
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('1× speed') });
    expect(
      deliveryPreflight({
        channel: 'verified-delivery',
        clips,
        mediaStates,
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {
          verifiedRenderPlan: plannerPlan({
            audio: [
              {
                id: 'music',
                sourceKind: 'audio-asset',
                assetId: 'music',
                startUs: 0,
                durationUs: 1_000_000,
                sourceInUs: 0,
                playbackRate: 2,
                gain: 1,
                pan: 0,
                mute: false,
              },
            ],
          }),
        },
      }),
    ).toMatchObject({ allowed: true });
    const invalidProject = projectWithAudioRate(0.09);
    const invalidClips = deliveryTimelineClipsFromProject(invalidProject);
    expect(invalidClips.find((clip) => clip.kind === 'audio')?.playbackRate).toBe(0.09);
    expect(
      deliveryPreflight({
        channel: 'verified-delivery',
        clips: invalidClips,
        mediaStates: new Map(invalidClips.map((clip) => [clip.id, 'ready' as const])),
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: { verifiedRenderPlan: plannerPlan() },
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('0.1×–8×') });
  });

  it('projects video plus explicit audio clips into an allowed verified preflight', () => {
    const project = {
      schemaVersion: 0 as const,
      id: 'project',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'root',
          width: 64,
          height: 36,
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          tracks: [
            {
              id: 'V1',
              kind: 'video' as const,
              order: 0,
              enabled: true,
              clips: [
                {
                  id: 'dialogue',
                  kind: 'video' as const,
                  assetId: 'video',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
            {
              id: 'track-7',
              kind: 'audio' as const,
              order: 1,
              enabled: true,
              clips: [
                {
                  id: 'music',
                  kind: 'audio' as const,
                  assetId: 'music',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
          ],
        },
      },
    };
    const clips = deliveryTimelineClipsFromProject(project);
    expect(clips.map((clip) => clip.kind)).toEqual(['video', 'audio']);
    expect(
      deliveryPreflight({
        channel: 'verified-delivery',
        clips,
        mediaStates: new Map(clips.map((clip) => [clip.id, 'ready' as const])),
        capabilities: ['worker-render-export'],
        verifiedRenderEnvelope: {},
      }),
    ).toMatchObject({ allowed: true });
  });
});
