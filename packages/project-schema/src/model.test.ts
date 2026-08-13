import { describe, expect, it } from 'vitest';
import type { SpikeProject } from './model.js';
import { sourceTimeAtVideoClipTime, validateSpikeProject, validateTimeRemap } from './model.js';
import { rational } from './time.js';

function baseProject(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'proj-1',
    rootCompositionId: 'comp-root',
    compositions: {
      'comp-root': {
        id: 'comp-root',
        name: 'Root',
        width: 1080,
        height: 1920,
        frameRate: rational(30000, 1001),
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'track-1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: 2_000_000,
                assetId: 'asset-a',
                sourceInUs: 10_000_000,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('validateSpikeProject', () => {
  it('accepts a valid project', () => {
    expect(validateSpikeProject(baseProject())).toEqual([]);
  });

  it('maps reversed clips from their timeline-start source time', () => {
    const clip = {
      kind: 'video' as const,
      id: 'reverse',
      startUs: 1_000_000,
      durationUs: 2_000_000,
      assetId: 'asset-a',
      sourceInUs: 9_000_000,
      reversed: true,
    };
    expect(sourceTimeAtVideoClipTime(clip, 1_000_000)).toBe(9_000_000);
    expect(sourceTimeAtVideoClipTime(clip, 1_500_000)).toBe(8_500_000);
  });

  it('samples a validated monotonic time-remap curve in clip-local time', () => {
    const clip = {
      kind: 'video' as const,
      id: 'remapped',
      startUs: 1_000_000,
      durationUs: 2_000_000,
      assetId: 'asset-a',
      sourceInUs: 10_000_000,
      timeRemap: {
        version: 2 as const,
        direction: 'forward' as const,
        keyframes: [
          { timeUs: 0, sourceTimeUs: 10_000_000, interpolation: 'linear' as const },
          { timeUs: 1_000_000, sourceTimeUs: 12_000_000, interpolation: 'linear' as const },
          { timeUs: 2_000_000, sourceTimeUs: 12_000_000, interpolation: 'hold' as const },
        ],
      },
    };
    expect(validateTimeRemap(clip.timeRemap, clip.durationUs)).toEqual([]);
    expect(sourceTimeAtVideoClipTime(clip, 1_500_000)).toBe(11_000_000);
    expect(sourceTimeAtVideoClipTime(clip, 2_000_000)).toBe(12_000_000);
  });

  it('rejects non-monotonic or non-zero-start remaps', () => {
    const remap = {
      version: 2 as const,
      direction: 'forward' as const,
      keyframes: [
        { timeUs: 100, sourceTimeUs: 10, interpolation: 'linear' as const },
        { timeUs: 200, sourceTimeUs: 5, interpolation: 'linear' as const },
      ],
    };
    expect(validateTimeRemap(remap, 1_000)).toEqual([
      'source times must be monotonic for forward remap',
      'first keyframe must start at clip-local time 0',
    ]);
  });

  it('flags a missing root composition', () => {
    const project = { ...baseProject(), rootCompositionId: 'nope' };
    const codes = validateSpikeProject(project).map((d) => d.code);
    expect(codes).toContain('PROJECT_SCHEMA_MISSING_ROOT');
  });

  it('flags zero-duration clips', () => {
    const project = baseProject();
    const mutated: SpikeProject = JSON.parse(JSON.stringify(project));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mutated.compositions['comp-root']!.tracks[0]!.clips[0] as any).durationUs = 0;
    const codes = validateSpikeProject(mutated).map((d) => d.code);
    expect(codes).toContain('PROJECT_SCHEMA_BAD_CLIP_RANGE');
  });

  it('accepts freeze (0) and in-range playback rates', () => {
    const project = baseProject();
    const mutated: SpikeProject = JSON.parse(JSON.stringify(project));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mutated.compositions['comp-root']!.tracks[0]!.clips[0] as any).playbackRate = 0;
    expect(validateSpikeProject(mutated)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mutated.compositions['comp-root']!.tracks[0]!.clips[0] as any).playbackRate = 2;
    expect(validateSpikeProject(mutated)).toEqual([]);
  });

  it('flags out-of-range playback rates', () => {
    const project = baseProject();
    const mutated: SpikeProject = JSON.parse(JSON.stringify(project));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mutated.compositions['comp-root']!.tracks[0]!.clips[0] as any).playbackRate = 0.05;
    const codes = validateSpikeProject(mutated).map((d) => d.code);
    expect(codes).toContain('PROJECT_SCHEMA_BAD_PLAYBACK_RATE');
  });

  it('flags references to unknown compositions', () => {
    const project = baseProject();
    const mutated: SpikeProject = JSON.parse(JSON.stringify(project));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mutated.compositions['comp-root']!.tracks[0] as any).clips.push({
      kind: 'composition',
      id: 'clip-nested',
      startUs: 2_000_000,
      durationUs: 1_000_000,
      compositionId: 'comp-missing',
      childOffsetUs: 0,
    });
    const codes = validateSpikeProject(mutated).map((d) => d.code);
    expect(codes).toContain('PROJECT_SCHEMA_MISSING_COMPOSITION');
  });

  it('detects composition cycles (§19.6 recursion detection)', () => {
    const project = baseProject();
    const mutated: SpikeProject = JSON.parse(JSON.stringify(project));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compositions = mutated.compositions as any;
    compositions['comp-a'] = {
      id: 'comp-a',
      name: 'A',
      width: 1080,
      height: 1920,
      frameRate: rational(30, 1),
      durationUs: 5_000_000,
      tracks: [
        {
          id: 'track-a',
          kind: 'video',
          order: 0,
          enabled: true,
          clips: [
            {
              kind: 'composition',
              id: 'clip-b-in-a',
              startUs: 0,
              durationUs: 1_000_000,
              compositionId: 'comp-b',
              childOffsetUs: 0,
            },
          ],
        },
      ],
    };
    compositions['comp-b'] = {
      id: 'comp-b',
      name: 'B',
      width: 1080,
      height: 1920,
      frameRate: rational(30, 1),
      durationUs: 5_000_000,
      tracks: [
        {
          id: 'track-b',
          kind: 'video',
          order: 0,
          enabled: true,
          clips: [
            {
              kind: 'composition',
              id: 'clip-a-in-b',
              startUs: 0,
              durationUs: 1_000_000,
              compositionId: 'comp-a',
              childOffsetUs: 0,
            },
          ],
        },
      ],
    };
    const codes = validateSpikeProject(mutated).map((d) => d.code);
    expect(codes).toContain('PROJECT_SCHEMA_COMPOSITION_CYCLE');
  });
});
