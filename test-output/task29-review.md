# Review package: b655ab1..43e531a

## Commits
43e531a fix(security): harden auth and gate unfinished transports

## Files changed
 apps/api/src/media-auth.test.ts         | 159 +++++++++++++++++--
 apps/api/src/media-auth.ts              | 272 ++++++++++++++++++++++++++------
 apps/api/src/postgres-schema.ts         |   8 +-
 apps/api/src/server.ts                  |   4 +-
 apps/editor-web/src/app-menu.test.ts    |  13 ++
 apps/editor-web/src/app-menu.ts         |   4 +-
 apps/editor-web/src/dock-layout.test.ts |  19 +++
 apps/editor-web/src/dock-layout.ts      |  21 +--
 apps/editor-web/src/plugin-host.test.ts |  39 +++--
 apps/editor-web/src/plugin-host.ts      |  27 +++-
 apps/editor-web/src/workspace.test.ts   |  11 +-
 apps/editor-web/src/workspace.ts        |  67 ++++----
 docs/product/FEATURE-STATUS.md          |  34 ++--
 docs/security/README.md                 |  55 ++++++-
 14 files changed, 581 insertions(+), 152 deletions(-)

## Diff
diff --git a/apps/api/src/media-auth.test.ts b/apps/api/src/media-auth.test.ts
index 2caa9d6..e0b93dd 100644
--- a/apps/api/src/media-auth.test.ts
+++ b/apps/api/src/media-auth.test.ts
@@ -1,33 +1,53 @@
+import { createHash } from 'node:crypto';
 import type { Pool } from 'pg';
 import { newDb } from 'pg-mem';
 import { describe, expect, it, vi } from 'vitest';
-import { MediaAuthError, MediaAuthService } from './media-auth.js';
+import { MediaAuthError, MediaAuthService, type MediaAuthHashKey } from './media-auth.js';
 
 function pool(): Pool {
   const database = newDb();
   const adapter = database.adapters.createPg();
   return new adapter.Pool() as Pool;
 }
 
