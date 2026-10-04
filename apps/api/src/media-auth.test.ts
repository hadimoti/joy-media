import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import { BoundedOtpRateLimitMap, MediaAuthError, MediaAuthService } from './media-auth.js';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function service(
  overrides: {
    mailer?: { sendOtp: ReturnType<typeof vi.fn> } | undefined;
    accountRateLimitMax?: number;
    otpSendConcurrency?: number;
    otpDeliveryTimeoutMs?: number;
  } = {},
) {
  const db = pool();
  const configuredMailer = Object.hasOwn(overrides, 'mailer')
    ? overrides.mailer
    : { sendOtp: vi.fn(async () => undefined) };
  const mailer = configuredMailer ?? { sendOtp: vi.fn(async () => undefined) };
  const telegram = { sendOtp: vi.fn(async () => undefined) };
  const auth = new MediaAuthService({
    pool: db,
    ...(configuredMailer === undefined ? {} : { mailer: configuredMailer }),
    telegram,
    ...(overrides.accountRateLimitMax === undefined
      ? {}
      : { accountRateLimitMax: overrides.accountRateLimitMax }),
    ...(overrides.otpSendConcurrency === undefined
      ? {}
      : { otpSendConcurrency: overrides.otpSendConcurrency }),
    ...(overrides.otpDeliveryTimeoutMs === undefined
      ? {}
      : { otpDeliveryTimeoutMs: overrides.otpDeliveryTimeoutMs }),
  });
  await db.query(`
    CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
    CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
    CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
  `);
  return { auth, db, mailer, telegram };
}

function sentCode(mailer: { sendOtp: ReturnType<typeof vi.fn> }): string {
  const call = mailer.sendOtp.mock.calls.at(-1) as [string, string] | undefined;
  if (call === undefined) throw new Error('no OTP was sent');
  return call[1];
}

