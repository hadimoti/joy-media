import { findRegistryRegion } from '@joy-media/provider-sdk';

/** Session-scoped consent for sending credentials or requests to custom URLs. */
export type CustomEndpointIdentity = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly profileId?: string | undefined;
};

const acknowledgedEndpoints = new Set<string>();

export function isCustomEndpointProvider(provider: string): boolean {
  return provider === 'custom' || provider === 'openai-compatible';
}

export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * A registry provider at one of its own region URLs is a fixed, known origin, so it needs no
 * acknowledgement (PLAN-v4 §6c). Every other endpoint needs one.
 */
export function requiresCustomEndpointConsent(provider: string, baseUrl: string): boolean {
  return findRegistryRegion(provider, baseUrl) === undefined;
}

function identityKey(identity: CustomEndpointIdentity): string {
  return JSON.stringify([
    isCustomEndpointProvider(identity.provider) ? 'custom' : identity.provider,
    normalizeProviderBaseUrl(identity.baseUrl),
    identity.profileId ?? '',
  ]);
}

export function acknowledgeCustomEndpoint(identity: CustomEndpointIdentity): void {
  acknowledgedEndpoints.add(identityKey(identity));
}

/** Unchecking the acknowledgement withdraws consent for that exact endpoint. */
export function revokeCustomEndpointAcknowledgement(identity: CustomEndpointIdentity): void {
  acknowledgedEndpoints.delete(identityKey(identity));
}

/** Withdraw every acknowledgement for this URL, whether or not it was profile-bound. */
export function revokeCustomEndpointAcknowledgementsForUrl(baseUrl: string): void {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  for (const key of [...acknowledgedEndpoints]) {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed[1] === normalized) acknowledgedEndpoints.delete(key);
  }
}

export function isCustomEndpointAcknowledged(identity: CustomEndpointIdentity): boolean {
  return acknowledgedEndpoints.has(identityKey(identity));
}

export function requireCustomEndpointAcknowledgement(
  identity: CustomEndpointIdentity,
  onMissing?: () => void,
): boolean {
  if (isCustomEndpointAcknowledged(identity)) return true;
  onMissing?.();
  return false;
}

/**
 * Call immediately before any key-bearing request (discovery, configure),
 * after every await: consent can be withdrawn from another view while a vault
 * read or profile save is pending. Throws if consent no longer holds.
 */
export function assertCustomEndpointConsentHolds(
  provider: string,
  baseUrl: string,
  profileId?: string,
): void {
  if (!requiresCustomEndpointConsent(provider, baseUrl)) return;
  // Revocation is URL-wide, so any remaining acknowledgement for this URL
  // (profile-bound or not) means consent still holds.
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const held =
    isCustomEndpointAcknowledged({ provider: 'custom', baseUrl, profileId }) ||
    [...acknowledgedEndpoints].some((key) => {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) && parsed[1] === normalized;
    });
  if (!held) {
    throw new Error('Custom endpoint consent was withdrawn; the request was cancelled.');
  }
}

/** Startup restoration must not even ask the desktop vault for a custom key until consent exists. */
export function mayRestoreProviderProfile(profile: CustomEndpointIdentity): boolean {
  return (
    !requiresCustomEndpointConsent(profile.provider, profile.baseUrl) ||
    isCustomEndpointAcknowledged({ ...profile, provider: 'custom' })
  );
}

export function resetCustomEndpointAcknowledgementsForTests(): void {
  acknowledgedEndpoints.clear();
}
