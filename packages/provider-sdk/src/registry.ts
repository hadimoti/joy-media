/**
 * Provider registry and endpoint policy (JOY Media v1.1.0, PLAN-v4 §5, §6a and §6c).
 *
 * This module holds only fixed, non-secret facts: which providers exist, the API style each
 * one speaks, and the origins each one may use. It performs no I/O, so the desktop broker, the
 * CLI and the editor can all import it. Only the main-process broker reads a credential.
 */

/**
 * The providers offered for API-key sign-in, and ChatGPT for sign-in only (`signInOnly`). Each one has fixed origins
 * (PLAN-v4 §5, §6d).
 */
export const REGISTRY_PROVIDER_IDS = [
  'openai',
  'grok',
  'claude',
  'minimax',
  'gemini',
  'kimi',
  'openrouter',
  'chatgpt',
] as const;
export type RegistryProviderId = (typeof REGISTRY_PROVIDER_IDS)[number];

/** A user-supplied base URL. Loopback only in this build: public endpoints await S8. */
export const CUSTOM_PROVIDER_ID = 'openai-compatible';
/** v1.0.x saved custom endpoints as `custom`. Both names are the same provider here. */
export const CUSTOM_PROVIDER_ALIAS = 'custom';

export function isCustomProviderId(provider: string): boolean {
  return provider === CUSTOM_PROVIDER_ID || provider === CUSTOM_PROVIDER_ALIAS;
}

/** The wire format a provider speaks. The broker converts only Anthropic Messages. */
export type ProviderApi = 'chat-completions' | 'anthropic-messages' | 'chatgpt-responses';

export type ProviderRegionId = 'international' | 'china';

export interface ProviderRegion {
  readonly id: ProviderRegionId;
  readonly label: string;
  /** Exact base URL. A profile must use one of these strings, with any trailing slash removed. */
  readonly baseUrl: string;
  /** Where the owner creates a key. Opened only by an explicit click. */
  readonly keyUrl: string;
  readonly docsUrl: string;
}

export interface RegistryProvider {
  readonly id: RegistryProviderId;
  readonly label: string;
  readonly api: ProviderApi;
  readonly regions: readonly [ProviderRegion, ...ProviderRegion[]];
  /** Offered only for sign-in, never as an API-key provider (ChatGPT, PLAN-v4 §6d). */
  readonly signInOnly?: true;
}

const INTERNATIONAL = 'international';
const CHINA = 'china';

export const PROVIDER_REGISTRY: readonly RegistryProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'chat-completions',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.openai.com/v1',
        keyUrl: 'https://platform.openai.com/api-keys',
        docsUrl: 'https://developers.openai.com',
      },
    ],
  },
  {
    id: 'grok',
    label: 'Grok (xAI)',
    api: 'chat-completions',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.x.ai/v1',
        keyUrl: 'https://console.x.ai',
        docsUrl: 'https://docs.x.ai/developers/api-reference',
      },
    ],
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    api: 'anthropic-messages',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.anthropic.com/v1',
        keyUrl: 'https://platform.claude.com',
        docsUrl: 'https://platform.claude.com/docs',
      },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    api: 'chat-completions',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.minimax.io/v1',
        keyUrl: 'https://platform.minimax.io',
        docsUrl: 'https://platform.minimax.io/docs',
      },
      {
        id: CHINA,
        label: 'China',
        baseUrl: 'https://api.minimax.cn/v1',
        keyUrl: 'https://platform.minimax.cn',
        docsUrl: 'https://platform.minimax.cn/docs',
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'chat-completions',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        keyUrl: 'https://aistudio.google.com',
        docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
      },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot AI)',
    api: 'chat-completions',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.moonshot.ai/v1',
        keyUrl: 'https://platform.kimi.ai/console/api-keys',
        docsUrl: 'https://platform.kimi.ai/docs/guide/start-using-kimi-api',
      },
      {
        id: CHINA,
        label: 'China',
        baseUrl: 'https://api.moonshot.cn/v1',
        keyUrl: 'https://platform.kimi.com/console/api-keys',
        docsUrl: 'https://platform.kimi.com/docs/get-api-key',
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'chat-completions',
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://openrouter.ai/api/v1',
        keyUrl: 'https://openrouter.ai/keys',
        docsUrl: 'https://openrouter.ai/docs',
      },
    ],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT (Preview)',
    api: 'chatgpt-responses',
    signInOnly: true,
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.openai.com/v1',
        keyUrl: 'https://chatgpt.com',
        docsUrl: 'https://developers.openai.com',
      },
    ],
  },
];

export function findRegistryProvider(id: string): RegistryProvider | undefined {
  return PROVIDER_REGISTRY.find((provider) => provider.id === id);
}

/** The base URL a registry provider uses by default: its first region. Undefined for any other id. */
export function defaultBaseUrl(provider: string): string | undefined {
  return findRegistryProvider(provider)?.regions[0].baseUrl;
}

