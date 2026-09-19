import type { JoyAgentCapability } from './contracts.js';

export type JoyProviderMode = 'joy-hosted' | 'openrouter' | 'openai-compatible' | 'kilo' | 'custom';

export interface ByokSessionConfig {
  readonly provider: JoyProviderMode;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

export interface ByokSessionStatus {
  readonly provider: ByokSessionConfig['provider'];
  readonly modelId: string;
  readonly capability: JoyAgentCapability;
}

export class ProviderConfigError extends Error {
  readonly code = 'JOY_AGENT_PROVIDER_CONFIG_INVALID' as const;

  constructor() {
    super('JOY_AGENT_PROVIDER_CONFIG_INVALID');
    this.name = 'ProviderConfigError';
  }
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_JOY_HOSTED_BASE_URL = 'https://joyst.ir/api/v1/agent';
const MAX_MODEL_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 512;

export function normalizeByokSessionConfig(
  input: Readonly<Partial<ByokSessionConfig>>,
): ByokSessionConfig {
  const provider = input.provider;
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (
    (provider !== 'joy-hosted' &&
      provider !== 'openrouter' &&
      provider !== 'openai-compatible' &&
      provider !== 'kilo' &&
      provider !== 'custom') ||
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_ID_LENGTH ||
    apiKey.length === 0 ||
    apiKey.length > MAX_API_KEY_LENGTH
  ) {
    throw new ProviderConfigError();
  }

  if (provider === 'joy-hosted') {
    const baseUrl =
      input.baseUrl === undefined || input.baseUrl.trim().length === 0
        ? DEFAULT_JOY_HOSTED_BASE_URL
        : normalizeCustomBaseUrl(input.baseUrl);
    return Object.freeze({ provider, baseUrl, modelId, apiKey });
  }

  if (provider === 'openrouter') {
    if (
      input.baseUrl !== undefined &&
      input.baseUrl !== OPENROUTER_BASE_URL &&
      input.baseUrl !== `${OPENROUTER_BASE_URL}/`
    ) {
      throw new ProviderConfigError();
    }
    return Object.freeze({ provider, baseUrl: OPENROUTER_BASE_URL, modelId, apiKey });
  }

  const baseUrl = normalizeCustomBaseUrl(input.baseUrl);
  return Object.freeze({ provider, baseUrl, modelId, apiKey });
}

export function safeByokSessionStatus(
  config: Pick<ByokSessionConfig, 'provider' | 'modelId'>,
  capability: JoyAgentCapability = 'untested',
): ByokSessionStatus {
  return Object.freeze({ provider: config.provider, modelId: config.modelId, capability });
}

export function normalizeCustomBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) {
    throw new ProviderConfigError();
  }
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ProviderConfigError();
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname.toLowerCase().endsWith('/chat/completions') ||
    !isPublicWebHost(url.hostname)
  ) {
    throw new ProviderConfigError();
  }
  const pathname = url.pathname.replace(/\/$/, '');
  return `${url.origin}${pathname}`;
}

function isPublicWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'ip6-localhost') return false;
  if (host === 'metadata.google.internal' || host === 'metadata') return false;
  if (isPrivateIpv4(host) || isPrivateIpv6(host) || isMappedPrivateIpv4(host)) return false;
  return true;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  const first = numbers[0] ?? -1;
  const second = numbers[1] ?? -1;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function isPrivateIpv6(host: string): boolean {
  return (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.endsWith('.internal')
  );
}

/** IPv4-mapped IPv6 literals inherit the IPv4 private-range blocklist. */
function isMappedPrivateIpv4(host: string): boolean {
  const compressed = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (compressed?.[1] !== undefined && compressed[2] !== undefined) {
    const high = Number.parseInt(compressed[1], 16);
    const low = Number.parseInt(compressed[2], 16);
    return isPrivateIpv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  const groups = host.split(':');
  if (groups.length !== 8 || groups[5]?.toLowerCase() !== 'ffff') return false;
  const high = Number.parseInt(groups[6] ?? '', 16);
  const low = Number.parseInt(groups[7] ?? '', 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff)
    return false;
  return isPrivateIpv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
}

export { OPENROUTER_BASE_URL };
