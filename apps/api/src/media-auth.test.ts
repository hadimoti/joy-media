import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import { MediaAuthError, MediaAuthService } from './media-auth.js';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function service(
  overrides: {
    mailer?: { sendOtp: ReturnType<typeof vi.fn> } | undefined;
    accountRateLimitMax?: number;
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
  it('sends and verifies an OTP for an allow-listed gmail, then authenticates the session', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });

    await auth.requestOtp('user@example.com', 'gmail');
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

  it('returns the same fast response for registered and unknown addresses while mail delivery is slow', async () => {
    const slowMailer = {
      sendOtp: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            timer.unref();
          }),
      ),
    };
    const { auth } = await service({ mailer: slowMailer });
    await auth.addAllowed({ gmail: 'known@example.com', addedBy: 'admin' });
    const startedRegistered = Date.now();
    const registered = await auth.requestOtp('known@example.com', 'gmail');
    const registeredMs = Date.now() - startedRegistered;
    const startedUnknown = Date.now();
    const unknown = await auth.requestOtp('unknown@example.com', 'gmail');
    const unknownMs = Date.now() - startedUnknown;
    expect(registered).toEqual(unknown);
    expect(registered.message).toBe('If that account is registered, a login code was sent.');
    expect(registeredMs).toBeLessThan(200);
    expect(unknownMs).toBeLessThan(200);
    expect(slowMailer.sendOtp).toHaveBeenCalledTimes(1);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
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
    const code = sentCode(mailer);

    await expect(auth.verifyOtp('user@example.com', 'gmail', '000000')).rejects.toBeInstanceOf(
      MediaAuthError,
    );

    await auth.verifyOtp('user@example.com', 'gmail', code);
    await expect(auth.verifyOtp('user@example.com', 'gmail', code)).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
  });

  it('rejects a disabled allow-listed user even for their own valid code', async () => {
    const { auth, mailer } = await service();
    const user = await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.setEnabled(user.id, false);
    await auth.requestOtp('user@example.com', 'gmail');
    expect(mailer.sendOtp).not.toHaveBeenCalled();
  });

  it('revokes existing sessions immediately when an allow-listed user is disabled or removed', async () => {
    const { auth, mailer, db } = await service();
    const user = await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.requestOtp('user@example.com', 'gmail');
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

  it('caps OTP requests per contact at 3 within the rate window', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    for (let i = 0; i < 3; i += 1) await auth.requestOtp('user@example.com', 'gmail');
    await expect(auth.requestOtp('user@example.com', 'gmail')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
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
    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
  });

  it('delivers Telegram OTP by telegram_id and rejects gmail login for a Telegram-only user', async () => {
    const { auth, telegram, mailer } = await service();
    await auth.addAllowed({ telegramId: '123456', addedBy: 'admin' });
    await auth.requestOtp('123456', 'telegram');
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
    expect(telegram.sendOtp).toHaveBeenCalledWith('987654321', expect.any(String));

    telegram.sendOtp.mockClear();
    await auth.requestOtp('@JoyUser', 'telegram');
    expect(telegram.sendOtp).toHaveBeenCalledWith('987654321', expect.any(String));

    const code = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];
    const token = await auth.verifyOtp('joyuser', 'telegram', code);
    expect(token.length).toBeGreaterThan(20);

    // Username request + numeric-id verify (same canonical otp contact)
    telegram.sendOtp.mockClear();
    await auth.requestOtp('@joyuser', 'telegram');
    const code2 = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];
    await expect(auth.verifyOtp('987654321', 'telegram', code2)).resolves.toEqual(
      expect.any(String),
    );
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
    const code = sentCode(mailer);
    await auth.removeAllowed(user.id);
    await expect(auth.verifyOtp('user@example.com', 'gmail', code)).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
  });
});
