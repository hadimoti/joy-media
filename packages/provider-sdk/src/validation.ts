/**
 * Validation for BYOK provider profiles (JOY Media desktop, PLAN-v4 §6c). A profile is checked
 * against the shared registry and endpoint policy before it is ever persisted, so a key is
 * never written for an endpoint the broker would later refuse.
 */

import {
  CUSTOM_PROVIDER_ALIAS,
  CUSTOM_PROVIDER_ID,
  REGISTRY_PROVIDER_IDS,
  evaluateEndpoint,
} from './registry.js';

export const BYOK_PROVIDERS = [
  ...REGISTRY_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_ALIAS,
] as const;
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

export interface ProviderProfileInput {
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  /** The owner has confirmed this public endpoint (S8). Without it, a public custom endpoint is refused. */
  readonly acknowledgedPublicEndpoint?: boolean | undefined;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Fails closed: an unknown provider, an empty model id, a malformed base URL, or a base URL the
 * endpoint policy refuses are all rejected before a profile is saved or a key is written.
 */
export function validateProviderProfileInput(
  input: ProviderProfileInput,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!(BYOK_PROVIDERS as readonly string[]).includes(input.provider)) {
    issues.push({
      code: 'PROVIDER_UNSUPPORTED',
      message: `provider must be one of: ${BYOK_PROVIDERS.join(', ')}`,
    });
  }

  if (input.modelId.trim().length === 0) {
    issues.push({ code: 'MODEL_ID_REQUIRED', message: 'modelId must not be empty' });
  }

  if (!isAbsoluteUrl(input.baseUrl)) {
    issues.push({ code: 'BASE_URL_INVALID', message: 'baseUrl must be a valid absolute URL' });
  } else {
    const verdict = evaluateEndpoint(input.provider, input.baseUrl, {
      consentToPublicEndpoint: input.acknowledgedPublicEndpoint === true,
    });
    if (!verdict.allowed) issues.push({ code: verdict.code, message: verdict.reason });
  }

  return issues;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value.trim()).href.length > 0;
  } catch {
    return false;
  }
}
