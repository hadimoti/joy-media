import { describe, expect, it } from 'vitest';
import { redactUnknownValue, toSafeJoyAgentError } from './redaction.js';

describe('JOY Agent redaction', () => {
  it('projects secrets and provider diagnostics out of arbitrary values', () => {
    const value = {
      apiKey: 'not-a-real-key',
      authorization: 'Bearer sentinel',
      endpoint: 'https://provider.invalid/v1',
      prompt: 'private user text',
      nested: { selector: '#private', reason: 'safe' },
    };
    expect(redactUnknownValue(value)).toEqual({
      apiKey: '[Redacted]',
      authorization: '[Redacted]',
      endpoint: '[Redacted]',
      prompt: '[Redacted]',
      nested: { selector: '[Redacted]', reason: 'safe' },
    });
  });

  it('handles circular values and hostile getters without throwing', () => {
    const value: Record<string, unknown> = { name: 'provider failure' };
    value.self = value;
    Object.defineProperty(value, 'throws', {
      enumerable: true,
      get: () => {
        throw new Error('getter');
      },
    });
    expect(() => redactUnknownValue(value)).not.toThrow();
    const projected = redactUnknownValue(value) as Record<string, unknown>;
    expect(projected.self).toBe('[Circular]');
  });

  it('maps errors to stable safe codes without preserving provider data', () => {
    const safe = toSafeJoyAgentError(new Error('401 provider rejected private response body'));
    expect(safe).toEqual({ code: 'JOY_AGENT_AUTH_FAILED', retryable: false });
    expect(Object.keys(safe)).toEqual(['code', 'retryable']);
  });
});
