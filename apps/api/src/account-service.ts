import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  EntitlementPayload,
  EntitlementSigner,
  SignedEntitlement,
} from './entitlement-signing.js';

/**
 * Device registration, subscriptions, and signed entitlement issuance (JOY Media desktop
 * migration, wave 4). Owns its own tables — see the `007-account-*` migration in
 * postgres-migrations.ts — independently of the legacy project/media control-plane tables,
 * same independence `MediaAuthService` already established for OTP login.
 *
 * Identity here is always the `mediaAuth` actor id (the OTP contact) — this service is part
 * of the same "OTP is the one identity for account/device/subscription/entitlement" domain
 * the wave 0 design doc calls out, not the legacy `ApiAuthentication` used by
 * project/worker/job routes.
 */

export type SubscriptionPlan = 'monthly' | 'yearly' | 'none';
export type SubscriptionStatus = 'none' | 'active' | 'expired';

export interface AccountDevice {
  readonly id: string;
  readonly ownerId: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export interface Subscription {
  readonly ownerId: string;
  readonly plan: SubscriptionPlan;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd?: number;
  readonly updatedAt: number;
}

export class AccountServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AccountServiceError';
  }
}

export interface AccountServiceOptions {
  readonly pool: Pool;
  readonly signer: EntitlementSigner;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** How long a signed entitlement is valid for before the desktop client must refresh it.
   * Short enough that a device revocation or subscription change propagates within a bounded
   * window even though verification itself is offline (no live revocation check needed on
   * every use — see the module doc on revocability). Default: 72 hours. */
  readonly entitlementTtlMs?: number;
}

const DEFAULT_ENTITLEMENT_TTL_MS = 72 * 60 * 60_000;

interface DeviceRow {
  readonly id: string;
  readonly owner_id: string;
  readonly display_name: string;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

interface SubscriptionRow {
  readonly owner_id: string;
  readonly plan: string;
  readonly status: string;
  readonly current_period_end: Date | null;
  readonly updated_at: Date;
}

export interface AccountApi {
  registerDevice(ownerId: string, displayName: string): Promise<AccountDevice>;
  listDevices(ownerId: string): Promise<readonly AccountDevice[]>;
  revokeDevice(ownerId: string, deviceId: string): Promise<void>;
  getSubscription(ownerId: string): Promise<Subscription>;
  selectPlan(ownerId: string, plan: 'monthly' | 'yearly'): Promise<Subscription>;
  issueEntitlement(ownerId: string, deviceId: string): Promise<SignedEntitlement>;
}

export class AccountService implements AccountApi {
  private readonly pool: Pool;
  private readonly signer: EntitlementSigner;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly entitlementTtlMs: number;

  constructor(options: AccountServiceOptions) {
    this.pool = options.pool;
    this.signer = options.signer;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.entitlementTtlMs = options.entitlementTtlMs ?? DEFAULT_ENTITLEMENT_TTL_MS;
  }

  async registerDevice(ownerId: string, displayName: string): Promise<AccountDevice> {
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      throw new AccountServiceError('DEVICE_NAME_REQUIRED', 'displayName must not be empty');
    }
    const id = this.idFactory();
    const createdAt = new Date(this.now());
    const result = await this.pool.query<DeviceRow>(
      `INSERT INTO account_devices (id, owner_id, display_name, created_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, ownerId, trimmed.slice(0, 200), createdAt],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AccountServiceError('DEVICE_CREATE_FAILED', 'insert failed');
    return deviceOf(row);
  }

  async listDevices(ownerId: string): Promise<readonly AccountDevice[]> {
    const result = await this.pool.query<DeviceRow>(
      'SELECT * FROM account_devices WHERE owner_id = $1 ORDER BY created_at DESC',
      [ownerId],
    );
    return result.rows.map(deviceOf);
  }

  async revokeDevice(ownerId: string, deviceId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE account_devices SET revoked_at = $3
       WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL`,
      [deviceId, ownerId, new Date(this.now())],
    );
    if (result.rowCount === 0) {
      throw new AccountServiceError('DEVICE_NOT_FOUND', 'device not found or already revoked');
    }
  }

  async getSubscription(ownerId: string): Promise<Subscription> {
    const row = await this.subscriptionRow(ownerId);
    return row === undefined
      ? defaultSubscription(ownerId, this.now())
      : subscriptionOf(row, this.now());
  }

  /**
   * Records the owner's desired plan. Does **not** activate it — activation happens once a
   * USDC payment confirms (wave 5's job; `activateSubscription` below is the hook that wave
   * calls). Refuses to change the plan on an already-active subscription: a mid-cycle
   * plan-change/proration flow is out of scope here and silently overwriting one would risk
   * corrupting real billing state once wave 5 exists.
   */
  async selectPlan(ownerId: string, plan: 'monthly' | 'yearly'): Promise<Subscription> {
    const existing = await this.subscriptionRow(ownerId);
    if (existing !== undefined && existing.status === 'active') {
      throw new AccountServiceError(
        'SUBSCRIPTION_ALREADY_ACTIVE',
        'plan changes for an active subscription are not supported yet',
      );
    }
    const updatedAt = new Date(this.now());
    const result = await this.pool.query<SubscriptionRow>(
      `INSERT INTO account_subscriptions (owner_id, plan, status, current_period_end, updated_at)
       VALUES ($1, $2, 'none', NULL, $3)
       ON CONFLICT (owner_id) DO UPDATE SET plan = $2, status = 'none', current_period_end = NULL, updated_at = $3
       RETURNING *`,
      [ownerId, plan, updatedAt],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AccountServiceError('SUBSCRIPTION_UPDATE_FAILED', 'upsert failed');
    }
    return subscriptionOf(row, this.now());
  }

