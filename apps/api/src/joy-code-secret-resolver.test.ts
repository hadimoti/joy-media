import { describe, expect, it } from 'vitest';
import {
  createJoyCodeSecretResolver,
  JOY_CODE_SECRET_REFERENCE,
} from './joy-code-secret-resolver.js';

describe('Joy Code secret resolver', () => {
  it('delegates only the canonical Joy Code ref', () => {
    const calls: string[] = [];
    const resolver = createJoyCodeSecretResolver({
      getSecret: (ref) => {
        calls.push(ref);
        return 'secret';
      },
    });
    expect(resolver.resolve(JOY_CODE_SECRET_REFERENCE)).toBe('secret');
    expect(resolver.resolve('joy-media/openrouter/creative-brief/v1')).toBeUndefined();
    expect(calls).toEqual([JOY_CODE_SECRET_REFERENCE]);
  });
});
