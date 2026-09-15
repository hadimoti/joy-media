import { describe, expect, it } from 'vitest';
import { resolveJoyAgentObservationAuthority } from './observation-run-authority.js';

const expected = {
  projectId: 'project-1',
  revision: 'revision-1',
  modelId: 'openrouter/model-a',
  promptPolicyDigest: 'a'.repeat(64),
} as const;

const current = {
  ...expected,
  run: { runId: 'run-1', epoch: 2 },
  terminal: false,
} as const;

describe('JOY observation run authority', () => {
  it('mints only an exact nonterminal run binding', () => {
    expect(resolveJoyAgentObservationAuthority(expected, current)).toEqual({
      ...expected,
      run: { runId: 'run-1', epoch: 2 },
    });
  });

  it.each([
    ['missing active run', { ...current, run: undefined }],
    ['terminal lifecycle', { ...current, terminal: true }],
    ['project switch', { ...current, projectId: 'project-2' }],
    ['revision change', { ...current, revision: 'revision-2' }],
    ['model reconfigure', { ...current, modelId: 'openrouter/model-b' }],
    ['policy change', { ...current, promptPolicyDigest: 'b'.repeat(64) }],
  ])('fails closed for %s', (_reason, candidate) => {
    expect(resolveJoyAgentObservationAuthority(expected, candidate)).toBeUndefined();
  });
});
