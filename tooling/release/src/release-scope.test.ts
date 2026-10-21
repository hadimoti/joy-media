import { describe, expect, it } from 'vitest';
import { releaseScopeFromEnv } from './gate.js';

describe('release scope from the environment', () => {
  it('evaluates one pass only for an exact pass value', () => {
    expect(releaseScopeFromEnv({ JOY_RELEASE_SCOPE: 'pass' })).toBe('pass');
  });

  it('fails closed to the release scope for every other value', () => {
    expect(releaseScopeFromEnv({ JOY_RELEASE_SCOPE: 'release' })).toBe('release');
    expect(releaseScopeFromEnv({ JOY_RELEASE_SCOPE: 'PASS' })).toBe('release');
    expect(releaseScopeFromEnv({ JOY_RELEASE_SCOPE: ' pass' })).toBe('release');
    expect(releaseScopeFromEnv({})).toBe('release');
  });
});
