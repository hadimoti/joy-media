import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import type { Actor } from './control-plane.js';
import type { MediaMailerLike } from './media-mailer.js';
import type { MediaTelegramSenderLike } from './media-telegram.js';

export type MediaAuthMethod = 'gmail' | 'telegram';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ACTIVE = 3;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const OTP_RATE_LIMIT_WINDOW_MS = 10 * 60_000; // 10 minutes
const OTP_RATE_LIMIT_MAX = 3; // max 3 OTP requests per window per IP
const CONTACT_MAX_LENGTH = 320;
const HASH_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Generic response text for both known and unknown contacts (no enumeration). */
const OTP_REQUESTED_MESSAGE = 'If that account is registered, a login code was sent.';

interface AllowedUserRow {
  readonly id: string;
  readonly gmail: string | null;
  readonly telegram_id: string | null;
  readonly telegram_username: string | null;
  readonly added_by: string;
  readonly added_at: Date;
  readonly enabled: boolean;
}

export interface MediaAllowedUser {
  readonly id: string;
  readonly gmail: string | null;
  readonly telegramId: string | null;
  readonly telegramUsername: string | null;
  readonly addedBy: string;
  readonly addedAt: number;
  readonly enabled: boolean;
}

export class MediaAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MediaAuthError';
  }
}

export interface MediaAuthServiceOptions {
  readonly pool: Pool;
  readonly mailer?: MediaMailerLike;
  readonly telegram?: MediaTelegramSenderLike;
  /**
   * Rotation-aware HMAC keys. The first key signs new OTP/session rows; later
   * keys are accepted for migration until their rows expire or are revoked.
   */
  readonly hashKeys?: readonly MediaAuthHashKey[];
}

export interface MediaAuthHashKey {
  readonly id: string;
  readonly secret: string;
}

export function mediaAuthHashKeysFromEnv(
  value = process.env.JOY_MEDIA_AUTH_HASH_KEYS,
): readonly MediaAuthHashKey[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new MediaAuthError('REQUEST_INVALID', 'JOY_MEDIA_AUTH_HASH_KEYS is invalid');
    }
    return {
      id: entry.slice(0, separator),
      secret: entry.slice(separator + 1),
    };
  });
}

export function requireMediaAuthHashKeysFromEnv(
  value = process.env.JOY_MEDIA_AUTH_HASH_KEYS,
): readonly MediaAuthHashKey[] {
  const keys = mediaAuthHashKeysFromEnv(value);
  if (keys === undefined) {
    throw new MediaAuthError(
      'AUTH_HASH_KEYS_REQUIRED',
      'JOY_MEDIA_AUTH_HASH_KEYS is required when durable media auth is enabled',
    );
  }
  return keys;
}

export function mediaAuthHashKeysForDatabase(
  databaseUrl = process.env.JOY_MEDIA_DATABASE_URL,
  value = process.env.JOY_MEDIA_AUTH_HASH_KEYS,
): readonly MediaAuthHashKey[] | undefined {
  return databaseUrl === undefined ? undefined : requireMediaAuthHashKeysFromEnv(value);
}

export interface MediaSessionProfile {
  readonly contact: string;
  readonly method: MediaAuthMethod;
  /** Human label: @username or gmail — never a bare telegram numeric id when username exists. */
  readonly displayName: string;
  readonly avatarAvailable: boolean;
}

/** The subset of MediaAuthService that http-server.ts depends on (injectable, like ApiAuthentication). */
export interface MediaAuthApi {
  requestOtp(
    contact: string,
    method: MediaAuthMethod,
    request?: IncomingMessage,
  ): Promise<{ readonly message: string }>;
  verifyOtp(contact: string, method: MediaAuthMethod, code: string): Promise<string>;
  logout(token: string): Promise<void>;
  authenticate(request: IncomingMessage): Promise<Actor | undefined>;
  sessionProfile(request: IncomingMessage): Promise<MediaSessionProfile | undefined>;
  avatarBytes(
    request: IncomingMessage,
  ): Promise<{ readonly mimeType: string; readonly bytes: Buffer } | undefined>;
}