-async function service(overrides: Partial<{ mailerCode: string }> = {}) {
-  const db = pool();
+const HASH_KEYS: readonly MediaAuthHashKey[] = [
+  { id: 'k2', secret: 'test-current-auth-hash-secret' },
+  { id: 'k1', secret: 'test-previous-auth-hash-secret' },
+];
+
+async function service(
+  overrides: Partial<{ pool: Pool; hashKeys: readonly MediaAuthHashKey[] }> = {},
+) {
+  const db = overrides.pool ?? pool();
+  await installSchema(db);
+  const auth = createAuth(db, overrides.hashKeys);
+  const mailer = auth.mailer;
+  const telegram = auth.telegram;
+  void overrides;
+  return { auth: auth.service, db, mailer, telegram };
+}
+
+function createAuth(db: Pool, hashKeys: readonly MediaAuthHashKey[] = HASH_KEYS) {
   const mailer = { sendOtp: vi.fn(async () => undefined) };
   const telegram = { sendOtp: vi.fn(async () => undefined) };
-  const auth = new MediaAuthService({ pool: db, mailer, telegram });
+  const service = new MediaAuthService({ pool: db, mailer, telegram, hashKeys });
+  return { service, mailer, telegram };
+}
+
+async function installSchema(db: Pool): Promise<void> {
   await db.query(`
     CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
-    CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
-    CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
+    CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, secret_id text, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
+    CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, secret_id text, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
+    CREATE TABLE IF NOT EXISTS media_otp_rate_limits (id bigserial primary key, key_hash text not null, secret_id text, created_at timestamptz not null);
   `);
-  void overrides;
-  return { auth, db, mailer, telegram };
 }
 
 function sentCode(mailer: { sendOtp: ReturnType<typeof vi.fn> }): string {
   const call = mailer.sendOtp.mock.calls.at(-1) as [string, string] | undefined;
   if (call === undefined) throw new Error('no OTP was sent');
   return call[1];
 }
 
 describe('MediaAuthService', () => {
   it('sends and verifies an OTP for an allow-listed gmail, then authenticates the session', async () => {
@@ -83,24 +103,131 @@ describe('MediaAuthService', () => {
     expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
   });
 
   it('rejects more than 3 OTP requests from the same IP within 10 minutes', async () => {
     const { auth, mailer } = await service();
     await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
     const request = { socket: { remoteAddress: '1.2.3.4' } } as never;
     await auth.requestOtp('user@example.com', 'gmail', request);
     await auth.requestOtp('user@example.com', 'gmail', request);
     await auth.requestOtp('user@example.com', 'gmail', request);
+    await expect(auth.requestOtp('user@example.com', 'gmail', request)).rejects.toMatchObject({
+      code: 'RATE_LIMITED',
+    });
+    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
+  });
+
+  it('persists OTP throttles across auth service reconstruction', async () => {
+    const db = pool();
+    await installSchema(db);
+    const first = createAuth(db);
+    await first.service.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
+    const request = { socket: { remoteAddress: '5.6.7.8' } } as never;
+    await first.service.requestOtp('user@example.com', 'gmail', request);
+    await first.service.requestOtp('user@example.com', 'gmail', request);
+
+    const restarted = createAuth(db);
+    await restarted.service.requestOtp('user@example.com', 'gmail', request);
     await expect(
-      auth.requestOtp('user@example.com', 'gmail', request),
+      restarted.service.requestOtp('user@example.com', 'gmail', request),
     ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
-    expect(mailer.sendOtp).toHaveBeenCalledTimes(3);
+
+    const rateRows = await db.query<{ key_hash: string; secret_id: string }>(
+      'SELECT key_hash, secret_id FROM media_otp_rate_limits',
+    );
+    expect(rateRows.rows).toHaveLength(3);
+    expect(rateRows.rows.every((row) => row.secret_id === 'k2')).toBe(true);
+    expect(JSON.stringify(rateRows.rows)).not.toContain('5.6.7.8');
+  });
+
+  it('stores keyed OTP/session digests with key ids instead of raw codes or tokens', async () => {
+    const { auth, db, mailer } = await service();
+    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
+    await auth.requestOtp('user@example.com', 'gmail');
+    const code = sentCode(mailer);
+    const otpRows = await db.query<{ code_hash: string; secret_id: string }>(
+      'SELECT code_hash, secret_id FROM media_otp_codes',
+    );
+    expect(otpRows.rows).toHaveLength(1);
+    expect(otpRows.rows[0]).toMatchObject({ secret_id: 'k2' });
+    expect(otpRows.rows[0]?.code_hash).not.toBe(code);
+    expect(otpRows.rows[0]?.code_hash).not.toBe(legacyCodeHash('user@example.com', 'gmail', code));
+
+    const token = await auth.verifyOtp('user@example.com', 'gmail', code);
+    const sessionRows = await db.query<{ token_hash: string; secret_id: string }>(
+      'SELECT token_hash, secret_id FROM media_sessions',
+    );
+    expect(sessionRows.rows).toHaveLength(1);
+    expect(sessionRows.rows[0]).toMatchObject({ secret_id: 'k2' });
+    expect(sessionRows.rows[0]?.token_hash).not.toBe(token);
+    expect(sessionRows.rows[0]?.token_hash).not.toBe(legacySessionHash(token));
+  });
+
+  it('accepts previous-key OTP/session rows during rotation and migrates sessions to the current key', async () => {
+    const db = pool();
+    await installSchema(db);
+    const previousOnly = createAuth(db, [HASH_KEYS[1]!]);
+    await previousOnly.service.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
+    await previousOnly.service.requestOtp('user@example.com', 'gmail');
+    const code = sentCode(previousOnly.mailer);
+
+    const rotated = createAuth(db, HASH_KEYS);
+    const token = await rotated.service.verifyOtp('user@example.com', 'gmail', code);
+    await expect(
+      rotated.service.authenticate({ headers: { authorization: `Bearer ${token}` } } as never),
+    ).resolves.toEqual({ id: 'user@example.com' });
+
+    const rows = await db.query<{ secret_id: string }>('SELECT secret_id FROM media_sessions');
+    expect(rows.rows[0]?.secret_id).toBe('k2');
+  });
+
+  it('migrates legacy unkeyed sessions on successful authentication', async () => {
+    const { auth, db } = await service();
+    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
+    const token = 'legacy-token-with-enough-entropy-for-test';
+    await db.query(
+      `INSERT INTO media_sessions (token_hash, contact, method, created_at, expires_at)
+       VALUES ($1, $2, $3, $4, $5)`,
+      [
+        legacySessionHash(token),
+        'user@example.com',
+        'gmail',
+        new Date(),
+        new Date(Date.now() + 60_000),
+      ],
+    );
+
+    await expect(
+      auth.authenticate({ headers: { authorization: `Bearer ${token}` } } as never),
+    ).resolves.toEqual({ id: 'user@example.com' });
+    const rows = await db.query<{ token_hash: string; secret_id: string }>(
+      'SELECT token_hash, secret_id FROM media_sessions',
+    );
+    expect(rows.rows[0]?.secret_id).toBe('k2');
+    expect(rows.rows[0]?.token_hash).not.toBe(legacySessionHash(token));
+  });
+
+  it('does not authenticate expired or revoked sessions', async () => {
+    const { auth, db, mailer } = await service();
+    await auth.addAllowed({ gmail: 'user@example.com', addedBy: 'admin' });
+    await auth.requestOtp('user@example.com', 'gmail');
+    const token = await auth.verifyOtp('user@example.com', 'gmail', sentCode(mailer));
+    const request = { headers: { authorization: `Bearer ${token}` } } as never;
+    await expect(auth.authenticate(request)).resolves.toEqual({ id: 'user@example.com' });
+
+    await auth.logout(token);
+    await expect(auth.authenticate(request)).resolves.toBeUndefined();
+
+    await db.query('UPDATE media_sessions SET revoked_at = NULL, expires_at = $1', [
+      new Date(Date.now() - 1_000),
+    ]);
+    await expect(auth.authenticate(request)).resolves.toBeUndefined();
   });
 
   it('delivers Telegram OTP by telegram_id and rejects gmail login for a Telegram-only user', async () => {
     const { auth, telegram, mailer } = await service();
     await auth.addAllowed({ telegramId: '123456', addedBy: 'admin' });
     await auth.requestOtp('123456', 'telegram');
     expect(telegram.sendOtp).toHaveBeenCalledTimes(1);
     await auth.requestOtp('123456', 'gmail');
     expect(mailer.sendOtp).not.toHaveBeenCalled();
   });
@@ -121,31 +248,41 @@ describe('MediaAuthService', () => {
     expect(telegram.sendOtp).toHaveBeenCalledWith('987654321', expect.any(String));
 
     const code = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];
     const token = await auth.verifyOtp('joyuser', 'telegram', code);
     expect(token.length).toBeGreaterThan(20);
 
     // Username request + numeric-id verify (same canonical otp contact)
     telegram.sendOtp.mockClear();
     await auth.requestOtp('@joyuser', 'telegram');
     const code2 = (telegram.sendOtp.mock.calls.at(-1) as unknown as [string, string])[1];
-    await expect(auth.verifyOtp('987654321', 'telegram', code2)).resolves.toEqual(expect.any(String));
+    await expect(auth.verifyOtp('987654321', 'telegram', code2)).resolves.toEqual(
+      expect.any(String),
+    );
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
+
+function legacyCodeHash(contact: string, method: string, code: string): string {
+  return createHash('sha256').update(`${method}:${contact}:${code}`).digest('base64url');
+}
+
+function legacySessionHash(token: string): string {
+  return createHash('sha256').update(token).digest('base64url');
+}
diff --git a/apps/api/src/media-auth.ts b/apps/api/src/media-auth.ts
index cce81c6..eecd821 100644
--- a/apps/api/src/media-auth.ts
+++ b/apps/api/src/media-auth.ts
@@ -1,37 +1,26 @@
-import { createHash, randomBytes, randomInt } from 'node:crypto';
+import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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
-
-const otpRateLimitWindow = new Map<string, number[]>();
-
-function checkOtpRateLimit(key: string): void {
-  const now = Date.now();
-  const timestamps = otpRateLimitWindow.get(key) ?? [];
-  const recent = timestamps.filter((ts) => now - ts < OTP_RATE_LIMIT_WINDOW_MS);
-  if (recent.length >= OTP_RATE_LIMIT_MAX) {
-    throw new MediaAuthError('RATE_LIMITED', 'Too many login requests. Try again later.');
-  }
-  recent.push(now);
-  otpRateLimitWindow.set(key, recent);
-}
+const CONTACT_MAX_LENGTH = 320;
+const HASH_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
 
 /** Generic response text for both known and unknown contacts (no enumeration). */
 const OTP_REQUESTED_MESSAGE = 'If that account is registered, a login code was sent.';
 
 interface AllowedUserRow {
   readonly id: string;
   readonly gmail: string | null;
   readonly telegram_id: string | null;
   readonly telegram_username: string | null;
   readonly added_by: string;
@@ -56,20 +45,46 @@ export class MediaAuthError extends Error {
   ) {
     super(message);
     this.name = 'MediaAuthError';
   }
 }
 
 export interface MediaAuthServiceOptions {
   readonly pool: Pool;
   readonly mailer?: MediaMailerLike;
   readonly telegram?: MediaTelegramSenderLike;
+  /**
+   * Rotation-aware HMAC keys. The first key signs new OTP/session rows; later
+   * keys are accepted for migration until their rows expire or are revoked.
+   */
+  readonly hashKeys?: readonly MediaAuthHashKey[];
+}
+
+export interface MediaAuthHashKey {
+  readonly id: string;
+  readonly secret: string;
+}
+
+export function mediaAuthHashKeysFromEnv(
+  value = process.env.JOY_MEDIA_AUTH_HASH_KEYS,
+): readonly MediaAuthHashKey[] | undefined {
+  if (value === undefined || value.trim().length === 0) return undefined;
+  return value.split(',').map((entry) => {
+    const separator = entry.indexOf(':');
+    if (separator <= 0 || separator === entry.length - 1) {
+      throw new MediaAuthError('REQUEST_INVALID', 'JOY_MEDIA_AUTH_HASH_KEYS is invalid');
+    }
+    return {
+      id: entry.slice(0, separator),
+      secret: entry.slice(separator + 1),
+    };
+  });
 }
 
 export interface MediaSessionProfile {
   readonly contact: string;
   readonly method: MediaAuthMethod;
   /** Human label: @username or gmail — never a bare telegram numeric id when username exists. */
   readonly displayName: string;
   readonly avatarAvailable: boolean;
 }
 
@@ -91,25 +106,27 @@ export interface MediaAuthApi {
 
 /**
  * Independent allow-list + OTP login for JOY Media (ADR-0017). Owns its own
  * Postgres tables (media_allowed_users, media_otp_codes, media_sessions) —
  * no dependency on JOY's accounts service at runtime.
  */
 export class MediaAuthService implements MediaAuthApi {
   private readonly pool: Pool;
   private readonly mailer: MediaMailerLike | undefined;
   private readonly telegram: MediaTelegramSenderLike | undefined;
+  private readonly hashKeys: readonly MediaAuthHashKey[];
 
   constructor(options: MediaAuthServiceOptions) {
     this.pool = options.pool;
     this.mailer = options.mailer;
     this.telegram = options.telegram;
+    this.hashKeys = normalizeHashKeys(options.hashKeys);
   }
 
   async listAllowed(): Promise<readonly MediaAllowedUser[]> {
     const result = await this.pool.query<AllowedUserRow>(
       'SELECT * FROM media_allowed_users ORDER BY added_at DESC',
     );
     return result.rows.map(allowedUserOf);
   }
 
   async addAllowed(input: {
@@ -150,79 +167,102 @@ export class MediaAuthService implements MediaAuthApi {
     ]);
   }
 
   /** Always returns the same generic message regardless of allow-list membership. */
   async requestOtp(
     rawContact: string,
     method: MediaAuthMethod,
     request?: IncomingMessage,
   ): Promise<{ message: string }> {
     if (request !== undefined) {
-      checkOtpRateLimit(requestIp(request));
+      await this.checkOtpRateLimit(requestIp(request));
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
-          `INSERT INTO media_otp_codes (contact, method, code_hash, created_at, expires_at, used)
-           VALUES ($1, $2, $3, $4, $5, false)`,
-          [otpContact, method, codeHash(otpContact, method, code), now, new Date(now.getTime() + OTP_TTL_MS)],
+          `INSERT INTO media_otp_codes (contact, method, code_hash, secret_id, created_at, expires_at, used)
+           VALUES ($1, $2, $3, $4, $5, $6, false)`,
+          [
+            otpContact,
+            method,
+            this.codeHash(otpContact, method, code, this.currentKey()),
+            this.currentKey().id,
+            now,
+            new Date(now.getTime() + OTP_TTL_MS),
+          ],
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
-    const hash = codeHash(otpContact, method, code);
+    if (!/^\d{6}$/.test(code))
+      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
+    const codeRow = await this.matchActiveOtp(otpContact, method, code);
+    if (codeRow === undefined)
+      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
     const result = await this.pool.query<{ id: string }>(
-      `UPDATE media_otp_codes SET used = true
-       WHERE id = (
-         SELECT id FROM media_otp_codes
-         WHERE contact = $1 AND method = $2 AND code_hash = $3 AND used = false AND expires_at > $4
-         ORDER BY created_at DESC LIMIT 1
-       )
+      `UPDATE media_otp_codes SET used = true, code_hash = $3, secret_id = $4
+       WHERE id = $1 AND used = false AND expires_at > $2
        RETURNING id`,
-      [otpContact, method, hash, new Date()],
+      [
+        codeRow.id,
+        new Date(),
+        this.codeHash(otpContact, method, code, this.currentKey()),
+        this.currentKey().id,
+      ],
     );
-    if (result.rows.length === 0) throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
+    if (result.rows.length === 0)
+      throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
     const token = randomBytes(32).toString('base64url');
     const now = new Date();
     await this.pool.query(
-      `INSERT INTO media_sessions (token_hash, contact, method, created_at, expires_at)
-       VALUES ($1, $2, $3, $4, $5)`,
-      [sessionHash(token), otpContact, method, now, new Date(now.getTime() + SESSION_TTL_MS)],
+      `INSERT INTO media_sessions (token_hash, secret_id, contact, method, created_at, expires_at)
+       VALUES ($1, $2, $3, $4, $5, $6)`,
+      [
+        this.sessionHash(token, this.currentKey()),
+        this.currentKey().id,
+        otpContact,
+        method,
+        now,
+        new Date(now.getTime() + SESSION_TTL_MS),
+      ],
     );
     return token;
   }
 
   async logout(token: string): Promise<void> {
-    await this.pool.query('UPDATE media_sessions SET revoked_at = $2 WHERE token_hash = $1', [
-      sessionHash(token),
-      new Date(),
-    ]);
+    const now = new Date();
+    for (const hash of this.sessionHashCandidates(token)) {
+      await this.pool.query('UPDATE media_sessions SET revoked_at = $2 WHERE token_hash = $1', [
+        hash,
+        now,
+      ]);
+    }
   }
 
   /** Satisfies the existing `ApiAuthentication` interface (see http-server.ts). */
   authenticate = async (request: IncomingMessage): Promise<Actor | undefined> => {
     const row = await this.sessionRow(request);
     return row === undefined ? undefined : { id: row.contact };
   };
 
   async sessionProfile(request: IncomingMessage): Promise<MediaSessionProfile | undefined> {
     const row = await this.sessionRow(request);
@@ -249,26 +289,21 @@ export class MediaAuthService implements MediaAuthApi {
       return bytes === undefined ? undefined : { mimeType: 'image/jpeg', bytes };
     }
     return undefined;
   }
 
   private async sessionRow(
     request: IncomingMessage,
   ): Promise<{ readonly contact: string; readonly method: MediaAuthMethod } | undefined> {
     const token = bearerToken(request);
     if (token === undefined) return undefined;
-    const result = await this.pool.query<{ contact: string; method: string }>(
-      `SELECT contact, method FROM media_sessions
-       WHERE token_hash = $1 AND expires_at > $2 AND revoked_at IS NULL`,
-      [sessionHash(token), new Date()],
-    );
-    const row = result.rows[0];
+    const row = await this.matchSession(token);
     if (row === undefined) return undefined;
     if (row.method !== 'gmail' && row.method !== 'telegram') return undefined;
     return { contact: row.contact, method: row.method };
   }
 
   private async findAllowed(
     contact: string,
     method: MediaAuthMethod,
   ): Promise<MediaAllowedUser | undefined> {
     if (method === 'gmail') {
@@ -294,27 +329,145 @@ export class MediaAuthService implements MediaAuthApi {
     const result = await this.pool.query<AllowedUserRow>(
       `SELECT * FROM media_allowed_users
        WHERE telegram_username IS NOT NULL AND LOWER(telegram_username) = $1
        LIMIT 1`,
       [contact],
     );
     const row = result.rows[0];
     return row === undefined ? undefined : allowedUserOf(row);
   }
 
-  private async deliver(allowed: MediaAllowedUser, method: MediaAuthMethod, code: string): Promise<void> {
+  private async deliver(
+    allowed: MediaAllowedUser,
+    method: MediaAuthMethod,
+    code: string,
+  ): Promise<void> {
     if (method === 'gmail' && allowed.gmail !== null && this.mailer !== undefined) {
       await this.mailer.sendOtp(allowed.gmail, code);
-    } else if (method === 'telegram' && allowed.telegramId !== null && this.telegram !== undefined) {
+    } else if (
+      method === 'telegram' &&
+      allowed.telegramId !== null &&
+      this.telegram !== undefined
+    ) {
       await this.telegram.sendOtp(allowed.telegramId, code);
     }
   }
+
+  private async checkOtpRateLimit(key: string): Promise<void> {
+    const now = new Date();
+    const keyHash = this.rateLimitHash(key);
+    await this.pool.query('DELETE FROM media_otp_rate_limits WHERE created_at <= $1', [
+      new Date(now.getTime() - OTP_RATE_LIMIT_WINDOW_MS),
+    ]);
+    const active = await this.pool.query<{ count: string }>(
+      `SELECT count(*)::text AS count FROM media_otp_rate_limits
+       WHERE key_hash = $1 AND created_at > $2`,
+      [keyHash, new Date(now.getTime() - OTP_RATE_LIMIT_WINDOW_MS)],
+    );
+    if (Number(active.rows[0]?.count ?? '0') >= OTP_RATE_LIMIT_MAX) {
+      throw new MediaAuthError('RATE_LIMITED', 'Too many login requests. Try again later.');
+    }
+    await this.pool.query(
+      'INSERT INTO media_otp_rate_limits (key_hash, secret_id, created_at) VALUES ($1, $2, $3)',
+      [keyHash, this.currentKey().id, now],
+    );
+  }
+
+  private async matchActiveOtp(
+    contact: string,
+    method: MediaAuthMethod,
+    code: string,
+  ): Promise<{ readonly id: string } | undefined> {
+    const result = await this.pool.query<{
+      readonly id: string;
+      readonly code_hash: string;
+      readonly secret_id: string | null;
+    }>(
+      `SELECT id, code_hash, secret_id FROM media_otp_codes
+       WHERE contact = $1 AND method = $2 AND used = false AND expires_at > $3
+       ORDER BY created_at DESC`,
+      [contact, method, new Date()],
+    );
+    return result.rows.find((row) => {
+      const key =
+        row.secret_id === null
+          ? undefined
+          : this.hashKeys.find((candidate) => candidate.id === row.secret_id);
+      const expected =
+        key === undefined
+          ? legacyCodeHash(contact, method, code)
+          : this.codeHash(contact, method, code, key);
+      return safeEqual(row.code_hash, expected);
+    });
+  }
+
+  private async matchSession(token: string): Promise<
+    | {
+        readonly id: string;
+        readonly token_hash: string;
+        readonly secret_id: string | null;
+        readonly contact: string;
+        readonly method: string;
+      }
+    | undefined
+  > {
+    for (const hash of this.sessionHashCandidates(token)) {
+      const result = await this.pool.query<{
+        readonly id: string;
+        readonly token_hash: string;
+        readonly secret_id: string | null;
+        readonly contact: string;
+        readonly method: string;
+      }>(
+        `SELECT id, token_hash, secret_id, contact, method FROM media_sessions
+         WHERE token_hash = $1 AND expires_at > $2 AND revoked_at IS NULL
+         LIMIT 1`,
+        [hash, new Date()],
+      );
+      const row = result.rows[0];
+      if (row === undefined) continue;
+      const currentHash = this.sessionHash(token, this.currentKey());
+      if (row.secret_id !== this.currentKey().id || row.token_hash !== currentHash) {
+        await this.pool.query(
+          'UPDATE media_sessions SET token_hash = $2, secret_id = $3 WHERE id = $1',
+          [row.id, currentHash, this.currentKey().id],
+        );
+      }
+      return row;
+    }
+    return undefined;
+  }
+
+  private codeHash(
+    contact: string,
+    method: MediaAuthMethod,
+    code: string,
+    key: MediaAuthHashKey,
+  ): string {
+    return hmacDigest(key.secret, `otp:${method}:${contact}:${code}`);
+  }
+
+  private sessionHash(token: string, key: MediaAuthHashKey): string {
+    return hmacDigest(key.secret, `session:${token}`);
+  }
+
+  private rateLimitHash(key: string): string {
+    return hmacDigest(this.currentKey().secret, `otp-rate:${key}`);
+  }
+
+  private sessionHashCandidates(token: string): readonly string[] {
+    return [...this.hashKeys.map((key) => this.sessionHash(token, key)), legacySessionHash(token)];
+  }
+
+  private currentKey(): MediaAuthHashKey {
+    return this.hashKeys[0]!;
+  }
 }
 
 /** Used when JOY_MEDIA_DATABASE_URL is unset — /v1/auth stays disabled, same spirit as LocalControlPlane. */
 export class DisabledMediaAuth implements MediaAuthApi {
   async requestOtp(): Promise<{ readonly message: string }> {
     return { message: OTP_REQUESTED_MESSAGE };
   }
   async verifyOtp(): Promise<string> {
     throw new MediaAuthError('OTP_INVALID', 'code is invalid or expired');
   }
@@ -366,46 +519,77 @@ function normalizeTelegramId(value: string | undefined): string | undefined {
 }
 
 function isTelegramNumericId(value: string): boolean {
   return /^\d+$/.test(value);
 }
 
 /** Strip optional @; lowercase usernames; keep numeric ids as-is. */
 function normalizeContact(value: string, method: MediaAuthMethod): string {
   const trimmed = value.trim();
   if (trimmed.length === 0) throw new MediaAuthError('REQUEST_INVALID', 'contact is required');
+  if (trimmed.length > CONTACT_MAX_LENGTH)
+    throw new MediaAuthError('REQUEST_INVALID', 'contact is too long');
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
 
-function codeHash(contact: string, method: MediaAuthMethod, code: string): string {
+function legacyCodeHash(contact: string, method: MediaAuthMethod, code: string): string {
   return createHash('sha256').update(`${method}:${contact}:${code}`).digest('base64url');
 }
 
-function sessionHash(token: string): string {
+function legacySessionHash(token: string): string {
   return createHash('sha256').update(token).digest('base64url');
 }
 
+function hmacDigest(secret: string, value: string): string {
+  return createHmac('sha256', secret).update(value).digest('base64url');
+}
+
+function safeEqual(left: string, right: string): boolean {
+  const leftBytes = Buffer.from(left);
+  const rightBytes = Buffer.from(right);
+  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
+}
+
+function normalizeHashKeys(
+  keys: readonly MediaAuthHashKey[] | undefined,
+): readonly MediaAuthHashKey[] {
+  const resolved =
+    keys === undefined || keys.length === 0
+      ? [{ id: 'local-dev', secret: 'joy-media-local-development-auth-hash-key' }]
+      : keys;
+  const seen = new Set<string>();
+  return resolved.map((key) => {
+    const id = key.id.trim();
+    const secret = key.secret.trim();
+    if (!HASH_KEY_ID.test(id) || secret.length < 16 || seen.has(id)) {
+      throw new MediaAuthError('REQUEST_INVALID', 'auth hash keys are invalid');
+    }
+    seen.add(id);
+    return { id, secret };
+  });
+}
+
 function bearerToken(request: IncomingMessage): string | undefined {
   const value = request.headers.authorization;
   return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
 }
 
 function requestIp(request: IncomingMessage): string {
   const headers = request.headers;
   if (headers === undefined || headers === null) return 'unknown';
   const forwarded = headers['x-forwarded-for'];
   if (typeof forwarded === 'string' && forwarded.length > 0) {
diff --git a/apps/api/src/postgres-schema.ts b/apps/api/src/postgres-schema.ts
index dbc8a90..96dc1a3 100644
--- a/apps/api/src/postgres-schema.ts
+++ b/apps/api/src/postgres-schema.ts
@@ -49,15 +49,19 @@ CREATE INDEX IF NOT EXISTS production_runs_project_id_idx ON production_runs (pr
 CREATE UNIQUE INDEX IF NOT EXISTS production_run_events_run_seq_idx ON production_run_events (run_id, seq);
 CREATE INDEX IF NOT EXISTS production_run_events_project_seq_idx ON production_run_events (project_id, run_id, seq);
 CREATE UNIQUE INDEX IF NOT EXISTS production_approvals_run_approval_idx ON production_approvals (run_id, approval_id);
 CREATE INDEX IF NOT EXISTS production_approvals_project_state_idx ON production_approvals (project_id, state, run_id);
 CREATE INDEX IF NOT EXISTS job_events_job_cursor_idx ON job_events (job_id, cursor);
 CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts (job_id, id DESC);
 CREATE INDEX IF NOT EXISTS workers_session_idx ON workers (session_token_hash) WHERE session_token_hash IS NOT NULL;
 CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
 CREATE UNIQUE INDEX IF NOT EXISTS media_allowed_users_gmail_idx ON media_allowed_users (gmail) WHERE gmail IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS media_allowed_users_telegram_idx ON media_allowed_users (telegram_id) WHERE telegram_id IS NOT NULL;
-CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
+CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, secret_id text, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
+ALTER TABLE media_otp_codes ADD COLUMN IF NOT EXISTS secret_id text;
 CREATE INDEX IF NOT EXISTS media_otp_codes_contact_idx ON media_otp_codes (contact, method, used, expires_at);
-CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
+CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, secret_id text, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
+ALTER TABLE media_sessions ADD COLUMN IF NOT EXISTS secret_id text;
 CREATE UNIQUE INDEX IF NOT EXISTS media_sessions_token_idx ON media_sessions (token_hash);
+CREATE TABLE IF NOT EXISTS media_otp_rate_limits (id bigserial primary key, key_hash text not null, secret_id text, created_at timestamptz not null);
+CREATE INDEX IF NOT EXISTS media_otp_rate_limits_key_created_idx ON media_otp_rate_limits (key_hash, created_at);
 `;
diff --git a/apps/api/src/server.ts b/apps/api/src/server.ts
index 848e6d6..5165891 100644
--- a/apps/api/src/server.ts
+++ b/apps/api/src/server.ts
@@ -1,14 +1,14 @@
 import { Pool } from 'pg';
 import { LocalControlPlane } from './control-plane.js';
 import { createControlPlaneHttpServer } from './http-server.js';
-import { DisabledMediaAuth, MediaAuthService } from './media-auth.js';
+import { DisabledMediaAuth, MediaAuthService, mediaAuthHashKeysFromEnv } from './media-auth.js';
 import { MediaMailer } from './media-mailer.js';
 import { MediaTelegramSender } from './media-telegram.js';
 import { PostgresControlPlane } from './postgres-control-plane.js';
 import { RclonePrivateObjectStore } from './private-object-store.js';
 import {
   createRuntimeMistralProviderRegistry,
   PostgresMistralInvocationLedger,
 } from './mistral-provider.js';
 import { ProviderApprovalService } from './provider-approval.js';
 
@@ -19,25 +19,27 @@ async function start(): Promise<void> {
   const port = Number(process.env.JOY_MEDIA_API_PORT ?? 8790);
   const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
   const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
   const durableControlPlane = pool === undefined ? undefined : new PostgresControlPlane(pool);
   if (durableControlPlane !== undefined) await durableControlPlane.initialize();
   const mistralLedger = pool === undefined ? undefined : new PostgresMistralInvocationLedger(pool);
   if (mistralLedger !== undefined) await mistralLedger.initialize();
   const providerApprovals = new ProviderApprovalService();
   const mailer = createMailer();
   const telegram = createTelegramSender();
+  const mediaAuthHashKeys = mediaAuthHashKeysFromEnv();
   const mediaAuth =
     pool === undefined
       ? new DisabledMediaAuth()
       : new MediaAuthService({
           pool,
+          ...(mediaAuthHashKeys === undefined ? {} : { hashKeys: mediaAuthHashKeys }),
           ...(mailer === undefined ? {} : { mailer }),
           ...(telegram === undefined ? {} : { telegram }),
         });
   createControlPlaneHttpServer({
     controlPlane: durableControlPlane ?? new LocalControlPlane(),
     // Public /v1 (project/job/asset routes) stays disabled unless durable state
     // is configured; /v1/auth is served by mediaAuth regardless (it owns its
     // own allow-list/session tables independently of the control plane).
     authentication: {
       authenticate: (request) =>
diff --git a/apps/editor-web/src/app-menu.test.ts b/apps/editor-web/src/app-menu.test.ts
index d8db8ba..6bdd761 100644
--- a/apps/editor-web/src/app-menu.test.ts
+++ b/apps/editor-web/src/app-menu.test.ts
@@ -30,11 +30,24 @@ describe('app-menu catalog', () => {
       'Joy Code Settings…',
     ]);
   });
 
   it('parses panel focus actions', () => {
     expect(isPanelMenuAction('view.panel.timeline')).toBe(true);
     expect(panelIdFromMenuAction('view.panel.timeline')).toBe('timeline');
     expect(panelIdFromMenuAction('window.panel.media')).toBe('media');
     expect(panelIdFromMenuAction('edit.undo')).toBeUndefined();
   });
+
+  it('does not advertise experimental platform panels in the default View menu', () => {
+    const view = APP_MENU_GROUPS.find((group) => group.id === 'view');
+    expect(view?.items.map((item) => item.id)).not.toEqual(
+      expect.arrayContaining([
+        'view.panel.jobs',
+        'view.panel.workflows',
+        'view.panel.production',
+        'view.panel.plugins',
+        'view.panel.templates',
+      ]),
+    );
+  });
 });
diff --git a/apps/editor-web/src/app-menu.ts b/apps/editor-web/src/app-menu.ts
index 040c006..73b3884 100644
--- a/apps/editor-web/src/app-menu.ts
+++ b/apps/editor-web/src/app-menu.ts
@@ -1,11 +1,11 @@
-import { PANEL_IDS, type PanelId } from './workspace.js';
+import { GA_PANEL_IDS, PANEL_IDS, type PanelId } from './workspace.js';
 import { PANEL_LABELS } from './panel-tab-icons.js';
 
 export type AppMenuActionId =
   | 'file.projects'
   | 'file.export'
   | 'file.signOut'
   | 'edit.undo'
   | 'edit.redo'
   | 'edit.delete'
   | 'edit.duplicate'
@@ -39,21 +39,21 @@ export interface AppMenuGroup {
 }
 
 const WINDOW_PANELS = [
   'media',
   'monitor',
   'timeline',
   'inspector',
 ] as const satisfies readonly PanelId[];
 
 function panelViewItems(): readonly AppMenuItem[] {
-  return PANEL_IDS.map((panelId) => ({
+  return GA_PANEL_IDS.map((panelId) => ({
     id: `view.panel.${panelId}` as const,
     label: PANEL_LABELS[panelId],
   }));
 }
 
 function windowPanelItems(): readonly AppMenuItem[] {
   return WINDOW_PANELS.map((panelId) => ({
     id: `window.panel.${panelId}` as const,
     label: `Focus ${PANEL_LABELS[panelId]}`,
   }));
diff --git a/apps/editor-web/src/dock-layout.test.ts b/apps/editor-web/src/dock-layout.test.ts
index 2322809..7e5b622 100644
--- a/apps/editor-web/src/dock-layout.test.ts
+++ b/apps/editor-web/src/dock-layout.test.ts
@@ -139,11 +139,30 @@ describe('view modes', () => {
 
     expect(vertical.grid?.orientation).toBe('HORIZONTAL');
     expect(wide.grid?.orientation).toBe('VERTICAL');
     expect(leafIds(vertical)).toContain('monitor-col');
     expect(leafIds(wide)).toContain('monitor-row');
     expect(leafIds(wide)).not.toContain('monitor-col');
     expect(wide.activeGroup).toBe('monitor-row');
     expect(seedDockLayout('widescreen')).toEqual(wide);
     expect(seedDockLayout('vertical')).toEqual(vertical);
   });
+
+  it('does not open experimental platform panels in seeded GA layouts', () => {
+    const experimental = new Set(['jobs', 'workflows', 'production', 'plugins', 'templates']);
+    const views = (layout: unknown): string[] => {
+      const out: string[] = [];
+      const walk = (node: unknown): void => {
+        if (!isRecord(node)) return;
+        if (isRecord(node.data) && Array.isArray(node.data.views)) {
+          out.push(...node.data.views.filter((view): view is string => typeof view === 'string'));
+        }
+        if (Array.isArray(node.data)) for (const child of node.data) walk(child);
+      };
+      walk((layout as LayoutWithPanels).grid?.root);
+      return out;
+    };
+
+    expect(views(verticalDockLayout()).some((view) => experimental.has(view))).toBe(false);
+    expect(views(widescreenDockLayout()).some((view) => experimental.has(view))).toBe(false);
+  });
 });
diff --git a/apps/editor-web/src/dock-layout.ts b/apps/editor-web/src/dock-layout.ts
index cdfd97a..f1cf7e6 100644
--- a/apps/editor-web/src/dock-layout.ts
+++ b/apps/editor-web/src/dock-layout.ts
@@ -51,40 +51,23 @@ export const SUPERSEDED_DOCK_LAYOUT_KEYS: readonly string[] = [
   'joy-media.dockview.v8',
 ];
 
 /**
  * Panels use icon-only tabs, so the dock can stay operable in a narrow editor
  * viewport without Dockview's default 100 px-per-group overflow.
  */
 export const DOCK_PANEL_MINIMUM_WIDTH = 64;
 export const DOCK_PANEL_MINIMUM_HEIGHT = 72;
 
-const BROWSER_GROUP = [
-  'media',
-  'effects',
-  'transitions',
-  'captions',
-  'audio',
-  'color',
-  'plugins',
-] as const;
+const BROWSER_GROUP = ['media', 'effects', 'transitions', 'captions', 'audio', 'color'] as const;
 
-const CONTEXT_GROUP = [
-  'inspector',
-  'motion',
-  'history',
-  'jobs',
-  'diagnostics',
-  'workflows',
-  'production',
-  'camera',
-] as const;
+const CONTEXT_GROUP = ['inspector', 'motion', 'history', 'diagnostics', 'camera'] as const;
 
 export interface ViewModeStorage {
   getItem(key: string): string | null;
   setItem(key: string, value: string): void;
   removeItem(key: string): void;
 }
 
 export function dockLayoutKey(mode: EditorViewMode): string {
   return `joy-media.dockview.${mode}.v${DOCK_LAYOUT_VERSION}`;
 }
diff --git a/apps/editor-web/src/plugin-host.test.ts b/apps/editor-web/src/plugin-host.test.ts
index 53733c1..35d66c3 100644
--- a/apps/editor-web/src/plugin-host.test.ts
+++ b/apps/editor-web/src/plugin-host.test.ts
@@ -1,46 +1,53 @@
 import { describe, expect, it } from 'vitest';
-import {
-  DEMO_PANEL_PLUGIN_ID,
-  createEditorPluginHost,
-} from './plugin-host.js';
+import { DEMO_PANEL_PLUGIN_ID, createEditorPluginHost } from './plugin-host.js';
 
 describe('WP-18 plugin host', () => {
-  it('seeds the demo panel disabled under safe mode by default', () => {
+  it('keeps the demo panel unavailable by default', () => {
     const storage = new Map<string, string>();
     const host = createEditorPluginHost({
       getItem: (key) => storage.get(key) ?? null,
       setItem: (key, value) => storage.set(key, value),
     });
     expect(host.isSafeMode()).toBe(true);
-    expect(host.list()).toHaveLength(1);
-    expect(host.list()[0]?.state).toBe('disabled');
+    expect(host.list()).toHaveLength(0);
     expect(host.canMountDemoPanel()).toBe(false);
     expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({
       ok: false,
-      issues: ['plugin/enable-denied:safe-mode'],
+      issues: ['plugin/not-installed'],
     });
   });
 
-  it('enables mount only when safe mode is off, and preserves project data on disable', () => {
+  it('enables experimental demo mount only when explicitly registered, and preserves project data on disable', () => {
     const storage = new Map<string, string>();
-    const host = createEditorPluginHost({
-      getItem: (key) => storage.get(key) ?? null,
-      setItem: (key, value) => storage.set(key, value),
+    const host = createEditorPluginHost(
+      {
+        getItem: (key) => storage.get(key) ?? null,
+        setItem: (key, value) => storage.set(key, value),
+      },
+      { enableExperimentalDemoPanel: true },
+    );
+    expect(host.list()).toHaveLength(1);
+    expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({
+      ok: false,
+      issues: ['plugin/enable-denied:safe-mode'],
     });
     host.setSafeMode(false);
     expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({ ok: true });
     expect(host.canMountDemoPanel()).toBe(true);
     host.setProjectData(DEMO_PANEL_PLUGIN_ID, { note: 'keep-me' });
     expect(host.disable(DEMO_PANEL_PLUGIN_ID)).toBe(true);
     expect(host.canMountDemoPanel()).toBe(false);
     expect(host.getProjectData(DEMO_PANEL_PLUGIN_ID)).toEqual({ note: 'keep-me' });
 
-    const reopened = createEditorPluginHost({
-      getItem: (key) => storage.get(key) ?? null,
-      setItem: (key, value) => storage.set(key, value),
-    });
+    const reopened = createEditorPluginHost(
+      {
+        getItem: (key) => storage.get(key) ?? null,
+        setItem: (key, value) => storage.set(key, value),
+      },
+      { enableExperimentalDemoPanel: true },
+    );
     expect(reopened.isSafeMode()).toBe(false);
     expect(reopened.list()[0]?.state).toBe('disabled');
     expect(reopened.getProjectData(DEMO_PANEL_PLUGIN_ID)).toEqual({ note: 'keep-me' });
   });
 });
diff --git a/apps/editor-web/src/plugin-host.ts b/apps/editor-web/src/plugin-host.ts
index a7d9c7d..2b58875 100644
--- a/apps/editor-web/src/plugin-host.ts
+++ b/apps/editor-web/src/plugin-host.ts
@@ -43,52 +43,71 @@ export interface EditorPluginHost {
   isSafeMode(): boolean;
   setSafeMode(safeMode: boolean): void;
   enable(pluginId: string): { readonly ok: boolean; readonly issues?: readonly string[] };
   disable(pluginId: string): boolean;
   canMountDemoPanel(): boolean;
   /** Opaque namespaced project data — survives disable (non-destructive). */
   getProjectData(pluginId: string): unknown;
   setProjectData(pluginId: string, value: unknown): void;
 }
 
+export interface EditorPluginHostOptions {
+  readonly enableExperimentalDemoPanel?: boolean;
+}
+
 export function createEditorPluginHost(
   storage:
     | { getItem(key: string): string | null; setItem(key: string, value: string): void }
     | undefined = typeof window !== 'undefined' ? window.localStorage : undefined,
+  options: EditorPluginHostOptions = {},
 ): EditorPluginHost {
   const persisted = (() => {
     if (storage === undefined) {
-      return { safeMode: true, enabledIds: [] as string[], projectData: {} as Record<string, unknown> };
+      return {
+        safeMode: true,
+        enabledIds: [] as string[],
+        projectData: {} as Record<string, unknown>,
+      };
     }
     try {
       const raw = storage.getItem(STORAGE_KEY);
       if (raw === null) {
-        return { safeMode: true, enabledIds: [] as string[], projectData: {} as Record<string, unknown> };
+        return {
+          safeMode: true,
+          enabledIds: [] as string[],
+          projectData: {} as Record<string, unknown>,
+        };
       }
       const parsed = JSON.parse(raw) as PersistedHostState;
       return {
         safeMode: parsed.safeMode === true,
         enabledIds: Array.isArray(parsed.enabledIds)
           ? parsed.enabledIds.filter((id): id is string => typeof id === 'string')
           : [],
         projectData:
           typeof parsed.projectData === 'object' && parsed.projectData !== null
             ? ({ ...parsed.projectData } as Record<string, unknown>)
             : {},
       };
     } catch {
-      return { safeMode: true, enabledIds: [] as string[], projectData: {} as Record<string, unknown> };
+      return {
+        safeMode: true,
+        enabledIds: [] as string[],
+        projectData: {} as Record<string, unknown>,
+      };
     }
   })();
 
   const host = new FirstPartyPluginHost(defaultPolicy(persisted.safeMode));
-  host.register(DEMO_PANEL_MANIFEST);
+  if (options.enableExperimentalDemoPanel === true) {
+    host.register(DEMO_PANEL_MANIFEST);
+  }
   for (const id of persisted.enabledIds) {
     host.enable(id, 'ui');
   }
 
   const sdk = createPluginSdkHost(['ui.panel']);
 
   function persist(): void {
     if (storage === undefined) return;
     storage.setItem(
       STORAGE_KEY,
diff --git a/apps/editor-web/src/workspace.test.ts b/apps/editor-web/src/workspace.test.ts
index 0ad3892..3400779 100644
--- a/apps/editor-web/src/workspace.test.ts
+++ b/apps/editor-web/src/workspace.test.ts
@@ -1,12 +1,21 @@
 import { describe, expect, it } from 'vitest';
-import { DEFAULT_WORKSPACE, recoverWorkspaceLayout } from './workspace.js';
+import { DEFAULT_WORKSPACE, GA_PANEL_IDS, PANEL_IDS, recoverWorkspaceLayout } from './workspace.js';
 import { searchActions } from './editor-state.js';
 
 describe('editor workspace contracts', () => {
   it('restores a safe default for malformed layouts', () => {
     expect(recoverWorkspaceLayout({ version: 1, panels: ['timeline'] })).toEqual(DEFAULT_WORKSPACE);
   });
+  it('keeps experimental platform panels out of the GA default workspace', () => {
+    expect(DEFAULT_WORKSPACE.panels).toEqual(GA_PANEL_IDS);
+    expect(PANEL_IDS).toEqual(
+      expect.arrayContaining(['jobs', 'workflows', 'production', 'plugins', 'templates']),
+    );
+    expect(DEFAULT_WORKSPACE.panels).not.toEqual(
+      expect.arrayContaining(['jobs', 'workflows', 'production', 'plugins', 'templates']),
+    );
+  });
   it('exposes command-palette actions through one shortcut registry', () => {
     expect(searchActions('undo')).toMatchObject([{ id: 'history.undo', shortcut: 'Mod+Z' }]);
   });
 });
diff --git a/apps/editor-web/src/workspace.ts b/apps/editor-web/src/workspace.ts
index 7d0cda5..f1c2492 100644
--- a/apps/editor-web/src/workspace.ts
+++ b/apps/editor-web/src/workspace.ts
@@ -15,49 +15,46 @@ export const PANEL_IDS = [
   'diagnostics',
   'jobs',
   'agent',
   'workflows',
   'production',
   'plugins',
   'templates',
 ] as const;
 export type PanelId = (typeof PANEL_IDS)[number];
 
+export const GA_PANEL_IDS = [
+  'media',
+  'monitor',
+  'timeline',
+  'flow',
+  'captions',
+  'inspector',
+  'motion',
+  'camera',
+  'audio',
+  'effects',
+  'transitions',
+  'color',
+  'history',
+  'diagnostics',
+  'agent',
+] as const satisfies readonly PanelId[];
+
 export interface WorkspaceLayout {
   readonly version: 1;
   readonly panels: readonly PanelId[];
 }
 
 export const DEFAULT_WORKSPACE: WorkspaceLayout = {
   version: 1,
-  panels: [
-    'media',
-    'monitor',
-    'timeline',
-    'flow',
-    'captions',
-    'inspector',
-    'motion',
-    'camera',
-    'audio',
-    'effects',
-    'transitions',
-    'color',
-    'history',
-    'diagnostics',
-    'jobs',
-    'agent',
-    'workflows',
-    'production',
-    'plugins',
-    'templates',
-  ],
+  panels: GA_PANEL_IDS,
 };
 
 export const WORKSPACE_STORAGE_KEY = 'joy-media.editor-workspace.v1';
 export interface WorkspaceStorage {
   getItem(key: string): string | null;
   setItem(key: string, value: string): void;
 }
 
 /** Layout is a user preference, isolated from the creative project document. */
 export function recoverWorkspaceLayout(value: unknown): WorkspaceLayout {
@@ -74,20 +71,34 @@ export function loadWorkspacePreference(storage: WorkspaceStorage): WorkspaceLay
     return DEFAULT_WORKSPACE;
   }
 }
 export function saveWorkspacePreference(storage: WorkspaceStorage, layout: WorkspaceLayout): void {
   storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(layout));
 }
 
 function isLayout(value: unknown): value is WorkspaceLayout {
   if (value === null || typeof value !== 'object') return false;
   const candidate = value as { version?: unknown; panels?: unknown };
+  const panels = candidate.panels;
+  const panelSet =
+    Array.isArray(panels) &&
+    panels.every((panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId))
+      ? new Set(panels)
+      : undefined;
+  const isDefaultGaShape =
+    panelSet !== undefined &&
+    Array.isArray(panels) &&
+    panels.length === GA_PANEL_IDS.length &&
+    GA_PANEL_IDS.every((panel) => panelSet.has(panel));
+  const isFullRegistryShape =
+    panelSet !== undefined &&
+    Array.isArray(panels) &&
+    panels.length === PANEL_IDS.length &&
+    PANEL_IDS.every((panel) => panelSet.has(panel));
   return (
     candidate.version === 1 &&
-    Array.isArray(candidate.panels) &&
-    candidate.panels.length === PANEL_IDS.length &&
-    new Set(candidate.panels).size === PANEL_IDS.length &&
-    candidate.panels.every(
-      (panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId),
-    )
+    Array.isArray(panels) &&
+    (isDefaultGaShape || isFullRegistryShape) &&
+    new Set(panels).size === panels.length &&
+    panels.every((panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId))
   );
 }
diff --git a/docs/product/FEATURE-STATUS.md b/docs/product/FEATURE-STATUS.md
index efa5633..adc4567 100644
--- a/docs/product/FEATURE-STATUS.md
+++ b/docs/product/FEATURE-STATUS.md
@@ -1,20 +1,20 @@
 # JOY Media Feature Status
 
-Audited against current source on 2026-08-21. Each feature row carries exactly one status from: `production`, `demo-only`, `experimental`, or `hidden`.
+Audited against current source on 2026-08-22. Each feature row carries exactly one status from: `production`, `demo-only`, `experimental`, or `hidden`.
 
-| Feature                                                             | Status       | Release boundary                                                                                                                                     | Flag / gate                                                          | Exit gate                                                                          |
-| ------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
-| Editor shell, project library, OTP login gate                       | production   | `App.tsx`, `ProjectLibrary.tsx`, `LoginGate.tsx`, and `media-auth.ts` define the live entry path on `joyst.ir`.                                      | Allow-list + OTP/TG/token auth.                                      | Stay default-path and covered by app/API smoke checks.                             |
-| Timeline editing, monitor preview, and export flow                  | production   | Docked timeline/monitor plus command-bus editing and export presets ship in the main workspace.                                                      | None beyond normal auth.                                             | Keep preview/export parity and command-path verification green.                    |
-| Joy Code deterministic edit intents                                 | production   | `AgentPanel` routes matched intents into dry-run, approval, and atomic timeline commands.                                                            | Capability policy + approval mode.                                   | Keep real command-bus execution and honest decline path intact.                    |
-| Motion Studio overlay and scene library round-trip                  | production   | `MotionPanel` opens `MotionStudioShell`; scenes load/save through the motion scene catalog.                                                          | None beyond normal auth.                                             | Keep open/edit/save/publish flow stable in the default editor.                     |
-| Effect Studio overlay                                               | production   | `EffectsPanel` opens `EffectStudioShell`, which applies recipe edits back onto timeline objects.                                                     | None beyond normal auth.                                             | Keep apply/close path and autosave stable.                                         |
-| Motion Studio advanced direct manipulation                          | experimental | Source already includes resize, rotate, guides, marquee, on-canvas text edit, grouping, keyframe evaluation, basic keyframe rows, and trim controls. | No separate product flag; maturity is implementation depth.          | Close remaining polish gaps and stabilize the full authoring loop.                 |
-| Templates panel and template apply flow                             | experimental | `templates` is a registered dock panel with first-party and saved template apply actions.                                                            | No separate flag; panel is surfaced in the workspace.                | Wire import/ownership polish and set promotion criteria beyond local/demo storage. |
-| Workflow authoring, first-party workflow runs, and approval resumes | experimental | `workflow-engine`, `WorkflowGraphEditor`, and `WorkflowsPanel` support graph edits, saved/system workflows, and `waiting_for_input` resumes.         | Dual Lens graph persistence and some ports remain gated or deferred. | Close remaining persistence and port-availability gaps.                            |
-| Joy Code 3D preview tab                                             | experimental | `AgentPanel` mounts a `3d` tab backed by `JoyCode3DViewer` with `three`, orbit controls, and GLTF loading.                                           | Manual model import only; no MCP or authoring shell.                 | Promote from viewer-only preview to a durable 3D editing flow.                     |
-| Local/GPU Worker pairing and capability-backed jobs                 | experimental | Pairing, leases, capability hello, and Worker job plumbing are shipped; richer jobs surface only when a paired Worker advertises them.               | Owner-approved pairing + advertised capability.                      | Prove end-to-end user-facing flows without relying on fixture-only paths.          |
-| Plugin host and Demo Panel                                          | demo-only    | The plugin host mounts the first-party demo panel only when safe mode is off.                                                                        | Safe mode must be disabled and the demo panel enabled.               | Replace demo-only mounting with audited production plugin surfaces.                |
-| Dual Lens durable graph and v2 persistence                          | hidden       | Source supports v2 slices, graph/artifact commands, and Flow projections, but the durable graph remains behind the Dual Lens flag.                   | `graphEnabled` / Dual Lens gating.                                   | Persist the v2 document end-to-end and graduate the flag.                          |
-| PSD import apply flow                                               | hidden       | `ag-psd` and `psd-parser-spike.ts` exist, but there is no shipped import-to-project transaction or visible apply path.                               | Unwired spike code only.                                             | Surface a supported import UX and commit path.                                     |
-| Fullscreen 3D Studio and MCP authoring loop                         | hidden       | No `ThreeDStudioShell`, durable 3D scene document, or MCP-backed write loop is wired into the editor.                                                | Unimplemented surface.                                               | Land a real overlay, scene model, approval flow, and persistence path.             |
+| Feature                                                             | Status       | Release boundary                                                                                                                                     | Flag / gate                                                                                | Exit gate                                                                          |
+| ------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
+| Editor shell, project library, OTP login gate                       | production   | `App.tsx`, `ProjectLibrary.tsx`, `LoginGate.tsx`, and `media-auth.ts` define the live entry path on `joyst.ir`.                                      | Allow-list + OTP/TG/token auth with keyed digests and durable throttles.                   | Stay default-path and covered by app/API smoke checks.                             |
+| Timeline editing, monitor preview, and export flow                  | production   | Docked timeline/monitor plus command-bus editing and export presets ship in the main workspace.                                                      | None beyond normal auth.                                                                   | Keep preview/export parity and command-path verification green.                    |
+| Joy Code deterministic edit intents                                 | production   | `AgentPanel` routes matched intents into dry-run, approval, and atomic timeline commands.                                                            | Capability policy + approval mode.                                                         | Keep real command-bus execution and honest decline path intact.                    |
+| Motion Studio overlay and scene library round-trip                  | production   | `MotionPanel` opens `MotionStudioShell`; scenes load/save through the motion scene catalog.                                                          | None beyond normal auth.                                                                   | Keep open/edit/save/publish flow stable in the default editor.                     |
+| Effect Studio overlay                                               | production   | `EffectsPanel` opens `EffectStudioShell`, which applies recipe edits back onto timeline objects.                                                     | None beyond normal auth.                                                                   | Keep apply/close path and autosave stable.                                         |
+| Motion Studio advanced direct manipulation                          | experimental | Source already includes resize, rotate, guides, marquee, on-canvas text edit, grouping, keyframe evaluation, basic keyframe rows, and trim controls. | No separate product flag; maturity is implementation depth.                                | Close remaining polish gaps and stabilize the full authoring loop.                 |
+| Templates panel and template apply flow                             | experimental | `templates` remains registered for explicit/dev layouts with first-party and saved template apply actions.                                           | Not in the GA default workspace or View menu.                                              | Wire import/ownership polish and set promotion criteria beyond local/demo storage. |
+| Workflow authoring, first-party workflow runs, and approval resumes | experimental | `workflow-engine`, `WorkflowGraphEditor`, and `WorkflowsPanel` support graph edits, saved/system workflows, and `waiting_for_input` resumes.         | Not in the GA default workspace; provider ports remain gated or deferred.                  | Close remaining persistence and port-availability gaps.                            |
+| Joy Code 3D preview tab                                             | experimental | `AgentPanel` mounts a `3d` tab backed by `JoyCode3DViewer` with `three`, orbit controls, and GLTF loading.                                           | Manual model import only; no MCP or authoring shell.                                       | Promote from viewer-only preview to a durable 3D editing flow.                     |
+| Local/GPU Worker pairing and capability-backed jobs                 | experimental | Pairing, leases, capability hello, and Worker job plumbing exist, but job panels are not opened in the GA default workspace.                         | Owner-approved pairing + advertised capability; local/GPU/provider jobs are explicit only. | Prove end-to-end user-facing flows without relying on fixture-only paths.          |
+| Plugin host and Demo Panel                                          | demo-only    | The plugin host code remains for first-party safety testing, but the demo panel is not registered by default.                                        | Explicit `enableExperimentalDemoPanel` opt-in plus safe-mode/enable checks.                | Replace demo-only mounting with audited production plugin surfaces.                |
+| Dual Lens durable graph and v2 persistence                          | hidden       | Source supports v2 slices, graph/artifact commands, and Flow projections, but the durable graph remains behind the Dual Lens flag.                   | `graphEnabled` / Dual Lens gating.                                                         | Persist the v2 document end-to-end and graduate the flag.                          |
+| PSD import apply flow                                               | hidden       | `ag-psd` and `psd-parser-spike.ts` exist, but there is no shipped import-to-project transaction or visible apply path.                               | Unwired spike code only.                                                                   | Surface a supported import UX and commit path.                                     |
+| Fullscreen 3D Studio and MCP authoring loop                         | hidden       | No `ThreeDStudioShell`, durable 3D scene document, or MCP-backed write loop is wired into the editor.                                                | Unimplemented surface.                                                                     | Land a real overlay, scene model, approval flow, and persistence path.             |
diff --git a/docs/security/README.md b/docs/security/README.md
index 2c6c5f8..f92248b 100644
--- a/docs/security/README.md
+++ b/docs/security/README.md
@@ -1,12 +1,53 @@
-# security docs
+# JOY Media Security Boundaries
 
-> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
-> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §29 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)
+Status: current as of 2026-08-22.
 
-**Role.** Threat model details, sandbox policies, consent/licensing inventories, incident runbooks.
+This document records the production security boundaries that are safe to publish. It deliberately
+does not contain operational secrets, signing keys, OTP values, provider prompts, provider API keys,
+worker pairing codes, session tokens, filesystem paths, or object-store credentials.
 
-**First built in part:** P01+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).
+## Authentication
 
-**Must not:** Storing secrets or real keys in docs.
+- JOY Media uses an independent allow-list plus OTP login for the media app.
+- OTP requests return the same response for known and unknown contacts, so the login endpoint does
+  not confirm allow-list membership.
+- OTP and session digests are HMAC-SHA-256 values with explicit key ids. New rows use the active key;
+  previous-key and legacy rows are accepted only so they can expire or migrate after successful use.
+- OTP request throttles are stored in PostgreSQL/shared durable storage and keyed by a hashed client
+  address, not by raw IP text.
+- Browser requests authenticate with bearer sessions. Project, asset, worker-owner, provider, and
+  production-run APIs use the authenticated actor from the server-side auth boundary rather than a
+  browser-supplied authority claim.
+- Production-run authority objects are still part of the public record, but the API verifies that
+  the principal and role match the authenticated actor and rejects `system` authority from browser
+  routes.
 
-Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
+## API Limits
+
+- JSON request bodies are bounded by the API transport.
+- Binary upload routes have per-route byte limits and integrity headers.
+- Production-run records are size-limited and reject local paths, URLs, raw media fields, and
+  base64-like media payloads.
+- Provider approval audit rows store request digests, ids, status, and spend metadata; they do not
+  store raw prompts or provider secrets.
+
+## Non-GA Surfaces
+
+- Plugin, template, workflow, production-board, and GPU/job panels remain registered in source for
+  explicit development and saved-layout compatibility, but they are not opened by the GA default
+  workspace or advertised through the default View menu.
+- The first-party demo plugin host is not registered by default. It requires an explicit
+  `enableExperimentalDemoPanel` opt-in and still remains subject to safe-mode and permission checks.
+- Remote provider calls are unavailable unless the server is configured with the provider secret and
+  the request has a matching approval grant when remote processing or spend requires it.
+- Local/GPU Worker jobs require an authenticated owner, owner-approved pairing, a valid Worker
+  session, advertised capabilities, and protocol-valid receipts. Worker outputs are recorded as
+  opaque refs and verified metadata, not local paths or media bytes.
+
+## Operational Notes
+
+- Rotate media auth HMAC keys by deploying the new key first and retaining the previous key until old
+  OTPs expire and active sessions have either migrated, expired, or been revoked.
+- Treat the database, object store, provider ledgers, and Worker PCs as privileged infrastructure.
+- Keep CSRF exposure low by avoiding cookie authentication for the API; bearer sessions are supplied
+  explicitly by the editor client and checked on every protected route.
