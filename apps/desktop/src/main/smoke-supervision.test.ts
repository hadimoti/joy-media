import { describe, expect, it } from 'vitest';
import {
  SMOKE_NONCE_ENVIRONMENT,
  SMOKE_SUPERVISED_ENVIRONMENT,
  SmokeIsolationError,
  isSupervisedSmokeRun,
  smokeNonceFromEnvironment,
} from './smoke-isolation.js';

const FRESH = 'd'.repeat(32);

describe('smokeNonceFromEnvironment', () => {
  it('uses the nonce the supervisor supplies', () => {
    const supplied = 'c'.repeat(32);
    expect(smokeNonceFromEnvironment({ [SMOKE_NONCE_ENVIRONMENT]: supplied }, () => FRESH)).toBe(
      supplied,
    );
  });

  it('makes a fresh nonce when none is supplied, or the value is empty', () => {
    expect(smokeNonceFromEnvironment({}, () => FRESH)).toBe(FRESH);
    expect(smokeNonceFromEnvironment({ [SMOKE_NONCE_ENVIRONMENT]: '' }, () => FRESH)).toBe(FRESH);
  });

  it('refuses a supplied nonce that is malformed, rather than choosing another folder silently', () => {
    expect(() =>
      smokeNonceFromEnvironment({ [SMOKE_NONCE_ENVIRONMENT]: '..\\Users' }, () => FRESH),
    ).toThrow(SmokeIsolationError);
    expect(() =>
      smokeNonceFromEnvironment({ [SMOKE_NONCE_ENVIRONMENT]: 'C'.repeat(32) }, () => FRESH),
    ).toThrow(SmokeIsolationError);
    expect(() =>
      smokeNonceFromEnvironment({ [SMOKE_NONCE_ENVIRONMENT]: 'a'.repeat(31) }, () => FRESH),
    ).toThrow(SmokeIsolationError);
  });
});

describe('isSupervisedSmokeRun', () => {
  it('is true only when the supervisor sets the flag to exactly 1', () => {
    expect(isSupervisedSmokeRun({ [SMOKE_SUPERVISED_ENVIRONMENT]: '1' })).toBe(true);
    expect(isSupervisedSmokeRun({ [SMOKE_SUPERVISED_ENVIRONMENT]: 'true' })).toBe(false);
    expect(isSupervisedSmokeRun({})).toBe(false);
  });
});
