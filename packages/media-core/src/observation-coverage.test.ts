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
    const longFrameIdentityKey = [
      'source-frame:v1',
      'a'.repeat(64),
      'stream'.repeat(21) + 'st',
      '0',
      '9'.repeat(25),
      'timebase-1-9007199254740991',
    ].join(':');
    expect(longFrameIdentityKey.length).toBeGreaterThan(256);
    expect(
      hasExhaustiveInputCoverage(
        exhaustive({
          intendedFrameIds: [longFrameIdentityKey],
          decodedFrameIds: [longFrameIdentityKey],
          submittedFrameIds: [longFrameIdentityKey],
          reviewedFrameIds: [longFrameIdentityKey],
        }),
      ),
    ).toBe(true);
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
    expect(
      isFrameWithinHalfOpenRange(
        { startUs: 500, durationUs: 100 },
        { startUs: 450, durationUs: 100 },
      ),
    ).toBe(true);
    expect(() =>
      isFrameWithinHalfOpenRange(
        { startUs: Number.NaN, durationUs: 100 },
        { startUs: 500, durationUs: 1 },
      ),
    ).toThrow('requested');
    expect(summarizeEvidenceCoverage(exhaustive({ reviewedFrameIds: ['a'] }))).toMatchObject({
      exhaustiveInput: false,
      reviewedCount: 1,
      modelComprehensionGuaranteed: false,
    });
  });

  it('does not treat an empty frame interval or unbounded/unsafe page data as valid coverage', () => {
    expect(
      isFrameWithinHalfOpenRange({ startUs: 0, durationUs: 100 }, { startUs: 50, durationUs: 0 }),
    ).toBe(false);
    const unsafe = exhaustive({
      intendedFrameIds: ['https://example.test/frame'],
      decodedFrameIds: ['https://example.test/frame'],
      submittedFrameIds: ['https://example.test/frame'],
      reviewedFrameIds: ['https://example.test/frame'],
    });
    expect(hasExhaustiveInputCoverage(unsafe)).toBe(false);
    const unsafeScheme = exhaustive({
      intendedFrameIds: ['data:private-frame'],
      decodedFrameIds: ['data:private-frame'],
      submittedFrameIds: ['data:private-frame'],
      reviewedFrameIds: ['data:private-frame'],
    });
    expect(hasExhaustiveInputCoverage(unsafeScheme)).toBe(false);
    const unsafeReason = exhaustive({ omittedReason: 'See https://example.test/frame.' });
    expect(hasExhaustiveInputCoverage(unsafeReason)).toBe(false);
    expect(() => summarizeEvidenceCoverage(unsafeReason)).toThrow('bounded page');

    const ids = Array.from({ length: 1_025 }, (_, index) => `frame-${index}`);
    const oversized = exhaustive({
      intendedFrameIds: ids,
      decodedFrameIds: ids,
      submittedFrameIds: ids,
      reviewedFrameIds: ids,
    });
    expect(hasExhaustiveInputCoverage(oversized)).toBe(false);
    expect(() => summarizeEvidenceCoverage(oversized)).toThrow('bounded page');
  });
});
