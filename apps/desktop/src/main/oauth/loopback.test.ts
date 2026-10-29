import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startLoopbackCallback } from './loopback.js';

/** One GET to the loopback listener. A refused connection rejects. */
function get(url: string, hostHeader?: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: hostHeader === undefined ? {} : { host: hostHeader },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startLoopbackCallback', () => {
  it('takes the code on the expected state, answers the page and stops listening', async () => {
    const callback = await startLoopbackCallback({
      path: '/callback',
      expectedState: 'state-1',
      timeoutMs: 5_000,
    });
    expect(callback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const reply = await get(`${callback.redirectUri}?code=the-code&state=state-1`);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Sign-in complete');
    await expect(callback.code).resolves.toBe('the-code');

    // One-shot: the listener is closed, so a second callback cannot connect.
    await expect(get(`${callback.redirectUri}?code=again&state=state-1`)).rejects.toThrow();
  });

  it('refuses a state that does not match and ends the flow with STATE_MISMATCH', async () => {
    const callback = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    const reply = await get(`${callback.redirectUri}?code=the-code&state=other`);
    expect(reply.status).toBe(400);
    await expect(callback.code).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await expect(get(callback.redirectUri)).rejects.toThrow();
  });

  it('settles with the code when the browser drops the connection before the page arrives', async () => {
    const callback = await startLoopbackCallback({
      path: '/callback',
      expectedState: 'state-1',
      timeoutMs: 5_000,
    });
    const target = new URL(`${callback.redirectUri}?code=the-code&state=state-1`);
    await new Promise<void>((resolve) => {
      const req = request({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
      });
      req.on('error', () => undefined);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });
    await expect(callback.code).resolves.toBe('the-code');
  });

  it('ends the flow with ACCESS_DENIED when the person declines', async () => {
    const callback = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    await get(`${callback.redirectUri}?error=access_denied&state=state-1`);
    await expect(callback.code).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(get(callback.redirectUri)).rejects.toThrow();
  });

  it('ends the flow with CALLBACK_ERROR on another provider error, and never echoes its text', async () => {
    const callback = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    const reply = await get(
      `${callback.redirectUri}?error=server_error&error_description=sk-secret-value&state=state-1`,
    );
    expect(reply.body).not.toContain('sk-secret-value');
    await expect(callback.code).rejects.toMatchObject({ code: 'CALLBACK_ERROR' });
  });

  it('ends the flow with CALLBACK_INVALID when the callback has no code', async () => {
    const callback = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    await get(`${callback.redirectUri}?state=state-1`);
    await expect(callback.code).rejects.toMatchObject({ code: 'CALLBACK_INVALID' });
  });

  it('ignores another path and another host name, and keeps waiting for the callback', async () => {
    const callback = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    const port = new URL(callback.redirectUri).port;

    const otherPath = await get(`http://127.0.0.1:${port}/other?code=x&state=state-1`);
    expect(otherPath.status).toBe(404);
    const otherHost = await get(`${callback.redirectUri}?code=x&state=state-1`, 'evil.test');
    expect(otherHost.status).toBe(404);

    await get(`${callback.redirectUri}?code=the-code&state=state-1`);
    await expect(callback.code).resolves.toBe('the-code');
  });

  it('times out with TIMEOUT and stops listening', async () => {
    const callback = await startLoopbackCallback({
      path: '/callback',
      expectedState: 'state-1',
      timeoutMs: 30,
    });
    await expect(callback.code).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(get(callback.redirectUri)).rejects.toThrow();
  });

  it('is cancelled by the caller, and closing it twice is harmless', async () => {
    const callback = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    callback.close();
    await expect(callback.code).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(() => callback.close()).not.toThrow();
    await expect(get(callback.redirectUri)).rejects.toThrow();
  });

  it('reports LISTEN_FAILED when the fixed port is already in use', async () => {
    const first = await startLoopbackCallback({ path: '/callback', expectedState: 'state-1' });
    const port = Number(new URL(first.redirectUri).port);
    try {
      await expect(
        startLoopbackCallback({ path: '/callback', expectedState: 'state-1', port }),
      ).rejects.toMatchObject({ code: 'LISTEN_FAILED' });
    } finally {
      first.close();
    }
  });
});
