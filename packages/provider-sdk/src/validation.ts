/**
 * Model/base-URL validation for BYOK direct-provider profiles (JOY Media desktop migration,
 * wave 3). Mirrors `apps/editor-web/src/joy-agent/protocol.ts`'s `ByokSessionConfig` field
 * names (`provider`, `baseUrl`, `modelId`) so a future editor-web integration is a straight
 * type match rather than a translation layer.
 */

export const BYOK_PROVIDERS = ['openrouter', 'openai-compatible', 'kilo', 'custom'] as const;
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

export interface ProviderProfileInput {
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Fails closed: an insecure or malformed base URL, an unknown provider, or an empty model id
 * are all rejected before a profile is ever persisted or a key ever leaves DPAPI/Keychain
 * storage. `http://` is allowed only to loopback hosts, for local OpenAI-compatible servers
 * (Ollama, LM Studio, ...) a developer runs on their own machine — anything else must be
 * `https://` so a provider key is never sent over a plaintext network hop.
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

  const url = parseUrl(input.baseUrl);
  if (url === undefined) {
    issues.push({ code: 'BASE_URL_INVALID', message: 'baseUrl must be a valid absolute URL' });
  } else if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
  ) {
    issues.push({
      code: 'BASE_URL_INSECURE',
      message: 'baseUrl must be https://, or http:// to a loopback host only',
    });
  }

  return issues;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
