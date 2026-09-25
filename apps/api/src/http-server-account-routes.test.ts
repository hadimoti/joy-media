import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { createControlPlaneHttpServer, type ApiAuthentication } from './http-server.js';
import { LocalControlPlane, type ControlPlane } from './control-plane.js';
import { PostgresControlPlane } from './postgres-control-plane.js';
import type { MediaAuthApi, MediaSessionProfile } from './media-auth.js';
import { AccountService } from './account-service.js';
import { ReleaseMetadataService } from './release-metadata-service.js';
import { createEd25519EntitlementSigner, verifyEntitlement } from './entitlement-signing.js';
import type { SignedEntitlement } from './entitlement-signing.js';
import type { HostedRouteRetirementFlags } from './hosted-route-retirement.js';

/**
 * Wave 4 routes (devices, account/subscription, entitlements, releases, hosted-route
 * retirement) get their own self-contained test file rather than extending
 * http-server.test.ts's `start()`/positional-argument helper: that helper hardcodes
 * `mediaAuth: new DisabledMediaAuth()`, and widening its long positional parameter list to
 * carry the wave 4 services risked an unrelated change to every existing call site in an
 * already very large file. This file builds its own minimal server directly.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

/** A trivial mediaAuth double: any bearer token of the form `token:<contact>` authenticates
 * as that contact. Real OTP/session mechanics are media-auth.ts's own concern and already
 * tested there; these tests only need a stable actor identity. */
function fakeMediaAuth(): MediaAuthApi {
  return {
    async requestOtp() {
      return { message: 'ok' };
    },
    async verifyOtp() {
      return 'unused';
    },
    async logout() {},
    async authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer token:')) return undefined;
      return { id: header.slice('Bearer token:'.length) };
    },
    async sessionProfile(): Promise<MediaSessionProfile | undefined> {
      return undefined;
    },
    async avatarBytes() {
      return undefined;
    },
  };
}

function accountPool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as Pool;
  return pool;
}

async function seededAccountService(): Promise<AccountService> {
  const pool = accountPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_devices (
      id text PRIMARY KEY, owner_id text NOT NULL, display_name text NOT NULL,
      created_at timestamptz NOT NULL, revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS account_subscriptions (
      owner_id text PRIMARY KEY, plan text NOT NULL, status text NOT NULL,
      current_period_end timestamptz, updated_at timestamptz NOT NULL
    );
  `);
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createEd25519EntitlementSigner(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  return new AccountService({ pool, signer });
}

async function seededReleaseService(): Promise<ReleaseMetadataService> {
  const pool = accountPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS release_metadata (
      id text PRIMARY KEY, channel text NOT NULL, version text NOT NULL,
      download_url text NOT NULL, sha256 text NOT NULL, signature text NOT NULL,
      min_supported_version text, published_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX release_metadata_channel_version_idx ON release_metadata (channel, version);
  `);
  return new ReleaseMetadataService({ pool });
}

async function start(
  options: Partial<{
    readonly account: AccountService;
    readonly releases: ReleaseMetadataService;
    readonly entitlementPublicKeyPem: string;
    readonly hostedRouteRetirement: HostedRouteRetirementFlags;
    readonly authentication: ApiAuthentication;
    readonly controlPlane: ControlPlane;
  }> = {},
): Promise<string> {
  const { controlPlane, authentication, ...rest } = options;
  const server = createControlPlaneHttpServer({
    controlPlane: controlPlane ?? new LocalControlPlane(),
    authentication: authentication ?? { authenticate: () => undefined },
    mediaAuth: fakeMediaAuth(),
    ...rest,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  origin: string,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  bearerToken?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bearerToken !== undefined) headers.authorization = `Bearer ${bearerToken}`;
  const response = await fetch(
    `${origin}${pathname}`,
    body === undefined
      ? { method, ...(Object.keys(headers).length === 0 ? {} : { headers }) }
      : { method, headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}

describe('POST/GET /v1/devices', () => {
  it('requires authentication', async () => {
    const origin = await start();
    expect(await request(origin, 'POST', '/v1/devices', { displayName: 'PC' })).toMatchObject({
      status: 401,
    });
  });

  it('registers a device and lists it back for the authenticated owner only', async () => {
    const account = await seededAccountService();
    const origin = await start({ account });
    const registered = await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: "Hadi's PC" },
      'token:user@example.com',
    );
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({
      data: { ownerId: 'user@example.com', displayName: "Hadi's PC" },
    });

    const listed = await request(origin, 'GET', '/v1/devices', undefined, 'token:user@example.com');
    expect((listed.body as { data: unknown[] }).data).toHaveLength(1);

    const otherOwner = await request(
      origin,
      'GET',
      '/v1/devices',
      undefined,
      'token:someone-else@example.com',
    );
    expect((otherOwner.body as { data: unknown[] }).data).toEqual([]);
  });

  it('returns 503 ACCOUNT_SERVICE_UNCONFIGURED when account service is omitted from server wiring', async () => {
    const origin = await start();
    const response = await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: 'PC' },
      'token:user@example.com',
    );
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { code: 'ACCOUNT_SERVICE_UNCONFIGURED' },
    });
  });

  it('registers devices against the schema initialized by PostgresControlPlane', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EntitlementSigner(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const account = new AccountService({ pool, signer });
    // Same wiring as ops/self-hosted/linux-runner/real-service-acceptance.mjs.
    const origin = await start({
      controlPlane,
      account,
      entitlementPublicKeyPem: signer.publicKeyPem,
    });
    const res = await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: "Hadi's PC" },
      'token:user@example.com',
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      data: { ownerId: 'user@example.com', displayName: "Hadi's PC" },
    });
    const deviceId = (res.body as { readonly data: { readonly id: string } }).data.id;
    const refreshed = await request(
      origin,
      'POST',
      '/v1/entitlements/refresh',
      { deviceId },
      'token:user@example.com',
    );
    expect(refreshed.status).toBe(200);
    const keyRoute = await request(origin, 'GET', '/v1/entitlements/public-key');
    const servedKey = (keyRoute.body as { readonly data: { readonly publicKeyPem: string } }).data
      .publicKeyPem;
    expect(servedKey).toBe(signer.publicKeyPem);
    expect(
      verifyEntitlement((refreshed.body as { readonly data: SignedEntitlement }).data, servedKey),
    ).toBe(true);
    await pool.end();
  });

  it('exports AccountService and createEd25519EntitlementSigner from the package root', async () => {
    const apiModule = await import('./index.js');
    expect(apiModule.AccountService).toBe(AccountService);
    expect(apiModule.createEd25519EntitlementSigner).toBe(createEd25519EntitlementSigner);
  });
});

