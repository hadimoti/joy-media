import { describe, expect, it } from 'vitest';
import { parseLaneMode } from './p3-lane-mode.mjs';

describe('P3 lane mode', () => {
  it('defaults to the full lane and accepts the explicit P3 lane', () => {
    expect(parseLaneMode()).toBe('full');
    expect(parseLaneMode('p3')).toBe('p3');
  });

  it('rejects unknown modes and smoke-only P3', () => {
    expect(() => parseLaneMode('diagnostic')).toThrow(/must be full or p3/);
    expect(() => parseLaneMode('p3', { smokeOnly: true })).toThrow(/smoke-only/);
  });
});
