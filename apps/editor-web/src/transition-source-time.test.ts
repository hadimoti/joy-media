import { describe, expect, it } from 'vitest';
import {
  sourceTimeAtVideoClipTime,
  type TransitionV1,
  type VideoClip,
} from '@joy-media/project-schema';
import { sourceTimeForTransitionSample } from './transition-source-time.js';

/** Times are microseconds, as in the project model. */
const SECOND = 1_000_000;
/** The incoming clip starts here, so the cut is at this playhead time. */
const CUT_US = 10 * SECOND;
const DISSOLVE_US = 500_000;

const dissolve: TransitionV1 = {
  id: 'dissolve-1',
  trackId: 'track-1',
  leftClipId: 'clip-a',
  rightClipId: 'clip-b',
  type: 'dissolve',
  durationUs: DISSOLVE_US,
};

/** The incoming clip: 4 s long, starting at the cut, with its in-point at 5 s. */
function incoming(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'clip-b',
    kind: 'video',
    assetId: 'asset-b',
    startUs: CUT_US,
    durationUs: 4 * SECOND,
    sourceInUs: 5 * SECOND,
    ...overrides,
  };
}

/** Source time at each playhead time of the dissolve window, in steps of `stepUs`. */
function windowTimes(clip: VideoClip, stepUs: number): number[] {
  const times: number[] = [];
  for (let playheadUs = CUT_US - DISSOLVE_US; playheadUs < CUT_US; playheadUs += stepUs) {
    times.push(sourceTimeForTransitionSample(clip, playheadUs, dissolve));
  }
  return times;
}

describe('incoming clip in a dissolve window', () => {
  it('forward at rate 1 starts a dissolve length before its in-point and meets it at the cut', () => {
    const clip = incoming();
    expect(sourceTimeAtVideoClipTime(clip, CUT_US)).toBe(5_000_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - DISSOLVE_US, dissolve)).toBe(4_500_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve)).toBe(4_999_999);
  });

  it('forward at rate 2 covers twice the source in the same window', () => {
    const clip = incoming({ playbackRate: 2 });
    expect(sourceTimeForTransitionSample(clip, CUT_US - DISSOLVE_US, dissolve)).toBe(4_000_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve)).toBe(4_999_998);
  });

  it('forward with no handle frames holds the first frame until the source runs out', () => {
    const clip = incoming({ sourceInUs: 200_000 });
    expect(sourceTimeForTransitionSample(clip, CUT_US - DISSOLVE_US, dissolve)).toBe(0);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 100_000, dissolve)).toBe(100_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve)).toBe(199_999);
  });

  it('reversed at rate 1 starts a dissolve length above its in-point and comes down to it at the cut', () => {
    const clip = incoming({ reversed: true });
    expect(sourceTimeAtVideoClipTime(clip, CUT_US)).toBe(5_000_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - DISSOLVE_US, dissolve)).toBe(5_500_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 250_000, dissolve)).toBe(5_250_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve)).toBe(5_000_001);
  });

  it('reversed at rate 2 covers twice the source in the same window', () => {
    const clip = incoming({ reversed: true, playbackRate: 2 });
    expect(sourceTimeForTransitionSample(clip, CUT_US - DISSOLVE_US, dissolve)).toBe(6_000_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve)).toBe(5_000_002);
  });

  it('reversed keeps running down from its in-point after the cut', () => {
    const clip = incoming({ reversed: true });
    expect(sourceTimeForTransitionSample(clip, CUT_US + SECOND, dissolve)).toBe(4_000_000);
  });

  it('a frozen clip holds its in-point through the window in either direction', () => {
    for (const reversed of [false, true]) {
      const clip = incoming({ playbackRate: 0, reversed });
      expect(windowTimes(clip, 100_000).every((time) => time === 5_000_000)).toBe(true);
    }
  });

  it('keeps every window sample between the cut values, moving toward the cut', () => {
    for (const rate of [0.5, 1, 2, 4]) {
      for (const reversed of [false, true]) {
        for (const sourceInUs of [200_000, 5_000_000]) {
          const clip = incoming({ playbackRate: rate, reversed, sourceInUs });
          const times = windowTimes(clip, 10_000);
          const lower = reversed ? sourceInUs : 0;
          const upper = reversed ? sourceInUs + DISSOLVE_US * rate : sourceInUs;
          for (let index = 0; index < times.length; index++) {
            const time = times[index]!;
            expect(time).toBeGreaterThanOrEqual(lower);
            expect(time).toBeLessThanOrEqual(upper);
            if (index > 0) {
              const previous = times[index - 1]!;
              if (reversed) expect(time).toBeLessThanOrEqual(previous);
              else expect(time).toBeGreaterThanOrEqual(previous);
            }
          }
          const atCut = sourceTimeAtVideoClipTime(clip, CUT_US);
          const justBeforeCut = sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve);
          // The reversed mapping rounds to whole microseconds, so the last sample may be one more off.
          expect(Math.abs(justBeforeCut - atCut)).toBeLessThanOrEqual(rate + 1);
        }
      }
    }
  });

  it('the outgoing clip keeps its normal mapping through the window', () => {
    const outgoing: VideoClip = {
      id: 'clip-a',
      kind: 'video',
      assetId: 'asset-a',
      startUs: 6 * SECOND,
      durationUs: 4 * SECOND,
      sourceInUs: 2 * SECOND,
    };
    expect(sourceTimeForTransitionSample(outgoing, CUT_US - 300_000, dissolve)).toBe(5_700_000);
    const reversedOutgoing: VideoClip = { ...outgoing, reversed: true, sourceInUs: 9 * SECOND };
    expect(sourceTimeForTransitionSample(reversedOutgoing, CUT_US - 300_000, dissolve)).toBe(
      sourceTimeAtVideoClipTime(reversedOutgoing, CUT_US - 300_000),
    );
  });

  it('after the cut the incoming clip follows its own mapping', () => {
    expect(sourceTimeForTransitionSample(incoming(), CUT_US + 200_000, dissolve)).toBe(5_200_000);
  });

  it('without a transition the incoming clip holds its in-point before its start', () => {
    expect(sourceTimeForTransitionSample(incoming(), CUT_US - 1, undefined)).toBe(5_000_000);
  });

  it('the cut frame is the in-point in both directions', () => {
    expect(sourceTimeForTransitionSample(incoming(), CUT_US, dissolve)).toBe(5_000_000);
    const reversed = incoming({ reversed: true });
    expect(sourceTimeForTransitionSample(reversed, CUT_US, dissolve)).toBe(5_000_000);
  });

  it('reversed at rate 0.5 rounds each window sample to whole microseconds', () => {
    const clip = incoming({ reversed: true, playbackRate: 0.5 });
    expect(sourceTimeForTransitionSample(clip, CUT_US - DISSOLVE_US, dissolve)).toBe(5_250_000);
    expect(sourceTimeForTransitionSample(clip, CUT_US - 1, dissolve)).toBe(5_000_001);
  });
});
