import { describe, expect, it } from 'vitest';
import type { SpikeProject } from '@joy-media/project-schema';
import { frameStartUs, rational, validateSpikeProject } from '@joy-media/project-schema';
import { evaluateFrame } from './evaluate.js';

const NTSC = rational(30000, 1001);
const SECOND = 1_000_000;

/**
 * The §36-P0-1 fixture: two video clips with source ranges plus one nested
 * composition, on an NTSC-rate root composition.
 *
 * root (30000/1001, 10 s)
 *   track-main (order 0):
 *     clip-a  [0 s, 2 s)   asset-a, sourceIn 10 s
 *     clip-b  [2 s, 4 s)   asset-b, sourceIn 0 s
 *     clip-n  [4 s, 6 s)   nested comp-child, childOffset 0.5 s
 *   track-overlay (order 1):
 *     clip-o  [1 s, 3 s)   asset-o, sourceIn 0 s
 * comp-child (30/1, 3 s)
 *   track-child (order 0):
 *     clip-c  [0.25 s, 2.75 s)  asset-c, sourceIn 7 s
 */
function fixture(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'spike-eval',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        frameRate: NTSC,
        durationUs: 10 * SECOND,
        tracks: [
          {
            id: 'track-main',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: 2 * SECOND,
                assetId: 'asset-a',
                sourceInUs: 10 * SECOND,
              },
              {
                kind: 'video',
                id: 'clip-b',
                startUs: 2 * SECOND,
                durationUs: 2 * SECOND,
                assetId: 'asset-b',
                sourceInUs: 0,
              },
              {
                kind: 'composition',
                id: 'clip-n',
                startUs: 4 * SECOND,
                durationUs: 2 * SECOND,
                compositionId: 'comp-child',
                childOffsetUs: SECOND / 2,
              },
            ],
          },
          {
            id: 'track-overlay',
            kind: 'video',
            order: 1,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-o',
                startUs: SECOND,
                durationUs: 2 * SECOND,
                assetId: 'asset-o',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
      'comp-child': {
        id: 'comp-child',
        name: 'Child',
        width: 1080,
        height: 1920,
        frameRate: rational(30, 1),
        durationUs: 3 * SECOND,
        tracks: [
          {
            id: 'track-child',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-c',
                startUs: SECOND / 4,
                durationUs: (5 * SECOND) / 2,
                assetId: 'asset-c',
                sourceInUs: 7 * SECOND,
              },
            ],
          },
        ],
      },
    },
  };
}

function playbackFixture(playbackRate: number | undefined): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'playback-eval',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        frameRate: rational(30, 1),
        durationUs: 6 * SECOND,
        tracks: [
          {
            id: 'track-main',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-rate',
                startUs: SECOND,
                durationUs: 2 * SECOND,
                assetId: 'asset-rate',
                sourceInUs: 10 * SECOND,
                ...(playbackRate === undefined ? {} : { playbackRate }),
              },
            ],
          },
        ],
      },
    },
  };
}

describe('spike fixture', () => {
  it('passes validation', () => {
    expect(validateSpikeProject(fixture())).toEqual([]);
  });
});