  /**
   * Activation hook for wave 5's USDC payment confirmation — not called from any route this
   * wave. Kept here (rather than added later) because the subscription lifecycle is one
   * cohesive, testable state machine; leaving activation out would make `selectPlan`'s
   * "refuses to touch an active subscription" branch untestable on its own.
   */
  async activateSubscription(ownerId: string, currentPeriodEndMs: number): Promise<Subscription> {
    const updatedAt = new Date(this.now());
    const result = await this.pool.query<SubscriptionRow>(
      `UPDATE account_subscriptions SET status = 'active', current_period_end = $2, updated_at = $3
       WHERE owner_id = $1 RETURNING *`,
      [ownerId, new Date(currentPeriodEndMs), updatedAt],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AccountServiceError(
        'SUBSCRIPTION_NOT_FOUND',
        'no plan selected for this owner yet',
      );
    }
    return subscriptionOf(row, this.now());
  }

  /**
   * Issues a signed, time-bounded entitlement for one already-registered, non-revoked device.
   * Revocation works by *absence of reissuance*: a revoked device can never obtain a new
   * entitlement, and every entitlement already issued expires on its own within
   * `entitlementTtlMs` — there is no separate live "is this still valid" network check the
   * desktop client must make on every use, which is what makes offline verification safe.
   */
  async issueEntitlement(ownerId: string, deviceId: string): Promise<SignedEntitlement> {
    const deviceResult = await this.pool.query<DeviceRow>(
      'SELECT * FROM account_devices WHERE id = $1 AND owner_id = $2',
      [deviceId, ownerId],
    );
    const deviceRow = deviceResult.rows[0];
    if (deviceRow === undefined) {
      throw new AccountServiceError('DEVICE_NOT_FOUND', 'device not found');
    }
    if (deviceRow.revoked_at !== null) {
      throw new AccountServiceError('DEVICE_REVOKED', 'device has been revoked');
    }

    const now = this.now();
    const subscription = await this.getSubscription(ownerId);
    const payload: EntitlementPayload = {
      deviceId,
      ownerId,
      plan: subscription.plan,
      subscriptionStatus: subscription.status,
      issuedAt: now,
      expiresAt: now + this.entitlementTtlMs,
    };
    return this.signer.sign(payload);
  }

  private async subscriptionRow(ownerId: string): Promise<SubscriptionRow | undefined> {
    const result = await this.pool.query<SubscriptionRow>(
      'SELECT * FROM account_subscriptions WHERE owner_id = $1',
      [ownerId],
    );
    return result.rows[0];
  }
}

/** Used when JOY_MEDIA_DATABASE_URL (or the signing key) is unset — same disabled-fallback
 * shape as DisabledMediaAuth: every route stays reachable but reports the feature as absent
 * rather than the process crashing at startup. */
export class DisabledAccountService implements AccountApi {
  async registerDevice(_ownerId: string, _displayName: string): Promise<AccountDevice> {
    throw new AccountServiceError(
      'ACCOUNT_SERVICE_UNCONFIGURED',
      'account service is not configured',
    );
  }
  async listDevices(_ownerId: string): Promise<readonly AccountDevice[]> {
    return [];
  }
  async revokeDevice(_ownerId: string, _deviceId: string): Promise<void> {
    throw new AccountServiceError(
      'ACCOUNT_SERVICE_UNCONFIGURED',
      'account service is not configured',
    );
  }
  async getSubscription(ownerId: string): Promise<Subscription> {
    return defaultSubscription(ownerId, Date.now());
  }
  async selectPlan(_ownerId: string, _plan: 'monthly' | 'yearly'): Promise<Subscription> {
    throw new AccountServiceError(
      'ACCOUNT_SERVICE_UNCONFIGURED',
      'account service is not configured',
    );
  }
  async issueEntitlement(_ownerId: string, _deviceId: string): Promise<SignedEntitlement> {
    throw new AccountServiceError(
      'ACCOUNT_SERVICE_UNCONFIGURED',
      'account service is not configured',
    );
  }
}

function defaultSubscription(ownerId: string, now: number): Subscription {
  return { ownerId, plan: 'none', status: 'none', updatedAt: now };
}

function deviceOf(row: DeviceRow): AccountDevice {
  return {
    id: row.id,
    ownerId: row.owner_id,
    displayName: row.display_name,
    createdAt: row.created_at.getTime(),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at.getTime() } : {}),
  };
}

/** A subscription whose billing period has lapsed reads as `expired`, computed at read time
 * rather than by a background job — there is no separate state to go stale. */
function subscriptionOf(row: SubscriptionRow, now: number): Subscription {
  const plan = asPlan(row.plan);
  const currentPeriodEnd = row.current_period_end?.getTime();
  const status: SubscriptionStatus =
    row.status === 'active' && currentPeriodEnd !== undefined && currentPeriodEnd <= now
      ? 'expired'
      : asStatus(row.status);
  return {
    ownerId: row.owner_id,
    plan,
    status,
    ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
    updatedAt: row.updated_at.getTime(),
  };
}

function asPlan(value: string): SubscriptionPlan {
  return value === 'monthly' || value === 'yearly' ? value : 'none';
}

function asStatus(value: string): SubscriptionStatus {
  return value === 'active' || value === 'expired' ? value : 'none';
}
