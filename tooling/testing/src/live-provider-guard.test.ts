import { describe, expect, it } from 'vitest';
import https from 'node:https';

describe('test live-provider guard', () => {
  it('blocks provider fetches before they can reach the network', async () => {
    await expect(fetch('https://api.openai.com/v1/models')).rejects.toThrow(
      'live provider call blocked in tests',
    );
  });

  it('blocks Node HTTPS requests to provider hosts', () => {
    expect(() => https.request('https://api.anthropic.com/v1/messages')).toThrow(
      'live provider call blocked in tests',
    );
  });
});
