import { describe, expect, it } from 'vitest';
import {
  hasExhaustiveInputCoverage,
  isFrameWithinHalfOpenRange,
  summarizeEvidenceCoverage,
  type EvidenceCoverage,
} from './observation-coverage.js';

const exhaustive = (overrides: Partial<EvidenceCoverage> = {}): EvidenceCoverage => ({
  mode: 'exhaustive',
  intendedFrameIds: ['a', 'b', 'c'],
  decodedFrameIds: ['a', 'b', 'c'],
  submittedFrameIds: ['a', 'b', 'c'],
  reviewedFrameIds: ['a', 'b', 'c'],
  status: 'complete',
  ...overrides,
});

describe('observation evidence coverage', () => {
  it('requires every exhaustive source frame to be decoded, submitted, and reviewed', () => {
    expect(hasExhaustiveInputCoverage(exhaustive())).toBe(true);
    expect(hasExhaustiveInputCoverage(exhaustive({ reviewedFrameIds: ['a', 'c'] }))).toBe(false);
    expect(hasExhaustiveInputCoverage(exhaustive({ decodedFrameIds: ['a', 'a', 'c'] }))).toBe(
      false,
    );
  });

  it('never labels provider, cancelled, partial, or zero-frame work exhaustive', () => {
    expect(hasExhaustiveInputCoverage(exhaustive({ mode: 'provider-video' }))).toBe(false);
    expect(hasExhaustiveInputCoverage(exhaustive({ status: 'cancelled' }))).toBe(false);
    expect(hasExhaustiveInputCoverage(exhaustive({ status: 'partial' }))).toBe(false);
    expect(hasExhaustiveInputCoverage(exhaustive({ intendedFrameIds: [] }))).toBe(false);
  });

  it('uses half-open source ranges and reports incomplete counts without claiming comprehension', () => {
    expect(
      isFrameWithinHalfOpenRange(
        { startUs: 500, durationUs: 100 },
        { startUs: 500, durationUs: 1 },
      ),
    ).toBe(true);
    expect(
      isFrameWithinHalfOpenRange(
        { startUs: 500, durationUs: 100 },
        { startUs: 600, durationUs: 1 },
      ),
    ).toBe(false);
    expect(summarizeEvidenceCoverage(exhaustive({ reviewedFrameIds: ['a'] }))).toMatchObject({
      exhaustiveInput: false,
      reviewedCount: 1,
      modelComprehensionGuaranteed: false,
    });
  });
});
