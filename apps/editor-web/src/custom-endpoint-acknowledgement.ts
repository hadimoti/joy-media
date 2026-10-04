import { KILO_GATEWAY_BASE_URL } from '@joy-media/joy-agent-engine';

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

const TRUSTED_PROVIDER_ENDPOINTS: Readonly<Record<string, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  kilo: KILO_GATEWAY_BASE_URL,
  'joy-hosted': 'https://joyst.ir/api/v1/agent',
};

/** Consent is required unless the URL is the provider's exact trusted HTTPS origin and path. */
export function requiresCustomEndpointConsent(provider: string, baseUrl: string): boolean {
  const trustedEndpoint = TRUSTED_PROVIDER_ENDPOINTS[provider];
  if (!trustedEndpoint) return true;

  try {
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const candidate = new URL(normalizedBaseUrl);
    const trusted = new URL(trustedEndpoint);
    const authority = normalizedBaseUrl.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
    if (
      candidate.protocol !== 'https:' ||
      candidate.hostname !== trusted.hostname ||
      authority.includes('@') ||
      candidate.username !== '' ||
      candidate.password !== '' ||
      candidate.port !== '' ||
      candidate.search !== '' ||
      candidate.hash !== ''
    ) {
      return true;
    }
    if (provider === 'kilo') {
      return (
        candidate.hostname !== 'api.kilo.ai' ||
        (candidate.pathname !== '/api/gateway' && candidate.pathname !== '/api/gateway/v1')
      );
    }
    // Exact trusted path only: a sub-path such as /api/v1/chat is a different
    // configured endpoint and needs consent.
    return candidate.pathname !== trusted.pathname;
  } catch {
    return true;
  }
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