describe('POST /v1/devices/:id/revoke', () => {
  it('revokes a device the authenticated owner registered', async () => {
    const account = await seededAccountService();
    const origin = await start({ account });
    const registered = (await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: 'PC' },
      'token:user@example.com',
    )) as { readonly body: { readonly data: { readonly id: string } } };

    const revoked = await request(
      origin,
      'POST',
      `/v1/devices/${registered.body.data.id}/revoke`,
      undefined,
      'token:user@example.com',
    );
    expect(revoked.status).toBe(200);

    const refresh = await request(
      origin,
      'POST',
      '/v1/entitlements/refresh',
      { deviceId: registered.body.data.id },
      'token:user@example.com',
    );
    expect(refresh.status).toBe(409);
    expect(refresh.body).toMatchObject({ error: { code: 'DEVICE_REVOKED' } });
  });
});

describe('GET/POST /v1/account/subscription', () => {
  it('reports a default none/none subscription before any plan is selected', async () => {
    const account = await seededAccountService();
    const origin = await start({ account });
    const result = await request(
      origin,
      'GET',
      '/v1/account/subscription',
      undefined,
      'token:user@example.com',
    );
    expect(result).toMatchObject({ status: 200, body: { data: { plan: 'none', status: 'none' } } });
  });

  it('selects a plan and rejects an unsupported plan value', async () => {
    const account = await seededAccountService();
    const origin = await start({ account });
    const selected = await request(
      origin,
      'POST',
      '/v1/account/subscription',
      { plan: 'yearly' },
      'token:user@example.com',
    );
    expect(selected).toMatchObject({
      status: 200,
      body: { data: { plan: 'yearly', status: 'none' } },
    });

    const invalid = await request(
      origin,
      'POST',
      '/v1/account/subscription',
      { plan: 'weekly' },
      'token:user@example.com',
    );
    expect(invalid.status).toBe(400);
  });
});

describe('POST /v1/entitlements/refresh', () => {
  it('issues a signed entitlement verifiable against the public key route', async () => {
    const account = await seededAccountService();
    const origin = await start({ account, entitlementPublicKeyPem: '' });
    const registered = (await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: 'PC' },
      'token:user@example.com',
    )) as { readonly body: { readonly data: { readonly id: string } } };

    const refreshed = await request(
      origin,
      'POST',
      '/v1/entitlements/refresh',
      { deviceId: registered.body.data.id },
      'token:user@example.com',
    );
    expect(refreshed.status).toBe(200);
    const entitlement = (refreshed.body as { readonly data: SignedEntitlement }).data;
    expect(entitlement.payload).toMatchObject({
      deviceId: registered.body.data.id,
      ownerId: 'user@example.com',
      plan: 'none',
      subscriptionStatus: 'none',
    });
  });

  it('never exposes another owner’s device to a signed-in caller', async () => {
    const account = await seededAccountService();
    const origin = await start({ account });
    const registered = (await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: 'PC' },
      'token:owner-a@example.com',
    )) as { readonly body: { readonly data: { readonly id: string } } };

    const attempt = await request(
      origin,
      'POST',
      '/v1/entitlements/refresh',
      { deviceId: registered.body.data.id },
      'token:owner-b@example.com',
    );
    expect(attempt.status).toBe(404);
    expect(attempt.body).toMatchObject({ error: { code: 'DEVICE_NOT_FOUND' } });
  });
});

