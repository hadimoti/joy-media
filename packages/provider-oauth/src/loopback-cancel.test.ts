import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { OAuthFlowError } from './errors.js';
import { newExtAgentHostId, signInWithChatGpt } from './chatgpt.js';
import { startLoopbackCallback, LOOPBACK_HOST } from './loopback.js';

/**
 * T-J03: a cancelled sign-in frees its callback port before the call returns, so the next attempt
 * can listen on the same fixed port. Loopback sockets only: no provider is contacted.
 */

/** A port that is free right now, for the fixed-port cases. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK_HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const EXPECTED = {
  path: '/auth/callback',
  expectedState: 'state-a',
} as const;

describe('a sign-in listener on a fixed port (T-J03)', () => {
  it('a second listener on the same port is refused while the first is still listening', async () => {
    const port = await freePort();
    const first = await startLoopbackCallback({ ...EXPECTED, port });
    await expect(startLoopbackCallback({ ...EXPECTED, port })).rejects.toMatchObject({
      code: 'LISTEN_FAILED',
    });
    first.close();
    await first.closed;
  });

  it('after close() resolves, the port is free for the next listener', async () => {
    const port = await freePort();
    const first = await startLoopbackCallback({ ...EXPECTED, port });
    first.close();
    await first.closed;

    const second = await startLoopbackCallback({ ...EXPECTED, port });
    expect(second.redirectUri).toBe(`http://${LOOPBACK_HOST}:${port}${EXPECTED.path}`);
    second.close();
    await second.closed;
  });

  it('aborting the signal cancels the flow with CANCELLED and frees the port', async () => {
    const port = await freePort();
    const controller = new AbortController();
    const first = await startLoopbackCallback({ ...EXPECTED, port, signal: controller.signal });

    controller.abort();

    await expect(first.code).rejects.toMatchObject({ code: 'CANCELLED' });
    await first.closed;
    const second = await startLoopbackCallback({ ...EXPECTED, port });
    second.close();
    await second.closed;
  });

  it('a signal that is already aborted closes the listener straight away', async () => {
    const port = await freePort();
    const controller = new AbortController();
    controller.abort();
    const listener = await startLoopbackCallback({ ...EXPECTED, port, signal: controller.signal });
    await expect(listener.code).rejects.toBeInstanceOf(OAuthFlowError);
    await listener.closed;
    const next = await startLoopbackCallback({ ...EXPECTED, port });
    next.close();
    await next.closed;
  });

  it('the callback of a cancelled attempt is refused: nothing listens on the old address any more', async () => {
    const port = await freePort();
    const first = await startLoopbackCallback({ ...EXPECTED, port });
    const redirect = first.redirectUri;
    first.close();
    await first.closed;

    // The browser's late redirect reaches no listener, so no code can be taken from it.
    await expect(fetch(`${redirect}?state=state-a&code=late`)).rejects.toThrow();
    const handled = first.code.catch((error: unknown) => error);
    await expect(handled).resolves.toMatchObject({ code: 'CANCELLED' });
  });

  it('a callback answered by a cancelled attempt is refused with 404 and never returns a code', async () => {
    const port = await freePort();
    const first = await startLoopbackCallback({ ...EXPECTED, port });
    const callbackUrl = `${first.redirectUri}?state=state-a&code=late`;
    first.close();
    await first.closed;
    const outcome = await first.code.then(
      () => 'resolved',
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(outcome).toBe('CANCELLED');
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });
});

describe('a ChatGPT sign-in on the fixed port, cancelled and started again (T-J03)', () => {
  it('cancels the first attempt and the second listens on the same port', async () => {
    const port = await freePort();
    const openExternal = vi.fn();
    const deps = {
      issuedClientId: 'client-1',
      extAgentHostId: newExtAgentHostId(),
      openExternal,
      fetch: vi.fn(),
      now: () => 0,
      port,
    };
    const controller = new AbortController();
    const first = signInWithChatGpt({ ...deps, signal: controller.signal });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));

    // A second attempt while the first waits: the first is cancelled first, then the second listens.
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });

    const second = new AbortController();
    const again = signInWithChatGpt({ ...deps, signal: second.signal });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    const authUrl = String(openExternal.mock.calls[1]?.[0]);
    expect(authUrl).toContain(encodeURIComponent(`http://${LOOPBACK_HOST}:${port}/auth/callback`));

    second.abort();
    await expect(again).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
