import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import { MediaAuthError, MediaAuthService, type MediaAuthHashKey } from './media-auth.js';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

const HASH_KEYS: readonly MediaAuthHashKey[] = [
  { id: 'k2', secret: 'test-current-auth-hash-secret' },
  { id: 'k1', secret: 'test-previous-auth-hash-secret' },
];

async function service(
  overrides: Partial<{ pool: Pool; hashKeys: readonly MediaAuthHashKey[] }> = {},
) {
  const db = overrides.pool ?? pool();
  await installSchema(db);
  const auth = createAuth(db, overrides.hashKeys);
  const mailer = auth.mailer;
  const telegram = auth.telegram;
  void overrides;
  return { auth: auth.service, db, mailer, telegram };
}

function createAuth(db: Pool, hashKeys: readonly MediaAuthHashKey[] = HASH_KEYS) {
  const mailer = { sendOtp: vi.fn(async () => undefined) };
  const telegram = { sendOtp: vi.fn(async () => undefined) };
  const service = new MediaAuthService({ pool: db, mailer, telegram, hashKeys });
  return { service, mailer, telegram };
}

async function installSchema(db: Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
    CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, secret_id text, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
    CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, secret_id text, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
    CREATE TABLE IF NOT EXISTS media_otp_rate_limits (id bigserial primary key, key_hash text not null, secret_id text, created_at timestamptz not null);
  `);
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

  it('caps active codes at 3 per contact', async () => {
    const { auth, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    for (let i = 0; i < 5; i += 1) await auth.requestOtp('user@example.com', 'gmail');
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

  it('persists OTP throttles across auth service reconstruction', async () => {
    const db = pool();
    await installSchema(db);
    const first = createAuth(db);
    await first.service.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    const request = { socket: { remoteAddress: '5.6.7.8' } } as never;
    await first.service.requestOtp('user@example.com', 'gmail', request);
    await first.service.requestOtp('user@example.com', 'gmail', request);

    const restarted = createAuth(db);
    await restarted.service.requestOtp('user@example.com', 'gmail', request);
    await expect(
      restarted.service.requestOtp('user@example.com', 'gmail', request),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const rateRows = await db.query<{ key_hash: string; secret_id: string }>(
      'SELECT key_hash, secret_id FROM media_otp_rate_limits',
    );
    expect(rateRows.rows).toHaveLength(3);
    expect(rateRows.rows.every((row) => row.secret_id === 'k2')).toBe(true);
    expect(JSON.stringify(rateRows.rows)).not.toContain('5.6.7.8');
  });

  it('stores keyed OTP/session digests with key ids instead of raw codes or tokens', async () => {
    const { auth, db, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.requestOtp('user@example.com', 'gmail');
    const code = sentCode(mailer);
    const otpRows = await db.query<{ code_hash: string; secret_id: string }>(
      'SELECT code_hash, secret_id FROM media_otp_codes',
    );
    expect(otpRows.rows).toHaveLength(1);
    expect(otpRows.rows[0]).toMatchObject({ secret_id: 'k2' });
    expect(otpRows.rows[0]?.code_hash).not.toBe(code);
    expect(otpRows.rows[0]?.code_hash).not.toBe(legacyCodeHash('user@example.com', 'gmail', code));

    const token = await auth.verifyOtp('user@example.com', 'gmail', code);
    const sessionRows = await db.query<{ token_hash: string; secret_id: string }>(
      'SELECT token_hash, secret_id FROM media_sessions',
    );
    expect(sessionRows.rows).toHaveLength(1);
    expect(sessionRows.rows[0]).toMatchObject({ secret_id: 'k2' });
    expect(sessionRows.rows[0]?.token_hash).not.toBe(token);
    expect(sessionRows.rows[0]?.token_hash).not.toBe(legacySessionHash(token));
  });

  it('accepts previous-key OTP/session rows during rotation and migrates sessions to the current key', async () => {
    const db = pool();
    await installSchema(db);
    const previousOnly = createAuth(db, [HASH_KEYS[1]!]);
    await previousOnly.service.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await previousOnly.service.requestOtp('user@example.com', 'gmail');
    const code = sentCode(previousOnly.mailer);

    const rotated = createAuth(db, HASH_KEYS);
    const token = await rotated.service.verifyOtp('user@example.com', 'gmail', code);
    await expect(
      rotated.service.authenticate({ headers: { authorization: `Bearer ${token}` } } as never),
    ).resolves.toEqual({ id: 'user@example.com' });

    const rows = await db.query<{ secret_id: string }>('SELECT secret_id FROM media_sessions');
    expect(rows.rows[0]?.secret_id).toBe('k2');
  });

  it('migrates legacy unkeyed sessions on successful authentication', async () => {
    const { auth, db } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    const token = 'legacy-token-with-enough-entropy-for-test';
    await db.query(
      `INSERT INTO media_sessions (token_hash, contact, method, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        legacySessionHash(token),
        'user@example.com',
        'gmail',
        new Date(),
        new Date(Date.now() + 60_000),
      ],
    );

    await expect(
      auth.authenticate({ headers: { authorization: `Bearer ${token}` } } as never),
    ).resolves.toEqual({ id: 'user@example.com' });
    const rows = await db.query<{ token_hash: string; secret_id: string }>(
      'SELECT token_hash, secret_id FROM media_sessions',
    );
    expect(rows.rows[0]?.secret_id).toBe('k2');
    expect(rows.rows[0]?.token_hash).not.toBe(legacySessionHash(token));
  });

  it('does not authenticate expired or revoked sessions', async () => {
    const { auth, db, mailer } = await service();
    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
    await auth.requestOtp('user@example.com', 'gmail');
    const token = await auth.verifyOtp('user@example.com', 'gmail', sentCode(mailer));
    const request = { headers: { authorization: `Bearer ${token}` } } as never;
    await expect(auth.authenticate(request)).resolves.toEqual({ id: 'user@example.com' });

    await auth.logout(token);
    await expect(auth.authenticate(request)).resolves.toBeUndefined();

    await db.query('UPDATE media_sessions SET revoked_at = NULL, expires_at = $1', [
      new Date(Date.now() - 1_000),
    ]);
    await expect(auth.authenticate(request)).resolves.toBeUndefined();
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

function legacyCodeHash(contact: string, method: string, code: string): string {
  return createHash('sha256').update(`${method}:${contact}:${code}`).digest('base64url');
}

function legacySessionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