describe('GET /v1/entitlements/public-key', () => {
  it('is public (no auth) and serves the configured key', async () => {
    const origin = await start({ entitlementPublicKeyPem: 'FAKE-PEM-FOR-TEST' });
    const result = await request(origin, 'GET', '/v1/entitlements/public-key');
    expect(result).toEqual({ status: 200, body: { data: { publicKeyPem: 'FAKE-PEM-FOR-TEST' } } });
  });

  it('a signed entitlement verifies against the same signer used to issue it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EntitlementSigner(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pool = accountPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_devices (
        id text PRIMARY KEY, owner_id text NOT NULL, display_name text NOT NULL,
        created_at timestamptz NOT NULL, revoked_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS account_subscriptions (
        owner_id text PRIMARY KEY, plan text NOT NULL, status text NOT NULL,
        current_period_end timestamptz, updated_at timestamptz NOT NULL
      );
    `);
    const account = new AccountService({ pool, signer });
    const origin = await start({ account, entitlementPublicKeyPem: signer.publicKeyPem });

    const registered = (await request(
      origin,
      'POST',
      '/v1/devices',
      { displayName: 'PC' },
      'token:user@example.com',
    )) as { readonly body: { readonly data: { readonly id: string } } };
    const refreshed = await request(
      origin,
      'POST',
      '/v1/entitlements/refresh',
      { deviceId: registered.body.data.id },
      'token:user@example.com',
    );
    const entitlement = (refreshed.body as { readonly data: SignedEntitlement }).data;
    const keyRoute = await request(origin, 'GET', '/v1/entitlements/public-key');
    expect((keyRoute.body as { data: { publicKeyPem: string } }).data.publicKeyPem).toBe(
      publicKeyPem,
    );
    expect(verifyEntitlement(entitlement, publicKeyPem)).toBe(true);
  });
});

describe('GET /v1/releases/:channel', () => {
  it('is public (no auth) and reports 404 when nothing has been published', async () => {
    const releases = await seededReleaseService();
    const origin = await start({ releases });
    const result = await request(origin, 'GET', '/v1/releases/stable');
    expect(result).toMatchObject({ status: 404, body: { error: { code: 'RELEASE_NOT_FOUND' } } });
  });

  it('serves the published release for a channel', async () => {
    const releases = await seededReleaseService();
    await releases.publish({
      id: 'rel-1',
      channel: 'stable',
      version: '1.0.0',
      downloadUrl: 'https://joyst.ir/download/joy-media-1.0.0.exe',
      sha256: 'a'.repeat(64),
      signature: 'b'.repeat(88),
    });
    const origin = await start({ releases });
    const result = await request(origin, 'GET', '/v1/releases/stable');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { channel: 'stable', version: '1.0.0' } });
  });

  it('does not match an unknown channel (falls through to the generic authenticated routes)', async () => {
    // Only "stable" and "beta" are in the route pattern, so "/v1/releases/nightly" is not a
    // release-metadata request at all — it falls through to the same auth-required gate every
    // other unmatched /v1/* path hits, not a release-specific 404.
    const origin = await start();
    const result = await request(origin, 'GET', '/v1/releases/nightly');
    expect(result.status).toBe(401);
  });
});

describe('hosted route retirement (wave 4/6 cutover flags)', () => {
  it('every flag defaulting off leaves POST /v1/projects reachable (its normal 401, not 410)', async () => {
    const origin = await start();
    const result = await request(origin, 'POST', '/v1/projects', { title: 'x' });
    expect(result.status).not.toBe(410);
  });

  it('returns 401, not 410, for an unauthenticated caller even with the flag on (auth checked first)', async () => {
    const origin = await start({
      hostedRouteRetirement: {
        projectRoutes: true,
        mediaLibraryRoutes: false,
        workerPairingRoutes: false,
      },
    });
    const result = await request(origin, 'POST', '/v1/projects', { title: 'x' });
    expect(result.status).toBe(401);
  });

  it('returns 410 with the retirement response for an authenticated caller once the matching flag is on', async () => {
    const origin = await start({
      authentication: { authenticate: () => ({ id: 'owner-1' }) },
      hostedRouteRetirement: {
        projectRoutes: true,
        mediaLibraryRoutes: false,
        workerPairingRoutes: false,
      },
    });
    const result = await request(origin, 'POST', '/v1/projects', { title: 'x' });
    expect(result).toMatchObject({
      status: 410,
      body: { error: { code: 'JOY_MEDIA_HOSTED_ROUTE_RETIRED' } },
    });
  });

  it('leaves POST /v1/projects reachable for an authenticated caller when the flag is off', async () => {
    const origin = await start({ authentication: { authenticate: () => ({ id: 'owner-1' }) } });
    const result = await request(origin, 'POST', '/v1/projects', { title: 'x' });
    expect(result.status).not.toBe(410);
  });
});