/**
 * Independent allow-list + OTP login for JOY Media (ADR-0017). Owns its own
 * Postgres tables (media_allowed_users, media_otp_codes, media_sessions) —
 * no dependency on JOY's accounts service at runtime.
 */
export class MediaAuthService implements MediaAuthApi {
  private readonly pool: Pool;
  private readonly mailer: MediaMailerLike | undefined;
  private readonly telegram: MediaTelegramSenderLike | undefined;
  private readonly hashKeys: readonly MediaAuthHashKey[];

  constructor(options: MediaAuthServiceOptions) {
    this.pool = options.pool;
    this.mailer = options.mailer;
    this.telegram = options.telegram;
    this.hashKeys = normalizeHashKeys(options.hashKeys);
  }

  async listAllowed(): Promise<readonly MediaAllowedUser[]> {
    const result = await this.pool.query<AllowedUserRow>(
      'SELECT * FROM media_allowed_users ORDER BY added_at DESC',
    );
    return result.rows.map(allowedUserOf);
  }

  async addAllowed(input: {
    readonly gmail?: string;
    readonly telegramId?: string;
    readonly telegramUsername?: string;
    readonly addedBy: string;
  }): Promise<MediaAllowedUser> {
    const gmail = normalizeGmail(input.gmail);
    const telegramId = normalizeTelegramId(input.telegramId);
    if (gmail === undefined && telegramId === undefined) {
      throw new MediaAuthError('REQUEST_INVALID', 'gmail or telegramId is required');
    }
    const result = await this.pool.query<AllowedUserRow>(
      `INSERT INTO media_allowed_users (gmail, telegram_id, telegram_username, added_by, added_at, enabled)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [
        gmail ?? null,
        telegramId ?? null,
        input.telegramUsername?.trim().replace(/^@+/, '').toLowerCase() || null,
        input.addedBy,
        new Date(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new MediaAuthError('ALLOWED_USER_CREATE_FAILED', 'insert failed');
    return allowedUserOf(row);
  }

  async removeAllowed(id: string): Promise<void> {
    await this.pool.query('DELETE FROM media_allowed_users WHERE id = $1', [id]);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query('UPDATE media_allowed_users SET enabled = $2 WHERE id = $1', [
      id,
      enabled,
    ]);
  }

  /** Always returns the same generic message regardless of allow-list membership. */
  async requestOtp(
    rawContact: string,
    method: MediaAuthMethod,
    request?: IncomingMessage,
  ): Promise<{ message: string }> {
    if (request !== undefined) {
      await this.checkOtpRateLimit(requestIp(request));
    }
    const contact = normalizeContact(rawContact, method);
    const allowed = await this.findAllowed(contact, method);
    if (allowed !== undefined && allowed.enabled) {
      const otpContact = canonicalOtpContact(contact, method, allowed);
      const active = await this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM media_otp_codes
         WHERE contact = $1 AND method = $2 AND used = false AND expires_at > $3`,
        [otpContact, method, new Date()],
      );
      if (Number(active.rows[0]?.count ?? '0') < OTP_MAX_ACTIVE) {
        const code = randomInt(100_000, 1_000_000).toString();
        const now = new Date();
        await this.pool.query(
          `INSERT INTO media_otp_codes (contact, method, code_hash, secret_id, created_at, expires_at, used)
           VALUES ($1, $2, $3, $4, $5, $6, false)`,
          [
            otpContact,
            method,
            this.codeHash(otpContact, method, code, this.currentKey()),
            this.currentKey().id,
            now,
            new Date(now.getTime() + OTP_TTL_MS),
          ],
        );
        await this.deliver(allowed, method, code);
      }
    }
    return { message: OTP_REQUESTED_MESSAGE };
  }

  async verifyOtp(rawContact: string, method: MediaAuthMethod, code: string): Promise<string> {
    const contact = normalizeContact(rawContact, method);
    const allowed = await this.findAllowed(contact, method);
    if (allowed === undefined || !allowed.enabled) {
      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
    }
    const otpContact = canonicalOtpContact(contact, method, allowed);
    if (!/^\d{6}$/.test(code))
      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
    const codeRow = await this.matchActiveOtp(otpContact, method, code);
    if (codeRow === undefined)
      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
    const result = await this.pool.query<{ id: string }>(
      `UPDATE media_otp_codes SET used = true, code_hash = $3, secret_id = $4
       WHERE id = $1 AND used = false AND expires_at > $2
       RETURNING id`,
      [
        codeRow.id,
        new Date(),
        this.codeHash(otpContact, method, code, this.currentKey()),
        this.currentKey().id,
      ],
    );
    if (result.rows.length === 0)
      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.pool.query(
      `INSERT INTO media_sessions (token_hash, secret_id, contact, method, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        this.sessionHash(token, this.currentKey()),
        this.currentKey().id,
        otpContact,
        method,
        now,
        new Date(now.getTime() + SESSION_TTL_MS),
      ],
    );
    return token;
  }

  async logout(token: string): Promise<void> {
    const now = new Date();
    for (const hash of this.sessionHashCandidates(token)) {
      await this.pool.query('UPDATE media_sessions SET revoked_at = $2 WHERE token_hash = $1', [
        hash,
        now,
      ]);
    }
  }

  /** Satisfies the existing `ApiAuthentication` interface (see http-server.ts). */
  authenticate = async (request: IncomingMessage): Promise<Actor | undefined> => {
    const row = await this.sessionRow(request);
    return row === undefined ? undefined : { id: row.contact };
  };

  async sessionProfile(request: IncomingMessage): Promise<MediaSessionProfile | undefined> {
    const row = await this.sessionRow(request);
    if (row === undefined) return undefined;
    const allowed = await this.findAllowed(row.contact, row.method);
    const displayName = displayNameFor(row.contact, row.method, allowed);
    return {
      contact: row.contact,
      method: row.method,
      displayName,
      avatarAvailable: false,
    };
  }

  async avatarBytes(
    request: IncomingMessage,
  ): Promise<{ readonly mimeType: string; readonly bytes: Buffer } | undefined> {
    const row = await this.sessionRow(request);
    if (row === undefined) return undefined;
    if (row.method === 'telegram') {
      const fetchPhoto = this.telegram?.fetchProfilePhoto;
      if (fetchPhoto === undefined) return undefined;
      const bytes = await fetchPhoto(row.contact);
      return bytes === undefined ? undefined : { mimeType: 'image/jpeg', bytes };
    }
    return undefined;
  }

  private async sessionRow(
    request: IncomingMessage,
  ): Promise<{ readonly contact: string; readonly method: MediaAuthMethod } | undefined> {
    const token = bearerToken(request);
    if (token === undefined) return undefined;
    const row = await this.matchSession(token);
    if (row === undefined) return undefined;
    if (row.method !== 'gmail' && row.method !== 'telegram') return undefined;
    return { contact: row.contact, method: row.method };
  }

  private async findAllowed(
    contact: string,
    method: MediaAuthMethod,
  ): Promise<MediaAllowedUser | undefined> {
    if (method === 'gmail') {
      const result = await this.pool.query<AllowedUserRow>(
        `SELECT * FROM media_allowed_users WHERE gmail = $1 LIMIT 1`,
        [contact],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : allowedUserOf(row);
    }

    // Numeric Telegram user id, or username (with or without leading @).
    // OTP is always delivered to telegram_id via the Bot API.
    if (isTelegramNumericId(contact)) {
      const result = await this.pool.query<AllowedUserRow>(
        `SELECT * FROM media_allowed_users WHERE telegram_id = $1 LIMIT 1`,
        [contact],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : allowedUserOf(row);
    }

    const result = await this.pool.query<AllowedUserRow>(
      `SELECT * FROM media_allowed_users
       WHERE telegram_username IS NOT NULL AND LOWER(telegram_username) = $1
       LIMIT 1`,
      [contact],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : allowedUserOf(row);
  }

  private async deliver(
    allowed: MediaAllowedUser,
    method: MediaAuthMethod,
    code: string,
  ): Promise<void> {
    if (method === 'gmail' && allowed.gmail !== null && this.mailer !== undefined) {
      await this.mailer.sendOtp(allowed.gmail, code);
    } else if (
      method === 'telegram' &&
      allowed.telegramId !== null &&
      this.telegram !== undefined
    ) {
      await this.telegram.sendOtp(allowed.telegramId, code);
    }
  }

  private async checkOtpRateLimit(key: string): Promise<void> {
    const now = new Date();
    const keyHash = this.rateLimitHash(key);
    const windowStart = rateLimitWindowStart(now);
    await this.pool.query(
      `DELETE FROM media_otp_rate_limits
       WHERE window_start < $1
          OR (window_start IS NULL AND created_at <= $2)`,
      [windowStart, new Date(now.getTime() - OTP_RATE_LIMIT_WINDOW_MS)],
    );
    const legacyActive = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM media_otp_rate_limits
       WHERE key_hash = $1 AND window_start IS NULL AND created_at > $2`,
      [keyHash, new Date(now.getTime() - OTP_RATE_LIMIT_WINDOW_MS)],
    );
    const initialRequestCount = Math.min(
      Number(legacyActive.rows[0]?.count ?? '0') + 1,
      OTP_RATE_LIMIT_MAX + 1,
    );
    const updated = await this.pool.query<{ request_count: number }>(
      `INSERT INTO media_otp_rate_limits
         (key_hash, window_start, request_count, secret_id, created_at, updated_at)
       VALUES ($1, $2, $5, $3, $4, $4)
       ON CONFLICT (key_hash, window_start)
       DO UPDATE SET
         request_count = LEAST(media_otp_rate_limits.request_count + 1, $6 + 1),
         secret_id = EXCLUDED.secret_id,
         updated_at = EXCLUDED.updated_at
       RETURNING request_count`,
      [keyHash, windowStart, this.currentKey().id, now, initialRequestCount, OTP_RATE_LIMIT_MAX],
    );
    if ((updated.rows[0]?.request_count ?? 0) > OTP_RATE_LIMIT_MAX) {
      throw new MediaAuthError('RATE_LIMITED', 'Too many login requests. Try again later.');
    }
  }

  private async matchActiveOtp(
    contact: string,
    method: MediaAuthMethod,
    code: string,
  ): Promise<{ readonly id: string } | undefined> {
    const result = await this.pool.query<{
      readonly id: string;
      readonly code_hash: string;
      readonly secret_id: string | null;
    }>(
      `SELECT id, code_hash, secret_id FROM media_otp_codes
       WHERE contact = $1 AND method = $2 AND used = false AND expires_at > $3
       ORDER BY created_at DESC`,
      [contact, method, new Date()],
    );
    return result.rows.find((row) => {
      const key =
        row.secret_id === null
          ? undefined
          : this.hashKeys.find((candidate) => candidate.id === row.secret_id);
      const expected =
        key === undefined
          ? legacyCodeHash(contact, method, code)
          : this.codeHash(contact, method, code, key);
      return safeEqual(row.code_hash, expected);
    });
  }

  private async matchSession(token: string): Promise<
    | {
        readonly id: string;
        readonly token_hash: string;
        readonly secret_id: string | null;
        readonly contact: string;
        readonly method: string;
      }
    | undefined
  > {
    for (const hash of this.sessionHashCandidates(token)) {
      const result = await this.pool.query<{
        readonly id: string;
        readonly token_hash: string;
        readonly secret_id: string | null;
        readonly contact: string;
        readonly method: string;
      }>(
        `SELECT id, token_hash, secret_id, contact, method FROM media_sessions
         WHERE token_hash = $1 AND expires_at > $2 AND revoked_at IS NULL
         LIMIT 1`,
        [hash, new Date()],
      );
      const row = result.rows[0];
      if (row === undefined) continue;
      const currentHash = this.sessionHash(token, this.currentKey());
      if (row.secret_id !== this.currentKey().id || row.token_hash !== currentHash) {
        await this.pool.query(
          'UPDATE media_sessions SET token_hash = $2, secret_id = $3 WHERE id = $1',
          [row.id, currentHash, this.currentKey().id],
        );
      }
      return row;
    }
    return undefined;
  }

  private codeHash(
    contact: string,
    method: MediaAuthMethod,
    code: string,
    key: MediaAuthHashKey,
  ): string {
    return hmacDigest(key.secret, `otp:${method}:${contact}:${code}`);
  }

  private sessionHash(token: string, key: MediaAuthHashKey): string {
    return hmacDigest(key.secret, `session:${token}`);
  }

  private rateLimitHash(key: string): string {
    return hmacDigest(this.currentKey().secret, `otp-rate:${key}`);
  }

  private sessionHashCandidates(token: string): readonly string[] {
    return [...this.hashKeys.map((key) => this.sessionHash(token, key)), legacySessionHash(token)];
  }

  private currentKey(): MediaAuthHashKey {
    return this.hashKeys[0]!;
  }
}

