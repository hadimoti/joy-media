import { describe, expect, it } from 'vitest';
import { selectOverviewFrames } from './sampling-policy.js';

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
});
