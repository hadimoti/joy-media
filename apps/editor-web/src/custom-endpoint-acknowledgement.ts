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
  kilo: 'https://api.kilo.ai/v1',
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
    return (
      candidate.pathname !== trusted.pathname &&
      !candidate.pathname.startsWith(`${trusted.pathname.replace(/\/$/, '')}/`)
    );
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
