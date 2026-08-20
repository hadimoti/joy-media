import { describe, expect, it } from 'vitest';
import {
  createOpenRouterSystemdCredentialSource,
  CREATIVE_BRIEF_OPENROUTER_REF,
  JOY_CODE_OPENROUTER_REF,
} from './openrouter-systemd-credential-source.js';

describe('OpenRouter systemd credential source', () => {
  it('reads the encrypted credential once and maps both exact logical refs', () => {
    let reads = 0;
    const source = createOpenRouterSystemdCredentialSource((path) => {
      reads += 1;
      expect(path).toContain('openrouter-api-key');
      return 'opaque-secret\n';
    }, '/run/credentials/service');
    expect(source.getSecret(CREATIVE_BRIEF_OPENROUTER_REF)).toBe('opaque-secret');
    expect(source.getSecret(JOY_CODE_OPENROUTER_REF)).toBe('opaque-secret');
    expect(source.getSecret('other')).toBeUndefined();
    expect(reads).toBe(1);
  });
  it('fails closed on missing/empty credential without exposing values', () => {
    expect(
      createOpenRouterSystemdCredentialSource(() => '').getSecret(JOY_CODE_OPENROUTER_REF),
    ).toBeUndefined();
    expect(
      createOpenRouterSystemdCredentialSource(() => {
        throw new Error('secret');
      }).getSecret(CREATIVE_BRIEF_OPENROUTER_REF),
    ).toBeUndefined();
  });
});
