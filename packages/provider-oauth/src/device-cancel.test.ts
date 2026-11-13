import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './http.js';
import { KIMI_CODE_OAUTH_HOST, signInWithKimiCode } from './kimi.js';
import { XAI_OAUTH_DISCOVERY_URL, signInWithXai } from './xai.js';

/**
 * T-J03 item 6: Kimi and xAI (device code) stop polling as soon as the sign-in is cancelled, and
 * the cancelled attempt never polls again. Fake fetch only; no provider is contacted.
 */

const NOW = Date.UTC(2026, 9, 30);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Kimi device sign-in cancelled while it polls (T-J03)', () => {
  it('stops polling at once and rejects with CANCELLED', async () => {
    vi.useFakeTimers({ now: NOW });
    let tokenPolls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'fake-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        tokenPolls += 1;
        return json({ error: 'authorization_pending' }, 400);
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const controller = new AbortController();
    const pending = signInWithKimiCode({
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 1_000,
      signal: controller.signal,
    });
    const outcome = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(tokenPolls).toBe(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toMatchObject({ code: 'CANCELLED' });
    // The waiting poll never runs: the count stays where cancellation found it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tokenPolls).toBe(1);
  });

  it('a sign-in whose signal is already aborted never polls', async () => {
    vi.useFakeTimers({ now: NOW });
    let tokenPolls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'fake-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        tokenPolls += 1;
        return json({ error: 'authorization_pending' }, 400);
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const controller = new AbortController();
    controller.abort();
    const outcome = await signInWithKimiCode({
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 1_000,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(tokenPolls).toBe(0);
  });
});

describe('xAI device sign-in cancelled while it polls (T-J03)', () => {
  it('stops polling at once and rejects with CANCELLED', async () => {
    vi.useFakeTimers({ now: NOW });
    let polls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        return json({
          issuer: 'https://auth.x.ai',
          device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
          token_endpoint: 'https://auth.x.ai/oauth2/token',
        });
      }
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return json({
          device_code: 'fake-device-code',
          user_code: 'FAKE-CODE',
          verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=FAKE-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        polls += 1;
        return json({ error: 'authorization_pending' }, 400);
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const controller = new AbortController();
    const outcome = signInWithXai({
      clientId: 'fake-public-client',
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 1_000,
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls).toBe(1);
  });
});
