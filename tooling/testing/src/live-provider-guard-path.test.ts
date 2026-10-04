import { describe, expect, it } from 'vitest';
import { resolveChildGuardPath } from '../live-provider-guard-path.js';

describe('resolveChildGuardPath', () => {
  it('finds the child guard from the repository root when import.meta.url is not file-based', () => {
    expect(
      resolveChildGuardPath('http://localhost/tooling/testing/live-provider-guard.ts'),
    ).toEqual(expect.stringMatching(/tooling[\\/]testing[\\/]live-provider-guard-child\.mjs$/u));
  });
});