describe('MediaAuthService', () => {
  it('prunes expired IP buckets and never exceeds its configured cap', () => {
    const buckets = new BoundedOtpRateLimitMap(2);
    buckets.consume('old-a', 3, 0);
    buckets.consume('old-b', 3, 0);

    expect(buckets.consume('new', 3, 11 * 60_000)).toBe(true);
    expect(buckets.size).toBe(1);
    buckets.consume('active-b', 3, 11 * 60_000);
    buckets.consume('active-c', 3, 11 * 60_000);
    expect(buckets.size).toBe(2);
  });

  it('sends and verifies an OTP for an allow-listed gmail, then authenticates the session', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });

    await auth.requestOtp('user@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    expect(mailer.sendOtp).toHaveBeenCalledTimes(1);
    const code = sentCode(mailer);

    const token = await auth.verifyOtp('user@example.com', 'gmail', code);
    expect(token.length).toBeGreaterThan(20);

    const request = { headers: { authorization: `Bearer ${token}` } } as never;
    await expect(auth.authenticate(request)).resolves.toEqual({ id: 'user@example.com' });
  });

  it('does not deliver a code for a contact that is not on the allow-list (no enumeration)', async () => {
    const { auth, mailer } = await service();
    const result = await auth.requestOtp('stranger@example.com', 'gmail');
    expect(result.message).toMatch(/registered/i);
    expect(mailer.sendOtp).not.toHaveBeenCalled();
  });

  it('keeps registered and unknown request timing uniform despite slow database and mailer work', async () => {
    let releaseMail!: () => void;
    const slowMailer = {
      sendOtp: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseMail = resolve;
          }),
      ),
    };
    const { auth, db } = await service({ mailer: slowMailer });
    await auth.addAllowed({ gmail: 'known@example.com', addedBy: 'admin' });
    const originalQuery = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (...args: Parameters<Pool['query']>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return originalQuery(...args);
    });
    const startedRegistered = Date.now();
    const registered = await auth.requestOtp('known@example.com', 'gmail');
    const registeredMs = Date.now() - startedRegistered;
    const startedUnknown = Date.now();
    const unknown = await auth.requestOtp('unknown@example.com', 'gmail');
    const unknownMs = Date.now() - startedUnknown;
    expect(registered).toEqual(unknown);
    expect(registered.message).toBe('If that account is registered, a login code was sent.');
    expect(Math.abs(registeredMs - unknownMs)).toBeLessThan(20);
    expect(registeredMs).toBeLessThan(100);
    expect(unknownMs).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(slowMailer.sendOtp).toHaveBeenCalledTimes(1);
    releaseMail();
    await auth.drainPendingOtpSends();
  });

  it('drains pending sends during shutdown and reports only the abandoned count on timeout', async () => {
    let releaseMail!: () => void;
    let markMailStarted!: () => void;
    const mailStarted = new Promise<void>((resolve) => {
      markMailStarted = resolve;
    });
    const slowMailer = {
      sendOtp: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseMail = resolve;
            markMailStarted();
          }),
      ),
    };
    const { auth } = await service({ mailer: slowMailer });
    await auth.addAllowed({ gmail: 'drain@example.com', addedBy: 'admin' });
    await auth.requestOtp('drain@example.com', 'gmail');
    await mailStarted;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await auth.drainPendingOtpSends(10);
    expect(slowMailer.sendOtp).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('JOY Media OTP sends abandoned during shutdown', {
      count: 1,
    });
    releaseMail();
    await auth.drainPendingOtpSends();
  });

  it('sends OTPs for different users without waiting for a slow delivery', async () => {
    let releaseFirst!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const mailer = {
      sendOtp: vi.fn(async (contact: string) => {
        if (contact === 'slow@example.com') await firstStarted;
        else markSecondStarted();
      }),
    };
    const { auth } = await service({ mailer });
    await auth.addAllowed({ gmail: 'slow@example.com', addedBy: 'admin' });
    await auth.addAllowed({ gmail: 'fast@example.com', addedBy: 'admin' });

    await auth.requestOtp('slow@example.com', 'gmail');
    await auth.requestOtp('fast@example.com', 'gmail');
    await Promise.race([
      secondStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('second send blocked')), 250),
      ),
    ]);
    expect(mailer.sendOtp).toHaveBeenCalledTimes(2);
    releaseFirst();
    await auth.drainPendingOtpSends();
  });

  it('keeps a timed-out send code valid when delivery eventually succeeds', async () => {
    let release!: () => void;
    let deliveredCode = '';
    const mailer = {
      sendOtp: vi.fn(async (_contact: string, code: string) => {
        deliveredCode = code;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }),
    };
    const { auth, db } = await service({ otpDeliveryTimeoutMs: 10, mailer });
    await auth.addAllowed({ gmail: 'slow@example.com', addedBy: 'admin' });
    await auth.requestOtp('slow@example.com', 'gmail');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = await db.query('SELECT id FROM media_otp_codes WHERE contact = $1', [
      'slow@example.com',
    ]);
    expect(rows.rows).toHaveLength(1);
    release();
    await auth.drainPendingOtpSends();
    await expect(auth.verifyOtp('slow@example.com', 'gmail', deliveredCode)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('holds OTP send concurrency slots until the underlying slow sends settle', async () => {
    let active = 0;
    let maximumActive = 0;
    const mailer = {
      sendOtp: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
      }),
    };
    const { auth } = await service({ otpSendConcurrency: 2, otpDeliveryTimeoutMs: 5, mailer });
    for (let i = 0; i < 6; i += 1) {
      const gmail = `slow-${i}@example.com`;
      await auth.addAllowed({ gmail, addedBy: 'admin' });
      await auth.requestOtp(gmail, 'gmail');
    }

    await auth.drainPendingOtpSends();

    expect(mailer.sendOtp).toHaveBeenCalledTimes(6);
    expect(maximumActive).toBe(2);
  });

  it('deletes the code only after a send that timed out later rejects', async () => {
    const mailer = {
      sendOtp: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('smtp failure');
      }),
    };
    const { auth, db } = await service({ otpDeliveryTimeoutMs: 5, mailer });
    await auth.addAllowed({ gmail: 'late-failure@example.com', addedBy: 'admin' });
    await auth.requestOtp('late-failure@example.com', 'gmail');
    await auth.drainPendingOtpSends();

    const rows = await db.query('SELECT id FROM media_otp_codes WHERE contact = $1', [
      'late-failure@example.com',
    ]);
    expect(rows.rows).toEqual([]);
  });

  it('deletes failed delivery rows by id so repeated failures leave no active OTPs', async () => {
    const failingMailer = {
      sendOtp: vi.fn(async () => {
        throw new Error('smtp failure');
      }),
    };
    const { auth, db } = await service({ mailer: failingMailer, accountRateLimitMax: 10 });
    const user = await auth.addAllowed({ gmail: 'failure@example.com', addedBy: 'admin' });
    const querySpy = vi.spyOn(db, 'query');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i += 1) {
      await auth.requestOtp('failure@example.com', 'gmail');
      await auth.drainPendingOtpSends();
    }
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM media_otp_codes WHERE contact = $1',
      [user.gmail],
    );
    expect(failingMailer.sendOtp).toHaveBeenCalledTimes(5);
    expect(rows.rows[0]?.count).toBe('0');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(user.gmail);
    const loggedHashes = warning.mock.calls.map(
      ([, details]) => (details as { contactHash: string }).contactHash,
    );
    expect(new Set(loggedHashes).size).toBe(1);
    expect(loggedHashes[0]).not.toBe(
      createHash('sha256')
        .update(user.gmail ?? '')
        .digest('hex')
        .slice(0, 12),
    );
    const deletes = querySpy.mock.calls.filter(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('DELETE FROM media_otp_codes WHERE id = $1'),
    );
    expect(deletes).toHaveLength(5);
    expect(
      deletes.every(([, values]) => Array.isArray(values) && (values as unknown[]).length === 1),
    ).toBe(true);
  });

  it('returns the generic response and removes the OTP when no mailer is configured', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { auth, db } = await service({ mailer: undefined });
    const user = await auth.addAllowed({ gmail: 'known@example.com', addedBy: 'admin' });
    const querySpy = vi.spyOn(db, 'query');

    const registered = await auth.requestOtp('known@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const unknown = await auth.requestOtp('unknown@example.com', 'gmail');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registered).toEqual(unknown);
    expect(registered.message).toBe('If that account is registered, a login code was sent.');
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM media_otp_codes WHERE contact = $1',
      [user.gmail],
    );
    expect(rows.rows[0]?.count).toBe('0');
    expect(
      querySpy.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO media_otp_codes'),
      ),
    ).toBe(false);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(user.gmail);
  });

  it('prunes expired account rate-limit keys and stays within the map cap', async () => {
    const { auth } = await service();
    const buckets = (auth as unknown as { accountOtpRateLimit: Map<string, number[]> })
      .accountOtpRateLimit;
    const oldTimestamp = Date.now() - 11 * 60_000;
    for (let i = 0; i < 10_000; i += 1) buckets.set(`gmail:old-${i}`, [oldTimestamp]);

    await auth.requestOtp('new@example.com', 'gmail');

    expect(buckets.size).toBe(1);
    expect(buckets.has('gmail:old-0')).toBe(false);
    expect(buckets.has('gmail:new@example.com')).toBe(true);
  });

  it('caps active account rate-limit keys by evicting the oldest key', async () => {
    const { auth } = await service();
    const buckets = (auth as unknown as { accountOtpRateLimit: Map<string, number[]> })
      .accountOtpRateLimit;
    const timestamp = Date.now();
    for (let i = 0; i < 10_000; i += 1) buckets.set(`gmail:active-${i}`, [timestamp]);

    await auth.requestOtp('new@example.com', 'gmail');

    expect(buckets.size).toBe(10_000);
    expect(buckets.has('gmail:active-0')).toBe(false);
    expect(buckets.has('gmail:new@example.com')).toBe(true);
  });

  it('serves a new IP when the request OTP IP limiter is full of active keys', () => {
    const buckets = new BoundedOtpRateLimitMap(10_000);
    const timestamp = Date.now();
    for (let i = 0; i < 10_000; i += 1) buckets.consume(`ip-${i}`, 3, timestamp);

    expect(buckets.consume('legitimate-ip', 3, timestamp)).toBe(true);
    expect(buckets.size).toBe(10_000);
  });

  it('serves a new account when the account request limiter is full of active keys', async () => {
    const { auth } = await service();
    const buckets = (auth as unknown as { accountOtpRateLimit: Map<string, number[]> })
      .accountOtpRateLimit;
    const timestamp = Date.now();
    for (let i = 0; i < 10_000; i += 1) buckets.set(`gmail:active-${i}`, [timestamp]);

    await expect(auth.requestOtp('legitimate@example.com', 'gmail')).resolves.toMatchObject({
      message: expect.any(String),
    });
    expect(buckets.size).toBe(10_000);
    expect(buckets.has('gmail:legitimate@example.com')).toBe(true);
  });

  it('rate limits normalized contacts even when they are unknown', async () => {
    const { auth } = await service({ accountRateLimitMax: 2 });
    await auth.requestOtp('Unknown@example.com', 'gmail');
    await auth.requestOtp(' unknown@example.com ', 'gmail');
    await expect(auth.requestOtp('UNKNOWN@example.com', 'gmail')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('rejects a wrong or already-used code', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.requestOtp('user@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);

    await expect(auth.verifyOtp('user@example.com', 'gmail', '000000')).rejects.toBeInstanceOf(
      MediaAuthError,
    );

    await auth.verifyOtp('user@example.com', 'gmail', code);
    await expect(auth.verifyOtp('user@example.com', 'gmail', code)).rejects.toMatchObject({
      code: 'INVALID_OR_EXPIRED_CODE',
    });
  });

  it('burns all active codes after five wrong guesses and blocks the correct code', async () => {
    const { auth, mailer, db } = await service();
    await auth.addAllowed({ gmail: 'guess@example.com', addedBy: 'admin' });
    await auth.requestOtp('guess@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(auth.verifyOtp('guess@example.com', 'gmail', '000000')).rejects.toMatchObject({
        code: 'INVALID_OR_EXPIRED_CODE',
      });
    }
    await expect(auth.verifyOtp('guess@example.com', 'gmail', '000000')).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
    });
    await expect(auth.verifyOtp('guess@example.com', 'gmail', code)).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
    });
    const rows = await db.query<{ used: boolean }>(
      'SELECT used FROM media_otp_codes WHERE contact = $1',
      ['guess@example.com'],
    );
    expect(rows.rows).toEqual([{ used: true }]);
  });

  it('evicts junk verify buckets at capacity so a legitimate correct code can log in', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'legitimate@example.com', addedBy: 'admin' });
    await auth.requestOtp('legitimate@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);
    for (let i = 0; i < 10_000; i += 1)
      await auth.verifyOtp(`junk-${i}@example.invalid`, 'gmail', '000000').catch(() => undefined);

    await expect(auth.verifyOtp('legitimate@example.com', 'gmail', code)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('preserves blocked verify entries while evicting junk buckets', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'legitimate@example.com', addedBy: 'admin' });
    await auth.requestOtp('legitimate@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const failures = (
      auth as unknown as {
        verifyFailures: Map<
          string,
          { timestamps: number[]; blockedUntil: number; inFlight: number }
        >;
      }
    ).verifyFailures;
    const now = Date.now();
    failures.set('gmail:blocked-victim@example.com', {
      timestamps: [now, now, now, now, now],
      blockedUntil: now + 60_000,
      inFlight: 0,
    });
    for (let i = 0; i < 9_999; i += 1)
      failures.set(`gmail:junk-${i}`, { timestamps: [now], blockedUntil: 0, inFlight: 0 });

    await auth.verifyOtp('legitimate@example.com', 'gmail', sentCode(mailer));

    expect(failures.get('gmail:blocked-victim@example.com')?.blockedUntil).toBeGreaterThan(now);
    await expect(
      auth.verifyOtp('blocked-victim@example.com', 'gmail', '000000'),
    ).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('does not evict verify entries with in-flight reservations', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'legitimate@example.com', addedBy: 'admin' });
    await auth.requestOtp('legitimate@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const failures = (
      auth as unknown as {
        verifyFailures: Map<
          string,
          { timestamps: number[]; blockedUntil: number; inFlight: number }
        >;
      }
    ).verifyFailures;
    const now = Date.now();
    failures.set('gmail:in-flight@example.com', { timestamps: [], blockedUntil: 0, inFlight: 1 });
    for (let i = 0; i < 9_999; i += 1)
      failures.set(`gmail:junk-${i}`, { timestamps: [now], blockedUntil: 0, inFlight: 0 });

    await auth.verifyOtp('legitimate@example.com', 'gmail', sentCode(mailer));

    expect(failures.get('gmail:in-flight@example.com')?.inFlight).toBe(1);
  });

  it('rejects a verify key only when every bucket is blocked or in flight', async () => {
    const { auth } = await service();
    const failures = (
      auth as unknown as {
        verifyFailures: Map<
          string,
          { timestamps: number[]; blockedUntil: number; inFlight: number }
        >;
      }
    ).verifyFailures;
    for (let i = 0; i < 10_000; i += 1)
      failures.set(`gmail:protected-${i}`, { timestamps: [], blockedUntil: 0, inFlight: 1 });

    await expect(auth.verifyOtp('new@example.com', 'gmail', '000000')).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
    });
    expect(failures.size).toBe(10_000);
  });

  it('returns the same verify error sequence for unknown contacts', async () => {
    const { auth } = await service();
    const sequences: string[][] = [];
    for (const contact of ['known-sequence@example.com', 'unknown-sequence@example.com']) {
      const errors: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await auth.verifyOtp(contact, 'gmail', '000000');
        } catch (error) {
          errors.push((error as MediaAuthError).code);
        }
      }
      sequences.push(errors);
    }
    expect(sequences[0]).toEqual([
      'INVALID_OR_EXPIRED_CODE',
      'INVALID_OR_EXPIRED_CODE',
      'INVALID_OR_EXPIRED_CODE',
      'INVALID_OR_EXPIRED_CODE',
      'TOO_MANY_ATTEMPTS',
    ]);
    expect(sequences[1]).toEqual(sequences[0]);
  });

  it('reserves verify attempts before database work so parallel guesses cannot bypass five strikes', async () => {
    const { auth, mailer, db } = await service();
    await auth.addAllowed({ gmail: 'parallel@example.com', addedBy: 'admin' });
    await auth.requestOtp('parallel@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);
    const originalQuery = db.query.bind(db);
    let codeChecks = 0;
    vi.spyOn(db, 'query').mockImplementation(async (...args: Parameters<Pool['query']>) => {
      const sql = String(args[0]);
      if (sql.includes('SELECT id FROM media_otp_codes')) codeChecks += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return originalQuery(...args);
    });

    const attempts = Array.from({ length: 24 }, (_, index) =>
      auth.verifyOtp('parallel@example.com', 'gmail', index === 23 ? code : '000000'),
    );
    const results = await Promise.allSettled(attempts);
    expect(codeChecks).toBeLessThanOrEqual(5);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results.at(-1)).toMatchObject({
      status: 'rejected',
      reason: { code: 'TOO_MANY_ATTEMPTS' },
    });
    const rows = await originalQuery<{ used: boolean }>(
      'SELECT used FROM media_otp_codes WHERE contact = $1',
      ['parallel@example.com'],
    );
    expect(rows.rows).toEqual([{ used: true }]);
  });

  it('reserves parallel verify attempts for unknown contacts before the allow-list query', async () => {
    const { auth, db } = await service();
    const originalQuery = db.query.bind(db);
    let lookups = 0;
    vi.spyOn(db, 'query').mockImplementation(async (...args: Parameters<Pool['query']>) => {
      if (String(args[0]).includes('FROM media_allowed_users WHERE gmail')) lookups += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return originalQuery(...args);
    });

    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () =>
        auth.verifyOtp('unknown-parallel@example.com', 'gmail', '000000'),
      ),
    );
    expect(lookups).toBeLessThanOrEqual(5);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(
      results
        .slice(5)
        .every(
          (result) => result.status === 'rejected' && result.reason.code === 'TOO_MANY_ATTEMPTS',
        ),
    ).toBe(true);
  });

  it('allows a correct code among the first five concurrent verify attempts', async () => {
    const { auth, mailer, db } = await service();
    await auth.addAllowed({ gmail: 'first-five@example.com', addedBy: 'admin' });
    await auth.requestOtp('first-five@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);
    const originalQuery = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (...args: Parameters<Pool['query']>) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return originalQuery(...args);
    });

    const results = await Promise.allSettled([
      auth.verifyOtp('first-five@example.com', 'gmail', '000000'),
      auth.verifyOtp('first-five@example.com', 'gmail', '000000'),
      auth.verifyOtp('first-five@example.com', 'gmail', '000000'),
      auth.verifyOtp('first-five@example.com', 'gmail', '000000'),
      auth.verifyOtp('first-five@example.com', 'gmail', code),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('releases a verify reservation after a database error', async () => {
    const { auth, mailer, db } = await service();
    await auth.addAllowed({ gmail: 'db-error@example.com', addedBy: 'admin' });
    await auth.requestOtp('db-error@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);
    const originalQuery = db.query.bind(db);
    let failedLookups = 0;
    vi.spyOn(db, 'query').mockImplementation(async (...args: Parameters<Pool['query']>) => {
      if (failedLookups < 5 && String(args[0]).includes('FROM media_allowed_users WHERE gmail')) {
        failedLookups += 1;
        throw new Error('synthetic database failure');
      }
      return originalQuery(...args);
    });

    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(auth.verifyOtp('db-error@example.com', 'gmail', code)).rejects.toThrow(
        'synthetic database failure',
      );
    await expect(auth.verifyOtp('db-error@example.com', 'gmail', code)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('rejects a disabled allow-listed user even for their own valid code', async () => {
    const { auth, mailer } = await service();
    const user = await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.setEnabled(user.id, false);
    await auth.requestOtp('user@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    expect(mailer.sendOtp).not.toHaveBeenCalled();
  });

  it('revokes existing sessions immediately when an allow-listed user is disabled or removed', async () => {
    const { auth, mailer, db } = await service();
    const user = await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.requestOtp('user@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const token = await auth.verifyOtp('user@example.com', 'gmail', sentCode(mailer));
    const request = { headers: { authorization: `Bearer ${token}` } } as never;

    await expect(auth.authenticate(request)).resolves.toEqual({ id: 'user@example.com' });
    await auth.setEnabled(user.id, false);
    await expect(auth.authenticate(request)).resolves.toBeUndefined();

    await auth.setEnabled(user.id, true);
    await expect(auth.authenticate(request)).resolves.toEqual({ id: 'user@example.com' });
    await auth.removeAllowed(user.id);
    await expect(auth.authenticate(request)).resolves.toBeUndefined();
    await db.end();
  });

  it('caps OTP requests per contact at 5 within the rate window and resets after verify', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    for (let i = 0; i < 5; i += 1) await auth.requestOtp('user@example.com', 'gmail');
    await expect(auth.requestOtp('user@example.com', 'gmail')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await auth.drainPendingOtpSends();
    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
    await auth.verifyOtp('user@example.com', 'gmail', sentCode(mailer));
    await expect(auth.requestOtp('user@example.com', 'gmail')).resolves.toMatchObject({
      message: expect.any(String),
    });
  });

  it('rejects more than 3 OTP requests from the same IP within 10 minutes', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    const request = { socket: { remoteAddress: '1.2.3.4' } } as never;
    await auth.requestOtp('user@example.com', 'gmail', request);
    await auth.requestOtp('user@example.com', 'gmail', request);
    await auth.requestOtp('user@example.com', 'gmail', request);
    await expect(auth.requestOtp('user@example.com', 'gmail', request)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await auth.drainPendingOtpSends();
    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
  });

  it('does not let an untrusted forwarded address bypass the OTP limit', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    const request = (forwardedFor: string) =>
      ({
        socket: { remoteAddress: '203.0.113.10' },
        headers: { 'x-forwarded-for': forwardedFor },
      }) as never;
    await auth.requestOtp('user@example.com', 'gmail', request('198.51.100.1'));
    await auth.requestOtp('user@example.com', 'gmail', request('198.51.100.2'));
    await auth.requestOtp('user@example.com', 'gmail', request('198.51.100.3'));
    await expect(
      auth.requestOtp('user@example.com', 'gmail', request('198.51.100.4')),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await auth.drainPendingOtpSends();
    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
  });

  it('delivers Telegram OTP by telegram_id and rejects gmail login for a Telegram-only user', async () => {
    const { auth, telegram, mailer } = await service();
    await auth.addAllowed({ telegramId: '123456', addedBy: 'admin' });
    await auth.requestOtp('123456', 'telegram');
    await auth.drainPendingOtpSends();
    expect(telegram.sendOtp).toHaveBeenCalledTimes(1);
    await auth.requestOtp('123456', 'gmail');
    expect(mailer.sendOtp).not.toHaveBeenCalled();
  });

  it('accepts Telegram username (with or without @) and delivers OTP to telegram_id', async () => {
    const { auth, telegram } = await service();
    await auth.addAllowed({
      telegramId: '987654321',
      telegramUsername: 'JoyUser',
      addedBy: 'admin',
    });

    await auth.requestOtp('joyuser', 'telegram');
    await auth.drainPendingOtpSends();
    expect(telegram.sendOtp).toHaveBeenCalledWith('987654321', expect.any(String));

    telegram.sendOtp.mockClear();
    await auth.requestOtp('@JoyUser', 'telegram');
    await auth.drainPendingOtpSends();
    expect(telegram.sendOtp).toHaveBeenCalledWith('987654321', expect.any(String));

    const code = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];
    const token = await auth.verifyOtp('joyuser', 'telegram', code);
    expect(token.length).toBeGreaterThan(20);

    // Username request + numeric-id verify (same canonical otp contact)
    telegram.sendOtp.mockClear();
    await auth.requestOtp('@joyuser', 'telegram');
    await auth.drainPendingOtpSends();
    const code2 = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];
    await expect(auth.verifyOtp('987654321', 'telegram', code2)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('keeps Telegram username and numeric-id verify failures in one canonical bucket', async () => {
    const { auth, telegram } = await service();
    await auth.addAllowed({
      telegramId: '987654321',
      telegramUsername: 'JoyUser',
      addedBy: 'admin',
    });
    await auth.requestOtp('@joyuser', 'telegram');
    await auth.drainPendingOtpSends();
    const code = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];

    for (let attempt = 0; attempt < 4; attempt += 1)
      await expect(auth.verifyOtp('@joyuser', 'telegram', '000000')).rejects.toMatchObject({
        code: 'INVALID_OR_EXPIRED_CODE',
      });
    await expect(auth.verifyOtp('987654321', 'telegram', '000000')).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
    });
    await expect(auth.verifyOtp('987654321', 'telegram', code)).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
    });
  });

  it('does not deliver for an unknown Telegram username', async () => {
    const { auth, telegram } = await service();
    await auth.addAllowed({ telegramId: '1', telegramUsername: 'realuser', addedBy: 'admin' });
    await auth.requestOtp('nobody', 'telegram');
    expect(telegram.sendOtp).not.toHaveBeenCalled();
  });

  it('removing an allow-list entry revokes future logins', async () => {
    const { auth, mailer } = await service();
    const user = await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.requestOtp('user@example.com', 'gmail');
    await auth.drainPendingOtpSends();
    const code = sentCode(mailer);
    await auth.removeAllowed(user.id);
    await expect(auth.verifyOtp('user@example.com', 'gmail', code)).rejects.toMatchObject({
      code: 'INVALID_OR_EXPIRED_CODE',
    });
  });
});