/** The region whose base URL is `baseUrl`, or undefined when no region matches exactly. */
export function findRegistryRegion(provider: string, baseUrl: string): ProviderRegion | undefined {
  const registered = findRegistryProvider(provider);
  if (registered === undefined) return undefined;
  const wanted = normalizeBaseUrl(baseUrl);
  return registered.regions.find((region) => normalizeBaseUrl(region.baseUrl) === wanted);
}

/**
 * The canonical form of a base URL: lower-case origin, default port dropped, no trailing slash.
 * A value that does not parse is only trimmed, so the policy can refuse it.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    // An origin drops user information, so a URL that carries any is kept as written and never matches.
    if (trimmed.includes('@') || url.search !== '' || url.hash !== '') return trimmed;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

/** The URL of one endpoint under a base URL, such as `chat/completions` or `models`. */
export function endpointUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${path}`;
}

export type EndpointVerdict =
  | {
      readonly allowed: true;
      readonly kind: 'registry' | 'loopback' | 'public';
      /** `scheme://host[:port]`, lower-cased by the URL parser. */
      readonly origin: string;
      /** The path of the base URL with no trailing slash, such as `/v1`. */
      readonly basePath: string;
    }
  | {
      readonly allowed: false;
      readonly code: 'BASE_URL_INSECURE' | 'BASE_URL_REFUSED' | 'CONSENT_REQUIRED';
      readonly reason: string;
    };

export interface EndpointOptions {
  /**
   * The owner has confirmed this public endpoint (S8, PLAN-v4 §6c). It is needed for a public custom endpoint, and it
   * changes nothing else: a registry provider, a loopback server and a private address keep their rules.
   */
  readonly consentToPublicEndpoint?: boolean;
}

/**
 * The endpoint policy for every profile (PLAN-v4 §6a, §6c). It is pure: DNS checks for a loopback host name happen in
 * the broker, at connection time.
 *
 * - A loopback profile (`127.0.0.1` or `localhost`, `http` or `https`) is allowed for a custom endpoint only, with no
 *   key required (D8). `[::1]` is refused (S4).
 * - A registry provider may use only its own region URLs, over `https` (S5 region choice).
 * - A public custom endpoint is allowed over `https` only with the owner's consent (S8). A private, link-local or
 *   internal address is refused even with consent.
 */
export function evaluateEndpoint(
  provider: string,
  baseUrl: string,
  options: EndpointOptions = {},
): EndpointVerdict {
  const url = parseUrl(baseUrl);
  if (url === undefined) {
    return refuse('BASE_URL_REFUSED', 'The base URL must be a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refuse('BASE_URL_REFUSED', 'The base URL must use http:// or https://.');
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('BASE_URL_REFUSED', 'The base URL must not contain a user name or password.');
  }
  if (url.search !== '' || url.hash !== '') {
    return refuse('BASE_URL_REFUSED', 'The base URL must not contain a query or a fragment.');
  }
  if (url.hostname === '[::1]') {
    return refuse('BASE_URL_REFUSED', 'IPv6 loopback is not allowed for local models.');
  }
  if (isLoopbackHostname(url.hostname)) {
    if (!isCustomProviderId(provider)) {
      return refuse('BASE_URL_REFUSED', 'Only a custom endpoint may use a local address.');
    }
    return allowedVerdict('loopback', url);
  }
  if (url.protocol !== 'https:') {
    return refuse('BASE_URL_INSECURE', 'A remote endpoint must use https://.');
  }
  if (isCustomProviderId(provider)) {
    if (isPrivateOrInternalHost(url.hostname)) {
      return refuse(
        'BASE_URL_REFUSED',
        'A custom endpoint may not name a private, link-local or internal address.',
      );
    }
    if (options.consentToPublicEndpoint !== true) {
      return refuse(
        'CONSENT_REQUIRED',
        'A public endpoint needs your explicit consent before any key is sent to it.',
      );
    }
    return allowedVerdict('public', url);
  }
  if (findRegistryRegion(provider, baseUrl) === undefined) {
    return refuse('BASE_URL_REFUSED', 'The base URL is not one of the regions of this provider.');
  }
  return allowedVerdict('registry', url);
}

/** A host that is never a public endpoint: local names, private and link-local addresses, and cloud metadata. */
export function isPrivateOrInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata' || host === 'metadata.google.internal') return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  return host.includes(':') ? isPrivateIpv6(host) : isPrivateIpv4(host);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  const [first = -1, second = -1] = numbers;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

function allowedVerdict(kind: 'registry' | 'loopback' | 'public', url: URL): EndpointVerdict {
  return {
    allowed: true,
    kind,
    origin: url.origin,
    basePath: url.pathname.replace(/\/+$/, ''),
  };
}

function refuse(
  code: 'BASE_URL_INSECURE' | 'BASE_URL_REFUSED' | 'CONSENT_REQUIRED',
  reason: string,
): EndpointVerdict {
  return { allowed: false, code, reason };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

/** The host literal is exactly `127.0.0.1` or `localhost`. `[::1]` is handled by the caller. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}
