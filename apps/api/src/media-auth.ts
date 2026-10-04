import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import type { Actor } from './control-plane.js';
import { createClientAddressResolver, type ClientAddressResolver } from './client-address.js';
import type { MediaMailerLike } from './media-mailer.js';
import type { MediaTelegramSenderLike } from './media-telegram.js';

export type MediaAuthMethod = 'gmail' | 'telegram';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ACTIVE = 3;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const OTP_RATE_LIMIT_WINDOW_MS = 10 * 60_000; // 10 minutes
const OTP_RATE_LIMIT_MAX = 3; // max 3 OTP requests per window per IP
const OTP_ACCOUNT_RATE_LIMIT_MAX = 5;
const OTP_ACCOUNT_RATE_LIMIT_MAX_BUCKETS = 10_000;
const OTP_VERIFY_FAILURE_MAX = 5;
const OTP_CONTACT_LOG_HMAC_KEY = randomBytes(32);

export class BoundedOtpRateLimitMap {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly maxBuckets = OTP_ACCOUNT_RATE_LIMIT_MAX_BUCKETS) {}

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, limit: number, now = Date.now()): boolean {
    if (this.buckets.size >= this.maxBuckets) {
      for (const [bucketKey, timestamps] of this.buckets) {
        const recent = timestamps.filter((timestamp) => now - timestamp < OTP_RATE_LIMIT_WINDOW_MS);
        if (recent.length === 0) this.buckets.delete(bucketKey);
        else this.buckets.set(bucketKey, recent);
      }
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) this.buckets.delete(oldestKey);
    }
    const recent = (this.buckets.get(key) ?? []).filter(
      (timestamp) => now - timestamp < OTP_RATE_LIMIT_WINDOW_MS,
    );
    if (recent.length >= limit) return false;
    recent.push(now);
    this.buckets.set(key, recent);
    return true;
  }
}

const otpRateLimitWindow = new BoundedOtpRateLimitMap();

