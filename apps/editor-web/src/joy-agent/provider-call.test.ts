import { describe, expect, it } from 'vitest';
import { ProviderCallError, sessionProviderFor } from './provider-call.js';

describe('sessionProviderFor', () => {
  it('maps the saved providers this build runs onto the session providers', () => {
    expect(sessionProviderFor('openrouter')).toBe('openrouter');
    expect(sessionProviderFor('openai-compatible')).toBe('openai-compatible');
    expect(sessionProviderFor('custom')).toBe('openai-compatible');
    // A registry provider runs on the chat session; the broker decides the endpoint.
    expect(sessionProviderFor('claude')).toBe('openai-compatible');
    expect(sessionProviderFor('kimi')).toBe('openai-compatible');
  });

  it('refuses a v1.0.x provider that this build no longer runs', () => {
    expect(sessionProviderFor('kilo')).toBeUndefined();
    expect(sessionProviderFor('joy-hosted')).toBeUndefined();
  });
});

describe('ProviderCallError', () => {
  it('keeps the broker code and the message', () => {
    const error = new ProviderCallError('AUTH_FAILED', 'The provider rejected the credentials.');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 'AUTH_FAILED',
      message: 'The provider rejected the credentials.',
    });
  });
});
