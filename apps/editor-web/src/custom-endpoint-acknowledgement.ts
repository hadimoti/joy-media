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
  return !isCustomEndpointProvider(profile.provider) || isCustomEndpointAcknowledged(profile);
}

export function resetCustomEndpointAcknowledgementsForTests(): void {
  acknowledgedEndpoints.clear();
}
