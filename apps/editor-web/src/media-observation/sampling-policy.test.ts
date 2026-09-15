import { describe, expect, it } from 'vitest';
import { createCanonicalFrameSampler, selectOverviewFrames } from './sampling-policy.js';

const frames = Array.from({ length: 10 }, (_, index) => ({
  id: `frame-${index}`,
  sourceTimeUs: index * 1_000_000,
  eventScore: index === 5 ? 10 : 0,
}));

describe('overview sampling policy', () => {
  it('keeps chronological endpoint coverage and important events while reporting omissions', () => {
    expect(selectOverviewFrames(frames, { maxFrames: 4 })).toEqual({
      mode: 'overview',
      selectedFrameIds: ['frame-0', 'frame-3', 'frame-5', 'frame-9'],
      omittedFrameCount: 6,
      completeSourceCoverage: false,
    });
  });

  it('never claims a capped overview covers every source frame', () => {
    expect(selectOverviewFrames(frames, { maxFrames: 2 })).toMatchObject({
      completeSourceCoverage: false,
      omittedFrameCount: 8,
    });
    expect(selectOverviewFrames(frames, { maxFrames: 20 })).toMatchObject({
      completeSourceCoverage: true,
      omittedFrameCount: 0,
    });
  });

  it('does not replace a selected stronger event with a weaker event', () => {
    const selected = selectOverviewFrames(
      Array.from({ length: 7 }, (_, index) => ({
        id: `frame-${index}`,
        sourceTimeUs: index * 1_000_000,
        eventScore: index === 2 ? 10 : index === 4 ? 1 : 0,
      })),
      { maxFrames: 3 },
    );

    expect(selected.selectedFrameIds).toEqual(['frame-0', 'frame-2', 'frame-6']);
  });
});

describe('canonical frame sampler', () => {
  const add = (
    sampler: ReturnType<typeof createCanonicalFrameSampler>,
    frames: readonly { id: string; sourceTimeUs: number; durationUs: number }[],
  ) => {
    frames.forEach((frame, index) => sampler.add({ ...frame, presentationIndex: index }));
  };

  it('claims complete coverage only when every source identity is selected', () => {
    const sampler = createCanonicalFrameSampler({ startUs: 0, endUs: 300_000 }, { maxFrames: 3 });
    add(sampler, [
      { id: 'f0', sourceTimeUs: 0, durationUs: 100_000 },
      { id: 'f1', sourceTimeUs: 100_000, durationUs: 100_000 },
      { id: 'f2', sourceTimeUs: 200_000, durationUs: 100_000 },
    ]);
    const result = sampler.finish();
    expect(result.selectedFrameIds).toEqual(['f0', 'f1', 'f2']);
    expect(result.sourceFrameCount).toBe(3);
    expect(result.completeSourceCoverage).toBe(true);
  });

  it('does not claim complete coverage when a small source count leaves a frame unvisited', () => {
    // Three source frames but the last one starts at the exclusive range end,
    // so no time target ever lands inside it.
    const sampler = createCanonicalFrameSampler({ startUs: 0, endUs: 200_000 }, { maxFrames: 3 });
    add(sampler, [
      { id: 'f0', sourceTimeUs: 0, durationUs: 100_000 },
      { id: 'f1', sourceTimeUs: 100_000, durationUs: 100_000 },
      { id: 'f2', sourceTimeUs: 200_000, durationUs: 100_000 },
    ]);
    const result = sampler.finish();
    expect(result.sourceFrameCount).toBe(3);
    expect(result.selectedFrameIds).not.toContain('f2');
    expect(result.completeSourceCoverage).toBe(false);
  });
});