function checkOtpRateLimit(key: string): void {
  if (!otpRateLimitWindow.consume(key, OTP_RATE_LIMIT_MAX)) {
    throw new MediaAuthError('RATE_LIMITED', 'Too many login requests. Try again later.');
  }
}

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
  /** Shared trusted-proxy boundary for durable OTP abuse buckets. */
  readonly clientAddressResolver?: ClientAddressResolver;
  readonly accountRateLimitMax?: number;
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
  drainPendingOtpSends?(timeoutMs?: number): Promise<void>;
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
  private readonly clientAddressResolver: ClientAddressResolver;
  private readonly accountRateLimitMax: number;
  private readonly accountOtpRateLimit = new Map<string, number[]>();
  private readonly verifyFailures = new Map<
    string,
    { readonly timestamps: number[]; blockedUntil: number }
  >();
  private readonly pendingOtpSends = new Set<Promise<void>>();
  private otpRequestTail: Promise<void> = Promise.resolve();

  constructor(options: MediaAuthServiceOptions) {
    this.pool = options.pool;
    this.mailer = options.mailer;
    this.telegram = options.telegram;
    this.clientAddressResolver = options.clientAddressResolver ?? createClientAddressResolver();
    this.accountRateLimitMax = options.accountRateLimitMax ?? OTP_ACCOUNT_RATE_LIMIT_MAX;
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
    const contact = normalizeContact(rawContact, method);
    if (request !== undefined) checkOtpRateLimit(this.clientAddressResolver(request));
    checkAccountOtpRateLimit(
      this.accountOtpRateLimit,
      `${method}:${contact}`,
      this.accountRateLimitMax,
    );
    this.scheduleOtpSend(contact, method);
    return { message: OTP_REQUESTED_MESSAGE };
  }

  private scheduleOtpSend(contact: string, method: MediaAuthMethod): void {
    const previous = this.otpRequestTail;
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => previous)
      .then(() => this.deliverRequestedOtp(contact, method))
      .catch(() => warnOtpDeliveryFailure(contact))
      .finally(() => this.pendingOtpSends.delete(task));
    this.pendingOtpSends.add(task);
    this.otpRequestTail = task;
  }

  async drainPendingOtpSends(timeoutMs = 5_000): Promise<void> {
    if (this.pendingOtpSends.size === 0) return;
    const pending = [...this.pendingOtpSends];
    let timeout: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (!completed && this.pendingOtpSends.size > 0)
      console.warn('JOY Media OTP sends abandoned during shutdown', {
        count: this.pendingOtpSends.size,
      });
  }

  private async deliverRequestedOtp(contact: string, method: MediaAuthMethod): Promise<void> {
    const allowed = await this.findAllowed(contact, method);
    if (allowed !== undefined && allowed.enabled) {
      if (!this.hasDeliveryConfigured(allowed, method)) {
        warnOtpDeliveryFailure(contact);
        return;
      }
      const otpContact = canonicalOtpContact(contact, method, allowed);
      const active = await this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM media_otp_codes
         WHERE contact = $1 AND method = $2 AND used = false AND expires_at > $3`,
        [otpContact, method, new Date()],
      );
      if (Number(active.rows[0]?.count ?? '0') < OTP_MAX_ACTIVE) {
        const code = randomInt(100_000, 1_000_000).toString();
        const now = new Date();
        const inserted = await this.pool.query<{ id: string | number }>(
          `INSERT INTO media_otp_codes (contact, method, code_hash, created_at, expires_at, used)
           VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
          [
            otpContact,
            method,
            codeHash(otpContact, method, code),
            now,
            new Date(now.getTime() + OTP_TTL_MS),
          ],
        );
        const otpId = inserted.rows[0]?.id;
        if (otpId !== undefined) {
          await this.deliver(allowed, method, code).catch(async () => {
            try {
              await this.pool.query('DELETE FROM media_otp_codes WHERE id = $1', [otpId]);
            } catch {
              // The generic response is independent of mail and cleanup failures.
            }
            warnOtpDeliveryFailure(contact);
          });
        }
      }
    }
  }

  async verifyOtp(rawContact: string, method: MediaAuthMethod, code: string): Promise<string> {
    const contact = normalizeContact(rawContact, method);
    const allowed = await this.findAllowed(contact, method);
    const otpContact = allowed ? canonicalOtpContact(contact, method, allowed) : contact;
    const failureKey = `${method}:${otpContact}`;
    if (this.isVerifyBlocked(failureKey)) throw tooManyVerifyAttemptsError();
    if (allowed === undefined || !allowed.enabled) {
      await this.recordVerifyFailure(failureKey, otpContact, method);
      throw this.isVerifyBlocked(failureKey) ? tooManyVerifyAttemptsError() : invalidOtpError();
    }
    const hash = codeHash(otpContact, method, code);
    const result = await this.pool.query<{ id: string }>(
      `UPDATE media_otp_codes SET used = true
       WHERE id = (
         SELECT id FROM media_otp_codes
         WHERE contact = $1 AND method = $2 AND code_hash = $3 AND used = false AND expires_at > $4
         ORDER BY created_at DESC LIMIT 1
       )
       RETURNING id`,
      [otpContact, method, hash, new Date()],
    );
    if (result.rows.length === 0) {
      await this.recordVerifyFailure(failureKey, otpContact, method);
      throw this.isVerifyBlocked(failureKey) ? tooManyVerifyAttemptsError() : invalidOtpError();
    }
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.pool.query(
      `INSERT INTO media_sessions (token_hash, contact, method, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionHash(token), otpContact, method, now, new Date(now.getTime() + SESSION_TTL_MS)],
    );
    this.verifyFailures.delete(failureKey);
    this.accountOtpRateLimit.delete(failureKey);
    return token;
  }

  private isVerifyBlocked(key: string): boolean {
    const now = Date.now();
    const bucket = this.verifyFailures.get(key);
    if (!bucket) return false;
    if (bucket.blockedUntil > now) return true;
    if (bucket.blockedUntil > 0) {
      bucket.timestamps.length = 0;
      bucket.blockedUntil = 0;
      return false;
    }
    const recent = bucket.timestamps.filter(
      (timestamp) => now - timestamp < OTP_RATE_LIMIT_WINDOW_MS,
    );
    if (recent.length === 0) {
      this.verifyFailures.delete(key);
      return false;
    }
    bucket.timestamps.splice(0, bucket.timestamps.length, ...recent);
    bucket.blockedUntil = 0;
    return false;
  }

  private async recordVerifyFailure(
    key: string,
    contact: string,
    method: MediaAuthMethod,
  ): Promise<void> {
    const now = Date.now();
    if (
      this.verifyFailures.size >= OTP_ACCOUNT_RATE_LIMIT_MAX_BUCKETS &&
      !this.verifyFailures.has(key)
    ) {
      for (const [bucketKey, bucket] of this.verifyFailures) {
        if (bucket.timestamps.every((timestamp) => now - timestamp >= OTP_RATE_LIMIT_WINDOW_MS))
          this.verifyFailures.delete(bucketKey);
      }
      if (this.verifyFailures.size >= OTP_ACCOUNT_RATE_LIMIT_MAX_BUCKETS) {
        const oldestKey = this.verifyFailures.keys().next().value;
        if (oldestKey !== undefined) this.verifyFailures.delete(oldestKey);
      }
    }
    const bucket = this.verifyFailures.get(key) ?? { timestamps: [], blockedUntil: 0 };
    bucket.timestamps.push(now);
    if (bucket.timestamps.length >= OTP_VERIFY_FAILURE_MAX) {
      // Policy: five failures burn every live code and block verification for ten minutes.
      // A new OTP can be requested once that block window expires.
      bucket.blockedUntil = now + OTP_RATE_LIMIT_WINDOW_MS;
      await this.pool.query(
        `UPDATE media_otp_codes SET used = true WHERE contact = $1 AND method = $2 AND used = false`,
        [contact, method],
      );
    }
    this.verifyFailures.set(key, bucket);
  }

  async logout(token: string): Promise<void> {
    await this.pool.query('UPDATE media_sessions SET revoked_at = $2 WHERE token_hash = $1', [
      sessionHash(token),
      new Date(),
    ]);
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
    const result = await this.pool.query<{ contact: string; method: string }>(
      `SELECT s.contact, s.method FROM media_sessions s
       INNER JOIN media_allowed_users a ON (
         (s.method = 'gmail' AND a.gmail = s.contact) OR
         (s.method = 'telegram' AND a.telegram_id = s.contact)
       )
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
         AND a.enabled = true`,
      [sessionHash(token), new Date()],
    );
    const row = result.rows[0];
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
    } else if (method === 'gmail' && allowed.gmail !== null) {
      throw new Error('SMTP is not configured');
    } else if (
      method === 'telegram' &&
      allowed.telegramId !== null &&
      this.telegram !== undefined
    ) {
      await this.telegram.sendOtp(allowed.telegramId, code);
    } else if (method === 'telegram' && allowed.telegramId !== null) {
      throw new Error('Telegram delivery is not configured');
    }
  }

  private hasDeliveryConfigured(allowed: MediaAllowedUser, method: MediaAuthMethod): boolean {
    if (method === 'gmail') return allowed.gmail !== null && this.mailer !== undefined;
    return allowed.telegramId !== null && this.telegram !== undefined;
  }
}

function warnOtpDeliveryFailure(contact: string): void {
  const contactHash = createHmac('sha256', OTP_CONTACT_LOG_HMAC_KEY)
    .update(contact)
    .digest('hex')
    .slice(0, 12);
  console.warn('JOY Media OTP delivery failed', { contactHash });
}

function checkAccountOtpRateLimit(
  buckets: Map<string, number[]>,
  key: string,
  limit: number,
): void {
  const now = Date.now();
  if (buckets.size >= OTP_ACCOUNT_RATE_LIMIT_MAX_BUCKETS) {
    for (const [bucketKey, timestamps] of buckets) {
      const recentTimestamps = timestamps.filter(
        (timestamp) => now - timestamp < OTP_RATE_LIMIT_WINDOW_MS,
      );
      if (recentTimestamps.length === 0) buckets.delete(bucketKey);
      else buckets.set(bucketKey, recentTimestamps);
    }
  }
  const recent = (buckets.get(key) ?? []).filter(
    (timestamp) => now - timestamp < OTP_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= limit)
    throw new MediaAuthError('RATE_LIMITED', 'Too many login requests. Try again later.');
  if (!buckets.has(key) && buckets.size >= OTP_ACCOUNT_RATE_LIMIT_MAX_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }
  recent.push(now);
  buckets.set(key, recent);
}

function invalidOtpError(): MediaAuthError {
  return new MediaAuthError('INVALID_OR_EXPIRED_CODE', 'The login code is invalid or expired.');
}

function tooManyVerifyAttemptsError(): MediaAuthError {
  return new MediaAuthError(
    'TOO_MANY_ATTEMPTS',
    'Too many incorrect login codes. Request a new code later.',
  );
}

/** Used when JOY_MEDIA_DATABASE_URL is unset — /v1/auth stays disabled, same spirit as LocalControlPlane. */
export class DisabledMediaAuth implements MediaAuthApi {
  async requestOtp(): Promise<{ readonly message: string }> {
    return { message: OTP_REQUESTED_MESSAGE };
  }
  async verifyOtp(): Promise<string> {
    throw invalidOtpError();
  }
  async drainPendingOtpSends(): Promise<void> {}
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

function codeHash(contact: string, method: MediaAuthMethod, code: string): string {
  return createHash('sha256').update(`${method}:${contact}:${code}`).digest('base64url');
}

function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}
