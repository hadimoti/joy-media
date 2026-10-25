import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import type { Actor } from '../apps/api/src/control-plane.js';
import { AccountService } from '../apps/api/src/account-service.js';
import { createEd25519EntitlementSigner } from '../apps/api/src/entitlement-signing.js';
import {
  MediaAuthService,
  type MediaAuthApi,
  type MediaSessionProfile,
} from '../apps/api/src/media-auth.js';
import type { MediaMailerLike } from '../apps/api/src/media-mailer.js';

/**
 * Test-only synthetic accounts for the local E2E server. This module is imported only by
 * tooling/e2e-server.ts. It runs the real MediaAuthService (allow-list, hashed one-time codes,
 * sessions) and the real AccountService (subscription rows) over an isolated in-memory database.
 * The only substitutions are the mailer, which records codes instead of sending mail, and the
 * control routes, which let a test read a code or set a subscription state. Production code is
 * never changed to support any of this, and the control server is never started without a token.
 */

export const SYNTHETIC_DOMAIN = 'synthetic.joy-media.test';
export const CONTROL_TOKEN_ENV = 'JOY_MEDIA_E2E_CONTROL_TOKEN';
export const CONTROL_HEADER = 'x-joy-e2e-control';
/** Test-only client key, so each test gets its own OTP rate-limit bucket. */
export const SYNTHETIC_CLIENT_HEADER = 'x-joy-e2e-client';
const MIN_CONTROL_TOKEN_LENGTH = 32;
const MAX_CONTROL_BODY_BYTES = 8 * 1024;
const SUBSCRIPTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** Reads the control token from the environment, or undefined when the harness must stay off. */
export function syntheticControlToken(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[CONTROL_TOKEN_ENV]?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value.length < MIN_CONTROL_TOKEN_LENGTH)
    throw new Error(`${CONTROL_TOKEN_ENV} must be at least ${MIN_CONTROL_TOKEN_LENGTH} characters`);
  if (env.NODE_ENV === 'production')
    throw new Error('the synthetic account harness must never run with NODE_ENV=production');
  return value;
}

export function isSyntheticContact(contact: string): boolean {
  return contact.trim().toLowerCase().endsWith(`@${SYNTHETIC_DOMAIN}`);
}

/** Keeps the most recent code per recipient. The code is only ever read by the control route. */
class RecordingOtpMailer implements MediaMailerLike {
  readonly #latest = new Map<string, { readonly code: string; readonly sentAt: string }>();

  async sendOtp(gmail: string, code: string): Promise<void> {
    this.#latest.set(gmail.toLowerCase(), { code, sentAt: new Date().toISOString() });
  }

  latest(contact: string): { readonly code: string; readonly sentAt: string } | undefined {
    return this.#latest.get(contact.trim().toLowerCase());
  }
}

export interface SyntheticAccountHarness {
  /** Routes synthetic contacts to the real service and everything else to `fallback`. */
  readonly mediaAuth: MediaAuthApi;
  /** Real subscription service over the same isolated database. */
  readonly account: AccountService;
  readonly pool: Pool;
  readonly mailer: RecordingOtpMailer;
  readonly media: MediaAuthService;
}

