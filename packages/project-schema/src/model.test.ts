import { describe, expect, it } from 'vitest';
import type { SpikeProject } from './model.js';
import { validateSpikeProject } from './model.js';
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
