import { describe, expect, it } from 'vitest';
import { sourceTimeAtPlayhead } from './source-time.js';

describe('source-time mapping', () => {
  it('maps only inside the end-exclusive clip range', () => {
    const clip = { startUs: 1_000_000, durationUs: 2_000_000, sourceInUs: 500_000 };
    expect(sourceTimeAtPlayhead(clip, 1_000_000)).toBe(500_000);
    expect(sourceTimeAtPlayhead(clip, 2_500_000)).toBe(2_000_000);
    expect(sourceTimeAtPlayhead(clip, 3_000_000)).toBeUndefined();
  });
});