/** Used when JOY_MEDIA_DATABASE_URL is unset — /v1/auth stays disabled, same spirit as LocalControlPlane. */
export class DisabledMediaAuth implements MediaAuthApi {
  async requestOtp(): Promise<{ readonly message: string }> {
    return { message: OTP_REQUESTED_MESSAGE };
  }
  async verifyOtp(): Promise<string> {
    throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
  }
  async logout(): Promise<void> {}
  async authenticate(): Promise<Actor | undefined> {
    return undefined;
  }
  async sessionProfile(): Promise<MediaSessionProfile | undefined> {
    return undefined;
  }
  async avatarBytes(): Promise<{ readonly mimeType: string; readonly bytes: Buffer } | undefined> {
    return undefined;
  }
}

function displayNameFor(
  contact: string,
  method: MediaAuthMethod,
  allowed: MediaAllowedUser | undefined,
): string {
  if (method === 'gmail') {
    return allowed?.gmail ?? contact;
  }
  const username = allowed?.telegramUsername?.replace(/^@+/, '').trim();
  if (username !== undefined && username.length > 0) return `@${username}`;
  return 'Telegram account';
}

function allowedUserOf(row: AllowedUserRow): MediaAllowedUser {
  return {
    id: row.id,
    gmail: row.gmail,
    telegramId: row.telegram_id,
    telegramUsername: row.telegram_username,
    addedBy: row.added_by,
    addedAt: row.added_at.getTime(),
    enabled: row.enabled,
  };
}

function normalizeGmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizeTelegramId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isTelegramNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Strip optional @; lowercase usernames; keep numeric ids as-is. */
function normalizeContact(value: string, method: MediaAuthMethod): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new MediaAuthError('REQUEST_INVALID', 'contact is required');
  if (trimmed.length > CONTACT_MAX_LENGTH)
    throw new MediaAuthError('REQUEST_INVALID', 'contact is too long');
  if (method === 'gmail') return trimmed.toLowerCase();
  const withoutAt = trimmed.replace(/^@+/, '');
  if (withoutAt.length === 0) throw new MediaAuthError('REQUEST_INVALID', 'contact is required');
  return isTelegramNumericId(withoutAt) ? withoutAt : withoutAt.toLowerCase();
}

/** Key OTP/session rows by stable telegram_id when available (username or id login). */
function canonicalOtpContact(
  contact: string,
  method: MediaAuthMethod,
  allowed: MediaAllowedUser,
): string {
  if (method === 'telegram' && allowed.telegramId !== null && allowed.telegramId.length > 0) {
    return allowed.telegramId;
  }
  return contact;
}

function legacyCodeHash(contact: string, method: MediaAuthMethod, code: string): string {
  return createHash('sha256').update(`${method}:${contact}:${code}`).digest('base64url');
}

function legacySessionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function hmacDigest(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function rateLimitWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / OTP_RATE_LIMIT_WINDOW_MS) * OTP_RATE_LIMIT_WINDOW_MS);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeHashKeys(
  keys: readonly MediaAuthHashKey[] | undefined,
): readonly MediaAuthHashKey[] {
  if (keys === undefined || keys.length === 0) {
    throw new MediaAuthError('AUTH_HASH_KEYS_REQUIRED', 'media auth hash keys are required');
  }
  const seen = new Set<string>();
  return keys.map((key) => {
    const id = key.id.trim();
    const secret = key.secret.trim();
    if (!HASH_KEY_ID.test(id) || secret.length < 16 || seen.has(id)) {
      throw new MediaAuthError('REQUEST_INVALID', 'auth hash keys are invalid');
    }
    seen.add(id);
    return { id, secret };
  });
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function requestIp(request: IncomingMessage): string {
  const headers = request.headers;
  if (headers === undefined || headers === null) return 'unknown';
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]!.trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}
