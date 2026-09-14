import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { AccountService, AccountServiceError, DisabledAccountService } from './account-service.js';
import { createEd25519EntitlementSigner, verifyEntitlement } from './entitlement-signing.js';
import { generateKeyPairSync } from 'node:crypto';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEd25519EntitlementSigner(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
}

async function service(overrides: Partial<{ now: () => number; idFactory: () => string }> = {}) {
  const db = pool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_devices (
      id text PRIMARY KEY, owner_id text NOT NULL, display_name text NOT NULL,
      created_at timestamptz NOT NULL, revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS account_subscriptions (
      owner_id text PRIMARY KEY, plan text NOT NULL, status text NOT NULL,
      current_period_end timestamptz, updated_at timestamptz NOT NULL
    );
  `);
  const theSigner = signer();
  let idCount = 0;
  const account = new AccountService({
    pool: db,
    signer: theSigner,
    idFactory: overrides.idFactory ?? (() => `device-${++idCount}`),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
  return { account, db, signer: theSigner };
}

describe('AccountService devices', () => {
  it('registers a device and lists it back for its owner', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user@example.com', "Hadi's PC");
    expect(device).toMatchObject({ ownerId: 'user@example.com', displayName: "Hadi's PC" });
    expect(device.revokedAt).toBeUndefined();
    expect(await account.listDevices('user@example.com')).toEqual([device]);
  });

  it('rejects an empty display name', async () => {
    const { account } = await service();
    await expect(account.registerDevice('user@example.com', '   ')).rejects.toBeInstanceOf(
      AccountServiceError,
    );
  });

  it('never lists another owner’s devices', async () => {
    const { account } = await service();
    await account.registerDevice('user-a@example.com', 'A-PC');
    await account.registerDevice('user-b@example.com', 'B-PC');
    const listA = await account.listDevices('user-a@example.com');
    expect(listA).toHaveLength(1);
    expect(listA[0]?.ownerId).toBe('user-a@example.com');
  });

  it('revokes a device it owns', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user@example.com', 'PC');
    await account.revokeDevice('user@example.com', device.id);
    const [reloaded] = await account.listDevices('user@example.com');
    expect(reloaded?.revokedAt).toBeTypeOf('number');
  });

  it('refuses to revoke a device belonging to a different owner', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user-a@example.com', 'A-PC');
    await expect(account.revokeDevice('user-b@example.com', device.id)).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
    });
  });

  it('refuses to revoke an already-revoked device', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user@example.com', 'PC');
    await account.revokeDevice('user@example.com', device.id);
    await expect(account.revokeDevice('user@example.com', device.id)).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
    });
  });
});

describe('AccountService subscriptions', () => {
  it('reports a default none/none subscription before any plan is selected', async () => {
    const { account } = await service();
    expect(await account.getSubscription('user@example.com')).toMatchObject({
      plan: 'none',
      status: 'none',
    });
  });

  it('selects a plan, which stays pending (status none) until wave 5 activates it', async () => {
    const { account } = await service();
    const subscription = await account.selectPlan('user@example.com', 'yearly');
    expect(subscription).toMatchObject({ plan: 'yearly', status: 'none' });
    expect(await account.getSubscription('user@example.com')).toMatchObject({
      plan: 'yearly',
      status: 'none',
    });
  });

  it('lets a pending plan be changed before activation', async () => {
    const { account } = await service();
    await account.selectPlan('user@example.com', 'monthly');
    const updated = await account.selectPlan('user@example.com', 'yearly');
    expect(updated.plan).toBe('yearly');
  });

  it('activates a selected plan (the wave 5 hook) and then reports it active', async () => {
    const { account } = await service({ now: () => 1_000 });
    await account.selectPlan('user@example.com', 'monthly');
    const periodEnd = 1_000 + 30 * 86_400_000;
    const activated = await account.activateSubscription('user@example.com', periodEnd);
    expect(activated).toMatchObject({
      plan: 'monthly',
      status: 'active',
      currentPeriodEnd: periodEnd,
    });
  });

  it('refuses to change the plan on an already-active subscription', async () => {
    const { account } = await service({ now: () => 1_000 });
    await account.selectPlan('user@example.com', 'monthly');
    await account.activateSubscription('user@example.com', 1_000 + 86_400_000);
    await expect(account.selectPlan('user@example.com', 'yearly')).rejects.toMatchObject({
      code: 'SUBSCRIPTION_ALREADY_ACTIVE',
    });
  });

  it('reports status expired once the current period end has passed, without a separate expiry job', async () => {
    let now = 1_000;
    const { account } = await service({ now: () => now });
    await account.selectPlan('user@example.com', 'monthly');
    await account.activateSubscription('user@example.com', 2_000);
    expect((await account.getSubscription('user@example.com')).status).toBe('active');
    now = 3_000; // past current_period_end
    expect((await account.getSubscription('user@example.com')).status).toBe('expired');
  });
});

describe('AccountService entitlement issuance', () => {
  it('issues a signed entitlement for a registered device reflecting the real subscription state', async () => {
    const { account, signer: theSigner } = await service({ now: () => 5_000 });
    const device = await account.registerDevice('user@example.com', 'PC');
    await account.selectPlan('user@example.com', 'yearly');
    await account.activateSubscription('user@example.com', 5_000 + 365 * 86_400_000);

    const entitlement = await account.issueEntitlement('user@example.com', device.id);
    expect(entitlement.payload).toMatchObject({
      deviceId: device.id,
      ownerId: 'user@example.com',
      plan: 'yearly',
      subscriptionStatus: 'active',
      issuedAt: 5_000,
    });
    expect(entitlement.payload.expiresAt).toBeGreaterThan(entitlement.payload.issuedAt);
    expect(verifyEntitlement(entitlement, theSigner.publicKeyPem)).toBe(true);
  });

  it('issues a signed "no subscription" entitlement rather than refusing, for an owner with no plan', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user@example.com', 'PC');
    const entitlement = await account.issueEntitlement('user@example.com', device.id);
    expect(entitlement.payload).toMatchObject({ plan: 'none', subscriptionStatus: 'none' });
  });

  it('refuses to issue an entitlement for an unknown device', async () => {
    const { account } = await service();
    await expect(account.issueEntitlement('user@example.com', 'missing')).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
    });
  });

  it('refuses to issue an entitlement for a revoked device — this is how revocation takes effect', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user@example.com', 'PC');
    await account.revokeDevice('user@example.com', device.id);
    await expect(account.issueEntitlement('user@example.com', device.id)).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
  });

  it('refuses to issue an entitlement for a device belonging to a different owner', async () => {
    const { account } = await service();
    const device = await account.registerDevice('user-a@example.com', 'PC');
    await expect(account.issueEntitlement('user-b@example.com', device.id)).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
    });
  });
});

describe('DisabledAccountService', () => {
  it('reports a default subscription and an empty device list rather than throwing', async () => {
    const disabled = new DisabledAccountService();
    await expect(disabled.getSubscription('user@example.com')).resolves.toMatchObject({
      plan: 'none',
      status: 'none',
    });
    await expect(disabled.listDevices('user@example.com')).resolves.toEqual([]);
  });

  it('refuses every mutating operation with a typed, consistent error', async () => {
    const disabled = new DisabledAccountService();
    await expect(disabled.registerDevice('u', 'PC')).rejects.toBeInstanceOf(AccountServiceError);
    await expect(disabled.revokeDevice('u', 'd')).rejects.toBeInstanceOf(AccountServiceError);
    await expect(disabled.selectPlan('u', 'monthly')).rejects.toBeInstanceOf(AccountServiceError);
    await expect(disabled.issueEntitlement('u', 'd')).rejects.toBeInstanceOf(AccountServiceError);
  });
});