describe('evaluateFrame', () => {
  it('maps composition time to exact source time', () => {
    const result = evaluateFrame(fixture(), 'root', SECOND / 2);
    expect(result.frames).toEqual([
      { clipPath: ['clip-a'], assetId: 'asset-a', sourceTimeUs: 10 * SECOND + SECOND / 2 },
    ]);
  });

  it('evaluates at exact NTSC frame timestamps with matching frame index', () => {
    // Frames 0..59 all fall inside clip-a's [0 s, 2 s): frame 59 starts at
    // ceil(59 * 1001e6 / 30000) = 1_968_634 µs; frame 60 (2_002_000 µs) would not.
    for (const frameIndex of [0, 1, 29, 30, 59]) {
      const t = frameStartUs(frameIndex, NTSC);
      const result = evaluateFrame(fixture(), 'root', t);
      expect(result.frameIndex).toBe(frameIndex);
      const first = result.frames[0];
      expect(first).toBeDefined();
      expect(first!.assetId).toBe('asset-a');
      expect(first!.sourceTimeUs).toBe(10 * SECOND + t);
      expect(Number.isSafeInteger(first!.sourceTimeUs)).toBe(true);
    }
  });

  it('clip boundaries are end-exclusive: at exactly 2 s only clip-b is active on track-main', () => {
    const result = evaluateFrame(fixture(), 'root', 2 * SECOND);
    const mainFrames = result.frames.filter((f) => f.clipPath[0] !== 'clip-o');
    expect(mainFrames).toEqual([{ clipPath: ['clip-b'], assetId: 'asset-b', sourceTimeUs: 0 }]);
  });

  it.each([
    { label: 'freeze', playbackRate: 0, playheadUs: SECOND, expected: 10 * SECOND },
    { label: 'half speed', playbackRate: 0.5, playheadUs: 2 * SECOND, expected: 10.5 * SECOND },
    { label: 'normal speed', playbackRate: 1, playheadUs: 2 * SECOND, expected: 11 * SECOND },
    { label: 'double speed', playbackRate: 2, playheadUs: 2 * SECOND, expected: 12 * SECOND },
  ])(
    'honors $label playback mapping from source in-point through the active range',
    ({ playbackRate, playheadUs, expected }) => {
      const result = evaluateFrame(playbackFixture(playbackRate), 'root', playheadUs);
      expect(result.frames).toEqual([
        { clipPath: ['clip-rate'], assetId: 'asset-rate', sourceTimeUs: expected },
      ]);
    },
  );

  it('keeps playback-mapped clips end-exclusive at source out', () => {
    expect(evaluateFrame(playbackFixture(2), 'root', 3 * SECOND).frames).toEqual([]);
  });

  it('returns frames in draw order (ascending track order = bottom to top)', () => {
    const result = evaluateFrame(fixture(), 'root', 1.5 * SECOND);
    expect(result.frames.map((f) => f.assetId)).toEqual(['asset-a', 'asset-o']);
  });

  it('skips disabled tracks', () => {
    const project = fixture();
    const mutated: SpikeProject = JSON.parse(JSON.stringify(project));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mutated.compositions['root']!.tracks[1] as any).enabled = false;
    const result = evaluateFrame(mutated, 'root', 1.5 * SECOND);
    expect(result.frames.map((f) => f.assetId)).toEqual(['asset-a']);
  });

  it('maps time through a nested composition: root t -> child t -> source t', () => {
    // root t = 5 s -> clip-n local 1 s -> child t = 0.5 + 1 = 1.5 s
    // clip-c local = 1.5 - 0.25 = 1.25 s -> source = 7 + 1.25 = 8.25 s
    const result = evaluateFrame(fixture(), 'root', 5 * SECOND);
    expect(result.frames).toEqual([
      {
        clipPath: ['clip-n', 'clip-c'],
        assetId: 'asset-c',
        sourceTimeUs: 8.25 * SECOND,
      },
    ]);
  });

  it('nested child content ends when the child composition ends', () => {
    // root t = 5.9 s -> child t = 0.5 + 1.9 = 2.4 s < 3 s: clip-c still active
    const active = evaluateFrame(fixture(), 'root', 5_900_000);
    expect(active.frames).toHaveLength(1);
    // clip-c ends at child t 2.75 s -> root t = 4 + (2.75 - 0.5) = 6.25 s, but
    // clip-n itself ends at 6 s (end-exclusive), so at exactly 6 s nothing shows.
    const after = evaluateFrame(fixture(), 'root', 6 * SECOND);
    expect(after.frames).toEqual([]);
  });

  it('returns no frames in empty regions and past the end', () => {
    expect(evaluateFrame(fixture(), 'root', 7 * SECOND).frames).toEqual([]);
    expect(evaluateFrame(fixture(), 'root', 9 * SECOND).frames).toEqual([]);
  });

  it('same input always yields the same output (deterministic, §14.4 spirit)', () => {
    const a = evaluateFrame(fixture(), 'root', 5 * SECOND);
    const b = evaluateFrame(fixture(), 'root', 5 * SECOND);
    expect(a).toEqual(b);
  });

  it('throws on unknown compositions', () => {
    expect(() => evaluateFrame(fixture(), 'nope', 0)).toThrow(/unknown composition/);
  });
});
