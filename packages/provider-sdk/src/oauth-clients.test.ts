import { describe, expect, it } from 'vitest';
import { getOAuthClient } from './oauth-clients.js';

describe('OAuth client configuration', () => {
  it('uses a non-empty settings override before a public default', () => {
    expect(getOAuthClient('minimax', '  joy-registered-minimax-client  ')).toMatchObject({
      clientId: 'joy-registered-minimax-client',
      configurable: true,
    });
  });

  it('uses the public client default when no override is present', () => {
    expect(getOAuthClient('minimax')?.clientId).toBe('78257093-7e40-4613-99e0-527b14b39113');
    expect(getOAuthClient('kimi')?.clientId).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
    expect(getOAuthClient('xai')?.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828');
  });

  it('falls back to the default when a settings override is empty or whitespace', () => {
    expect(getOAuthClient('minimax', '')?.clientId).toBe('78257093-7e40-4613-99e0-527b14b39113');
    expect(getOAuthClient('minimax', '   ')?.clientId).toBe('78257093-7e40-4613-99e0-527b14b39113');
  });

  it('leaves ChatGPT without a client ID for SIWC dynamic registration by default', () => {
    expect(getOAuthClient('chatgpt')).toMatchObject({ clientId: undefined, configurable: true });
    expect(getOAuthClient('chatgpt', 'joy-chatgpt-client')?.clientId).toBe('joy-chatgpt-client');
  });

  it('does not resolve a provider that has no OAuth client entry', () => {
    expect(getOAuthClient('deepseek')).toBeUndefined();
    expect(getOAuthClient('not-a-provider')).toBeUndefined();
  });
});
