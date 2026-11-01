import { describe, expect, it } from 'vitest';
import { getOAuthClient } from './oauth-clients.js';

describe('OAuth client configuration', () => {
  it('does not expose a MiniMax OAuth client after D23', () => {
    expect(getOAuthClient('minimax')).toBeUndefined();
  });

  it('uses the public client default when no override is present', () => {
    expect(getOAuthClient('kimi')?.clientId).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
    expect(getOAuthClient('xai')?.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828');
  });

  it('falls back to the default when a settings override is empty or whitespace', () => {
    expect(getOAuthClient('kimi', '')?.clientId).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
    expect(getOAuthClient('kimi', '   ')?.clientId).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
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
