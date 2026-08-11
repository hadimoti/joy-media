import { describe, expect, it } from 'vitest';
import {
  buildRulerTicks,
  clampPixelsPerSecond,
  clipRateLabel,
  commitMove,
  createCompoundCommand,
  fitPixelsPerSecond,
  formatRulerLabel,
  placeDuplicateAfter,
  pixelToTime,
  previewMove,
  rippleDelete,
  snapTime,
  splitCommand,
  timeToPixel,
  toggleSelection,
  toggleClipReverseCommand,
  trimCommand,
  toggleTrackFlag,
  virtualTracks,
  visibleRange,
} from './index.js';
describe('timeline coordinates', () => {
  it('round trips coordinates and snaps inside the pixel threshold', () => {
    const viewport = { originUs: 1_000_000, pixelsPerSecond: 100 };
    expect(pixelToTime(timeToPixel(2_500_000, viewport), viewport)).toBe(2_500_000);
    expect(snapTime(2_049_000, [2_000_000], viewport, 8)).toBe(2_000_000);
    expect(snapTime(2_090_000, [2_000_000], viewport, 8)).toBe(2_090_000);
  });
  it('keeps drag previews transient and emits one snapped move command on commit', () => {
    const viewport = { originUs: 0, pixelsPerSecond: 100 };
    const preview = previewMove('clip-a', 0, 1_049_000, [1_000_000], viewport);
    expect(preview.snappedStartUs).toBe(1_000_000);
    expect(commitMove('root', 'track-0', preview)).toMatchObject({
      type: 'timeline.moveClip',
      payload: { newStartUs: 1_000_000 },
    });
    expect(visibleRange(viewport, 250)).toEqual({ startUs: 0, endUs: 2_500_000 });
  });
  it('builds selection, trim/split, and atomic ripple-delete intent', () => {
    expect(toggleSelection({ clipIds: ['a'] }, 'b')).toEqual({ clipIds: ['a', 'b'] });
    expect(trimCommand('root', 't', 'a', 'end', 10)).toMatchObject({
      type: 'timeline.trimClipEnd',
    });
    expect(splitCommand('root', 't', 'a', 5, 'a-2')).toMatchObject({ type: 'timeline.splitClip' });
    expect(toggleClipReverseCommand('root', 't', 'a')).toMatchObject({
      type: 'timeline.toggleClipReverse',
    });
    expect(createCompoundCommand('root', 't', ['a', 'b'], 'nested', 'compound')).toMatchObject({
      type: 'timeline.createCompound',
      payload: { clipIds: ['a', 'b'], compoundCompositionId: 'nested' },
    });
    expect(
      rippleDelete(
        'root',
        't',
        [
          { id: 'a', startUs: 0, durationUs: 10 },
          { id: 'b', startUs: 20, durationUs: 10 },
        ],
        'a',
      ),
    ).toMatchObject({
      commands: [
        { type: 'timeline.removeClip' },
        { type: 'timeline.moveClip', payload: { clipId: 'b', newStartUs: 10 } },
      ],
    });
  });
  it('virtualizes visible track rows and keeps track controls ephemeral', () => {
    const tracks = [
      { id: 'a', heightPx: 20, locked: false, visible: true, solo: false },
      { id: 'b', heightPx: 20, locked: false, visible: true, solo: false },
      { id: 'c', heightPx: 20, locked: false, visible: true, solo: false },
    ];
    expect(virtualTracks(tracks, 20, 20).map((track) => track.id)).toEqual(['a', 'b', 'c']);
    expect(toggleTrackFlag(tracks[0]!, 'visible').visible).toBe(false);
  });
  it('fits zoom to width and places duplicates after gaps', () => {
    expect(fitPixelsPerSecond(10_000_000, 224, 24)).toBe(20);
    expect(fitPixelsPerSecond(7_200_000_000, 1_024, 24)).toBeCloseTo(1_000 / 7_200);
    expect(clampPixelsPerSecond(1000)).toBe(200);
    expect(
      placeDuplicateAfter({ id: 'a', startUs: 0, durationUs: 10 }, [
        { id: 'a', startUs: 0, durationUs: 10 },
        { id: 'b', startUs: 10, durationUs: 5 },
      ]),
    ).toBe(15);
    expect(
      clipRateLabel({
        kind: 'video',
        id: 'x',
        startUs: 0,
        durationUs: 1,
        assetId: 'a',
        sourceInUs: 0,
        playbackRate: 2,
      }),
    ).toBe('2×');
    expect(
      clipRateLabel({
        kind: 'video',
        id: 'x',
        startUs: 0,
        durationUs: 1,
        assetId: 'a',
        sourceInUs: 0,
        playbackRate: 0,
      }),
    ).toBe('❄');
    expect(
      clipRateLabel({
        kind: 'video',
        id: 'reverse',
        startUs: 0,
        durationUs: 1,
        assetId: 'a',
        sourceInUs: 0,
        reversed: true,
      }),
    ).toBe('↺');
  });
});

describe('ruler ticks', () => {
  it('uses denser majors when zoomed in and sparser when zoomed out', () => {
    const durationUs = 60_000_000;
    const dense = buildRulerTicks({ durationUs, pixelsPerSecond: 200, minMajorPx: 80 });
    const sparse = buildRulerTicks({ durationUs, pixelsPerSecond: 5, minMajorPx: 80 });
    const denseMajors = dense.filter((t) => t.major);
    const sparseMajors = sparse.filter((t) => t.major);
    expect(denseMajors.length).toBeGreaterThan(sparseMajors.length);
    // At 200 px/s, 0.5s major = 100px ≥ 80 → majors every 0.5s
    expect(denseMajors[1]!.timeUs - denseMajors[0]!.timeUs).toBe(500_000);
    // At 5 px/s, 30s major = 150px → majors every 30s
    expect(sparseMajors[1]!.timeUs - sparseMajors[0]!.timeUs).toBe(30_000_000);
  });

  it('clamps ticks to duration and formats compact labels', () => {
    const ticks = buildRulerTicks({
      durationUs: 2_500_000,
      pixelsPerSecond: 100,
      minMajorPx: 80,
    });
    expect(ticks.every((t) => t.timeUs <= 2_500_000)).toBe(true);
    expect(ticks.some((t) => t.timeUs === 0)).toBe(true);
    expect(formatRulerLabel(0)).toBe('0:00');
    expect(formatRulerLabel(65_000_000)).toBe('1:05');
    expect(formatRulerLabel(3_661_000_000)).toBe('1:01:01');
  });
});
