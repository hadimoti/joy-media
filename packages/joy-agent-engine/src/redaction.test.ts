import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { classifyJoyAgentError, redactUnknownValue, toSafeJoyAgentError } from './redaction.js';

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

  it('classifies API status codes and leaves unknown errors unknown', () => {
    const classify = (statusCode: number, responseBody?: string) =>
      classifyJoyAgentError(
        new APICallError({
          message: 'request failed',
          url: 'https://provider.invalid/chat',
          requestBodyValues: {},
          statusCode,
          ...(responseBody === undefined ? {} : { responseBody }),
        }),
      );

    expect(classify(401)).toBe('JOY_AGENT_AUTH_FAILED');
    expect(classify(403)).toBe('JOY_AGENT_AUTH_FAILED');
    expect(classify(404)).toBe('JOY_AGENT_MODEL_NOT_FOUND');
    expect(classify(408)).toBe('JOY_AGENT_TIMEOUT');
    expect(classify(504)).toBe('JOY_AGENT_TIMEOUT');
    expect(classify(429)).toBe('JOY_AGENT_RATE_LIMITED');
    expect(classify(503)).toBe('JOY_AGENT_UPSTREAM_UNAVAILABLE');
    expect(classify(400, 'invalid tool call')).toBe('JOY_AGENT_INVALID_TOOL');
    expect(classifyJoyAgentError(new Error('weird'))).toBe('JOY_AGENT_UNKNOWN');
  });

  it('marks only transient provider failures retryable', () => {
    expect(toSafeJoyAgentError(new Error('unknown'))).toEqual({
      code: 'JOY_AGENT_UNKNOWN',
      retryable: false,
    });
    expect(toSafeJoyAgentError(new Error('request timeout')).retryable).toBe(true);
  });
});