export async function createSyntheticAccountHarness(options: {
  readonly fallback: MediaAuthApi;
}): Promise<SyntheticAccountHarness> {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as Pool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
    CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
    CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
    CREATE TABLE IF NOT EXISTS account_devices (id text PRIMARY KEY, owner_id text NOT NULL, display_name text NOT NULL, created_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE IF NOT EXISTS account_subscriptions (owner_id text PRIMARY KEY, plan text NOT NULL, status text NOT NULL, current_period_end timestamptz, updated_at timestamptz NOT NULL);
  `);
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createEd25519EntitlementSigner(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  const mailer = new RecordingOtpMailer();
  // The production OTP rate limit stays on. Each test client sends its own key, so one test's
  // logins cannot exhaust another's bucket, while a repeated key is still throttled as in production.
  const media = new MediaAuthService({
    pool,
    mailer,
    clientAddressResolver: (request) => {
      const key = request.headers[SYNTHETIC_CLIENT_HEADER];
      return typeof key === 'string' && key.length > 0 && key.length <= 128
        ? `synthetic:${key}`
        : '127.0.0.1';
    },
  });
  const account = new AccountService({ pool, signer });

  const mediaAuth: MediaAuthApi = {
    requestOtp: (contact, method, request) =>
      method === 'gmail' && isSyntheticContact(contact)
        ? media.requestOtp(contact, method, request)
        : options.fallback.requestOtp(contact, method, request),
    verifyOtp: (contact, method, code) =>
      method === 'gmail' && isSyntheticContact(contact)
        ? media.verifyOtp(contact, method, code)
        : options.fallback.verifyOtp(contact, method, code),
    logout: async (token) => {
      await media.logout(token);
      await options.fallback.logout(token);
    },
    authenticate: async (request): Promise<Actor | undefined> =>
      (await media.authenticate(request)) ?? options.fallback.authenticate(request),
    sessionProfile: async (request): Promise<MediaSessionProfile | undefined> =>
      (await media.sessionProfile(request)) ?? options.fallback.sessionProfile(request),
    avatarBytes: (request) => options.fallback.avatarBytes(request),
  };

  return { mediaAuth, account, pool, mailer, media };
}

/** Adds an allow-listed synthetic account. Idempotent, so a repeated seed leaves one row. */
async function ensureSyntheticAccount(
  harness: SyntheticAccountHarness,
  contact: string,
): Promise<void> {
  const normalized = contact.trim().toLowerCase();
  if (!isSyntheticContact(normalized))
    throw new Error(`synthetic accounts must use @${SYNTHETIC_DOMAIN}`);
  const existing = await harness.media.listAllowed();
  if (existing.some((user) => user.gmail === normalized)) return;
  await harness.media.addAllowed({ gmail: normalized, addedBy: 'e2e-harness' });
}

type SubscriptionState = 'none' | 'active' | 'expired';

async function setSubscription(
  harness: SyntheticAccountHarness,
  contact: string,
  state: SubscriptionState,
): Promise<void> {
  const owner = contact.trim().toLowerCase();
  if (state === 'none') {
    await harness.pool.query(
      `INSERT INTO account_subscriptions (owner_id, plan, status, current_period_end, updated_at)
       VALUES ($1, 'none', 'none', NULL, $2)
       ON CONFLICT (owner_id) DO UPDATE SET plan = 'none', status = 'none', current_period_end = NULL, updated_at = $2`,
      [owner, new Date()],
    );
    return;
  }
  // "expired" is stored as an active row whose period has already ended, which is how the
  // subscription service itself reports an expiry.
  const now = Date.now();
  const periodEnd = new Date(state === 'active' ? now + SUBSCRIPTION_PERIOD_MS : now - 1_000);
  await harness.pool.query(
    `INSERT INTO account_subscriptions (owner_id, plan, status, current_period_end, updated_at)
     VALUES ($1, 'monthly', 'active', $2, $3)
     ON CONFLICT (owner_id) DO UPDATE SET plan = 'monthly', status = 'active', current_period_end = $2, updated_at = $3`,
    [owner, periodEnd, new Date(now)],
  );
}

async function expireRows(
  harness: SyntheticAccountHarness,
  table: 'media_sessions' | 'media_otp_codes',
  contact: string,
): Promise<number> {
  const past = new Date(Date.now() - 1_000);
  const result = await harness.pool.query(
    `UPDATE ${table} SET expires_at = $2 WHERE contact = $1`,
    [contact.trim().toLowerCase(), past],
  );
  return result.rowCount ?? 0;
}

/**
 * Control routes on their own loopback port. Every request needs the control token, and nothing
 * here is reachable from the production API router.
 */
export function startSyntheticControlServer(
  harness: SyntheticAccountHarness,
  options: { readonly token: string; readonly port: number },
): Promise<Server> {
  const expected = Buffer.from(options.token);
  const server = createServer((request, response) => {
    handleControl(request, response, harness, expected).catch((error: unknown) => {
      respond(response, 500, { error: { code: 'CONTROL_FAILED', message: messageOf(error) } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  harness: SyntheticAccountHarness,
  expected: Buffer,
): Promise<void> {
  const presented = Buffer.from(String(request.headers[CONTROL_HEADER] ?? ''));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'control token required' } });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/__e2e/otp/latest') {
    const contact = url.searchParams.get('contact') ?? '';
    const latest = harness.mailer.latest(contact);
    if (latest === undefined) {
      respond(response, 404, { error: { code: 'NOT_FOUND', message: 'no code was sent' } });
      return;
    }
    respond(response, 200, { data: latest });
    return;
  }

  if (request.method !== 'POST') {
    respond(response, 404, { error: { code: 'NOT_FOUND', message: 'unknown control route' } });
    return;
  }
  const body = await readControlJson(request);
  const contact = typeof body.contact === 'string' ? body.contact : '';
  if (contact.length === 0) {
    respond(response, 422, { error: { code: 'REQUEST_INVALID', message: 'contact is required' } });
    return;
  }

  switch (url.pathname) {
    case '/__e2e/accounts':
      await ensureSyntheticAccount(harness, contact);
      respond(response, 200, { data: { contact: contact.trim().toLowerCase() } });
      return;
    case '/__e2e/subscriptions': {
      const state = body.state;
      if (state !== 'none' && state !== 'active' && state !== 'expired') {
        respond(response, 422, { error: { code: 'REQUEST_INVALID', message: 'invalid state' } });
        return;
      }
      await setSubscription(harness, contact, state);
      respond(response, 200, { data: { contact: contact.trim().toLowerCase(), state } });
      return;
    }
    case '/__e2e/sessions/expire':
      respond(response, 200, {
        data: { expired: await expireRows(harness, 'media_sessions', contact) },
      });
      return;
    case '/__e2e/otp/expire':
      respond(response, 200, {
        data: { expired: await expireRows(harness, 'media_otp_codes', contact) },
      });
      return;
    default:
      respond(response, 404, { error: { code: 'NOT_FOUND', message: 'unknown control route' } });
  }
}

async function readControlJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_CONTROL_BODY_BYTES) throw new Error('control body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
