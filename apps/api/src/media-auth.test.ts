import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import { MediaAuthError, MediaAuthService } from './media-auth.js';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function service(overrides: Partial<{ mailerCode: string }> = {}) {
  const db = pool();
  const mailer = { sendOtp: vi.fn(async () => undefined) };
  const telegram = { sendOtp: vi.fn(async () => undefined) };
  const auth = new MediaAuthService({ pool: db, mailer, telegram });
  await db.query(`
    CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
    CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
    CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
  `);
  void overrides;
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
    await expect(auth.verifyOtp('987654321', 'telegram', code2)).resolves.toEqual(expect.any(String));
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
