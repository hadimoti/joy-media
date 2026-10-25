import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_HEADER,
  CONTROL_TOKEN_ENV,
  isSyntheticContact,
  SYNTHETIC_CLIENT_HEADER,
  syntheticControlToken,
} from '../../e2e-synthetic-accounts.js';

/**
 * Acceptance for the synthetic-account harness. It starts the real E2E server as a separate process
 * and drives the real /v1/auth and /v1/account endpoints. The control port is only used to read a
 * recorded one-time code and to seed subscription states or expire rows, which a payment provider and
 * a clock would otherwise do.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const apiRoot = resolve(repoRoot, 'apps/api');
const tsxCli = resolve(apiRoot, 'node_modules/tsx/dist/cli.mjs');
const serverEntry = resolve(repoRoot, 'tooling/e2e-server.ts');
const CONTROL_TOKEN = randomBytes(32).toString('base64url');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        address !== null && typeof address !== 'string'
          ? resolvePort(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

describe('synthetic account harness on the E2E server', () => {
  let server: ChildProcess | undefined;
  let api = '';
  let control = '';
  let serverOutput = '';
  // One OTP rate-limit bucket per test, so the production limit is exercised without cross-test bleed.
  let clientKey = '';

  beforeEach(() => {
    clientKey = randomBytes(8).toString('hex');
  });

  beforeAll(async () => {
    const apiPort = await freePort();
    const controlPort = await freePort();
    api = `http://127.0.0.1:${apiPort}`;
    control = `http://127.0.0.1:${controlPort}`;
    server = spawn(process.execPath, [tsxCli, serverEntry], {
      cwd: apiRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        [CONTROL_TOKEN_ENV]: CONTROL_TOKEN,
        JOY_MEDIA_E2E_API_PORT: String(apiPort),
        JOY_MEDIA_E2E_CONTROL_PORT: String(controlPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString('utf8')));
    server.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString('utf8')));
    const deadline = Date.now() + 120_000;
    while (
      !serverOutput.includes('JOY_MEDIA_E2E_SYNTHETIC_CONTROL_READY') ||
      !serverOutput.includes('JOY_MEDIA_E2E_API_READY')
    ) {
      if (Date.now() > deadline)
        throw new Error(`E2E server did not become ready:\n${serverOutput}`);
      if (server.exitCode !== null) throw new Error(`E2E server exited early:\n${serverOutput}`);
      await new Promise((done) => setTimeout(done, 200));
    }
  }, 150_000);

  afterAll(() => {
    server?.kill('SIGTERM');
  });

  async function ctrl(path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(control + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [CONTROL_HEADER]: CONTROL_TOKEN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function call(
    path: string,
    options: { method?: string; body?: unknown; bearer?: string; clientKey?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(api + path, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [SYNTHETIC_CLIENT_HEADER]: options.clientKey ?? clientKey,
        ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
  }

  /** Full real login: request a code, read the test-mode code, verify it. */
  async function login(contact: string): Promise<string> {
    const requested = await call('/v1/auth/request-otp', {
      method: 'POST',
      body: { contact, method: 'gmail' },
    });
    expect(requested.status).toBe(200);
    const latest = await ctrl(`/__e2e/otp/latest?contact=${encodeURIComponent(contact)}`);
    expect(latest.status).toBe(200);
    const verified = await call('/v1/auth/verify-otp', {
      method: 'POST',
      body: { contact, method: 'gmail', code: latest.body.data.code },
    });
    expect(verified.status).toBe(200);
    return verified.body.data.token as string;
  }

  it('logs a synthetic account in with the real one-time code and reads its session back', async () => {
    const contact = `login-${Date.now()}@synthetic.joy-media.test`;
    expect(isSyntheticContact(contact)).toBe(true);
    expect((await ctrl('/__e2e/accounts', { contact })).status).toBe(200);
    const token = await login(contact);
    const session = await call('/v1/auth/session', { bearer: token });
    expect(session.status).toBe(200);
    expect(session.body.data.contact).toBe(contact);
  }, 60_000);

  it('keeps a session usable across repeated requests until it expires or is revoked', async () => {
    const contact = `persist-${Date.now()}@synthetic.joy-media.test`;
    await ctrl('/__e2e/accounts', { contact });
    const token = await login(contact);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await call('/v1/auth/session', { bearer: token })).status).toBe(200);
    }
  }, 60_000);

  it('rejects a wrong code and a code that was already used', async () => {
    const contact = `codes-${Date.now()}@synthetic.joy-media.test`;
    await ctrl('/__e2e/accounts', { contact });
    await call('/v1/auth/request-otp', { method: 'POST', body: { contact, method: 'gmail' } });
    const latest = await ctrl(`/__e2e/otp/latest?contact=${encodeURIComponent(contact)}`);
    const wrong = await call('/v1/auth/verify-otp', {
      method: 'POST',
      body: { contact, method: 'gmail', code: '000000' },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const good = await call('/v1/auth/verify-otp', {
      method: 'POST',
      body: { contact, method: 'gmail', code: latest.body.data.code },
    });
    expect(good.status).toBe(200);
    const replay = await call('/v1/auth/verify-otp', {
      method: 'POST',
      body: { contact, method: 'gmail', code: latest.body.data.code },
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('refuses a session after logout', async () => {
    const contact = `logout-${Date.now()}@synthetic.joy-media.test`;
    await ctrl('/__e2e/accounts', { contact });
    const token = await login(contact);
    expect(
      (await call('/v1/auth/logout', { method: 'POST', body: {}, bearer: token })).status,
    ).toBe(200);
    expect((await call('/v1/auth/session', { bearer: token })).status).toBe(401);
  }, 60_000);

  it('refuses a session once the server-side expiry has passed', async () => {
    const contact = `expiry-${Date.now()}@synthetic.joy-media.test`;
    await ctrl('/__e2e/accounts', { contact });
    const token = await login(contact);
    expect((await call('/v1/auth/session', { bearer: token })).status).toBe(200);
    const expired = await ctrl('/__e2e/sessions/expire', { contact });
    expect(expired.body.data.expired).toBeGreaterThanOrEqual(1);
    expect((await call('/v1/auth/session', { bearer: token })).status).toBe(401);
  }, 60_000);

  it('refuses a one-time code whose window has passed', async () => {
    const contact = `otp-expiry-${Date.now()}@synthetic.joy-media.test`;
    await ctrl('/__e2e/accounts', { contact });
    await call('/v1/auth/request-otp', { method: 'POST', body: { contact, method: 'gmail' } });
    const latest = await ctrl(`/__e2e/otp/latest?contact=${encodeURIComponent(contact)}`);
    await ctrl('/__e2e/otp/expire', { contact });
    const stale = await call('/v1/auth/verify-otp', {
      method: 'POST',
      body: { contact, method: 'gmail', code: latest.body.data.code },
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('reports each subscription state from the real account service', async () => {
    const contact = `plans-${Date.now()}@synthetic.joy-media.test`;
    await ctrl('/__e2e/accounts', { contact });
    const token = await login(contact);
    const read = async () =>
      (await call('/v1/account/subscription', { bearer: token })).body.data.status;
    expect(await read()).toBe('none');
    await ctrl('/__e2e/subscriptions', { contact, state: 'active' });
    expect(await read()).toBe('active');
    await ctrl('/__e2e/subscriptions', { contact, state: 'expired' });
    expect(await read()).toBe('expired');
  }, 60_000);

  it('keeps the production OTP rate limit: a fourth request from one client in the window is throttled', async () => {
    const contact = `throttle-${Date.now()}@synthetic.joy-media.test`;
    const sameClient = `throttle-${randomBytes(4).toString('hex')}`;
    await ctrl('/__e2e/accounts', { contact });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allowed = await call('/v1/auth/request-otp', {
        method: 'POST',
        body: { contact, method: 'gmail' },
        clientKey: sameClient,
      });
      expect(allowed.status).toBe(200);
    }
    const throttled = await call('/v1/auth/request-otp', {
      method: 'POST',
      body: { contact, method: 'gmail' },
      clientKey: sameClient,
    });
    expect(throttled.status).toBe(429);
  }, 60_000);

  it('does not send a code to a contact that is not on the allow-list', async () => {
    const stranger = `stranger-${Date.now()}@synthetic.joy-media.test`;
    await call('/v1/auth/request-otp', {
      method: 'POST',
      body: { contact: stranger, method: 'gmail' },
    });
    expect((await ctrl(`/__e2e/otp/latest?contact=${encodeURIComponent(stranger)}`)).status).toBe(
      404,
    );
  }, 60_000);

  it('refuses control requests that do not carry the control token', async () => {
    const response = await fetch(`${control}/__e2e/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact: 'x@synthetic.joy-media.test' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('synthetic account harness configuration', () => {
  it('stays off without a control token', () => {
    expect(syntheticControlToken({})).toBeUndefined();
  });

  it('rejects a short control token', () => {
    expect(() => syntheticControlToken({ [CONTROL_TOKEN_ENV]: 'short' })).toThrow(/at least 32/);
  });

  it('refuses to run under NODE_ENV=production even with a valid token', () => {
    expect(() =>
      syntheticControlToken({ [CONTROL_TOKEN_ENV]: 'x'.repeat(40), NODE_ENV: 'production' }),
    ).toThrow(/never run with NODE_ENV=production/);
  });
});
