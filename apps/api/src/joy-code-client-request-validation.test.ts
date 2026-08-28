import { describe, expect, it } from 'vitest';
import { validateJoyCodeClientRequest } from './joy-code-client-request-validation.js';

const valid = {
  projectId: 'p',
  snapshotRevisionId: 'r',
  prompt: 'trim clips',
  selection: { clipIds: ['clip-1'], objectIds: [] },
};
describe('Joy Code client envelope validation', () => {
  it('accepts only the bounded prompt and selection envelope', () => {
    expect(validateJoyCodeClientRequest(valid)).toMatchObject({ valid: true });
    expect(validateJoyCodeClientRequest({ ...valid, snapshot: {} })).toMatchObject({
      valid: false,
    });
    expect(validateJoyCodeClientRequest({ ...valid, prompt: 'x'.repeat(20_001) })).toMatchObject({
      valid: false,
    });
  });
  it('rejects unknown IDs, paths, URLs, and secrets', () => {
    expect(
      validateJoyCodeClientRequest({ ...valid, selection: { clipIds: ['../secret'] } }),
    ).toMatchObject({ valid: false });
    expect(validateJoyCodeClientRequest({ ...valid, prompt: 'https://example.com' })).toMatchObject(
      { valid: false },
    );
    expect(validateJoyCodeClientRequest({ ...valid, prompt: 'sk-1234567890abcdef' })).toMatchObject(
      { valid: false },
    );
  });
});
