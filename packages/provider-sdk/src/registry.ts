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
  'xai',
  'deepseek',
  'kilo',
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

/**
 * The authentication a provider officially permits for a third-party app (PLAN-v4 §6d-1).
 *
 * - `api-key`: the owner brings a key from the provider's own console.
 * - `subscription-sign-in`: the owner signs in with a paid plan. Only a provider whose §6d-1 row permits it may offer
 *   it, and only where the provider permits it for third-party apps.
 * - `none`: no credential at all. A local model on loopback (D8).
 */
export type ProviderAuthMethod = 'api-key' | 'subscription-sign-in' | 'none';

/**
 * One row of the §6d-1 table: the authentication a provider permits, with the source that says so.
 *
 * The facts come from the PLAN-v4 §6d-1 table (research of 2026-10-29). A row that is not confirmed is marked
 * `unverified`, and a provider whose generic auth-method selection is gated is marked `gated`; a dedicated
 * sign-in surface may still use a separate setup path.
 */
export interface ProviderAuthRule {
  /** The authentication methods this provider permits. Never empty. */
  readonly methods: readonly ProviderAuthMethod[];
  /** Where the fact was read: the §6d-1 row and its basis. */
  readonly source: string;
  /** The date the source was read. */
  readonly sourceDate: string;
  /** True when generic auth-method selection is gated for this provider (PLAN-v4 §6d); dedicated sign-in flows may use separate setup paths. */
  readonly gated?: true;
  /** True when the row is a research gap: the fact is not confirmed. */
  readonly unverified?: true;
  /** What the source says, in one line. */
  readonly note: string;
}

export type ProviderRegionId =
  | 'international'
  | 'china'
  | 'code-international'
  | 'oauth-international';

/**
 * The OAuth token can use xAI's public API base for inference because the attended 2026-10-31 probe
 * listed models and completed a chat completion there without a special header.
 * Source: D22 step 4 probe evidence.
 */
export const XAI_OAUTH_INFERENCE_BASE_URL = 'https://api.x.ai/v1';

export interface ProviderRegion {
  readonly id: ProviderRegionId;
  readonly label: string;
  /** Exact base URL. A profile must use one of these strings, with any trailing slash removed. */
  readonly baseUrl: string;
  /** Where the owner creates a key. Opened only by an explicit click. */
  readonly keyUrl: string;
  readonly docsUrl: string;
  /**
   * OAuth-only regions stay out of API-key setup; an omitted route means API-key.
   * Source: D22 step 2 brief (2026-10-30).
   */
  readonly route?: 'api-key' | 'oauth';
}

export interface RegistryProvider {
  readonly id: RegistryProviderId;
  readonly label: string;
  readonly api: ProviderApi;
  readonly regions: readonly [ProviderRegion, ...ProviderRegion[]];
  /** Offered only for sign-in, never as an API-key provider (ChatGPT, PLAN-v4 §6d). */
  readonly signInOnly?: true;
  /** The authentication this provider permits, with its source and date (PLAN-v4 §6d-1). */
  readonly auth: ProviderAuthRule;
}

const INTERNATIONAL = 'international';
const CHINA = 'china';

export const PROVIDER_REGISTRY: readonly RegistryProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'chat-completions',
    auth: {
      methods: ['api-key'],
      source: "PLAN-v4 §6d-1 table, row 'OpenAI (API platform)': the OpenAI API",
      sourceDate: '2026-10-29',
      note: 'An API key from the OpenAI API platform. No subscription sign-in is offered.',
    },
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
    auth: {
      methods: ['api-key'],
      source: "PLAN-v4 §6d-1 table, row 'Grok (xAI)': xAI's API key guides (secondary)",
      sourceDate: '2026-10-29',
      note: 'An API key, sent as a Bearer token. The source in §6d-1 is secondary reporting.',
    },
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
    auth: {
      methods: ['api-key'],
      source:
        "PLAN-v4 §6d-1 table, row 'Claude (Anthropic)': Anthropic's February 2026 policy bars third-party apps from consumer-plan OAuth",
      sourceDate: '2026-10-29',
      note: 'An API key from the Anthropic Console. No subscription sign-in. §6d-1 notes the basis as secondary reporting.',
    },
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
    auth: {
      methods: ['api-key', 'subscription-sign-in'],
      source:
        "PLAN-v4 §6d-1 table, row 'MiniMax': MiniMax platform docs list its own tools for Coding Plan keys (sk-cp-) but do not establish JOY Media's commercial eligibility",
      sourceDate: '2026-10-30',
      gated: true,
      unverified: true,
      note: 'MiniMax documents API-key use, but JOY Media\'s eligibility for customer-supplied Coding Plan (sk-cp-) and M Plan API keys remains unverified, so generic auth-method selection stays gated. This metadata gate does not disable the desktop API-key entry form or CLI MiniMax-key profile path, and it does not authorize customer-key use. D20 also permits device-code sign-in; the OpenClaw public client is the default until JOY registers its own configurable client ID.',
    },
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
    auth: {
      methods: ['api-key'],
      source:
        "PLAN-v4 §6d-1 table, row 'Gemini (Google)': Google's key guide, https://ai.google.dev/gemini-api/docs/api-key (read 2026-10-29)",
      sourceDate: '2026-10-29',
      note: 'An API key only; end-user OAuth to the public Gemini API is not confirmed. The current key type is an auth key: every new AI Studio key is created as an auth key, an unrestricted key must be secured to keep working, and dormant unrestricted keys are blocked from May 7, 2026.',
    },
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
    auth: {
      methods: ['api-key', 'subscription-sign-in'],
      source:
        "PLAN-v4 D21 owner route (2026-10-30), plus MoonshotAI's first-party Kimi Code CLI device-OAuth implementation",
      sourceDate: '2026-10-30',
      gated: true,
      unverified: true,
      note: 'The owner-selected local route is Kimi Code OAuth; sign-in and model listing were observed, while inference is not yet verified. The separate Moonshot Platform API-key regions remain available.',
    },
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
      {
        id: 'code-international',
        label: 'Kimi Code (International)',
        baseUrl: 'https://api.kimi.ai/coding/v1',
        keyUrl: 'https://www.kimi.ai/code',
        docsUrl: 'https://www.kimi.com/code/docs/en/',
        // D22 step 2 assigns this base to OAuth, not API-key setup.
        // Source: D22 step 2 brief (2026-10-30).
        route: 'oauth',
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'chat-completions',
    auth: {
      methods: ['api-key'],
      source:
        "PLAN-v4 §6d-1 table, row 'OpenRouter': §6d, and owner decision D20 (2026-10-29): sign-in is offered to ChatGPT and MiniMax only",
      sourceDate: '2026-10-29',
      note: 'An API key (BYOK) only, on the OpenAI-compatible /api/v1 base URL. D20 withdrew the §6d PKCE sign-in, which was removed from the app; the key comes from the OpenRouter console. OpenRouter is optional and never a default.',
    },
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
    auth: {
      methods: ['subscription-sign-in'],
      source:
        "PLAN-v4 §6d-1 table, row 'ChatGPT plan': the OpenAI sign-in-with-ChatGPT terms. A paid or hosted app needs OpenAI clearance",
      sourceDate: '2026-10-29',
      gated: true,
      note: 'The supported OpenAI sign-in flow for a ChatGPT plan. Generic auth-method selection remains gated, but the dedicated desktop sign-in panel offers ChatGPT and uses SIWC dynamic client registration when chatGptClientId is undefined (PLAN-v4 §6d-3).',
    },
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
  {
    id: 'xai',
    label: 'xAI (Grok)',
    api: 'chat-completions',
    auth: {
      methods: ['api-key', 'subscription-sign-in'],
      source:
        'Owner decision D22 (2026-10-30), xAI API reference https://docs.x.ai/docs/api-reference, Grok Build authentication guide https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md, and the attended D22 step 4 probe (2026-10-31)',
      sourceDate: '2026-10-31',
      note: 'The attended xAI OAuth probe on 2026-10-31 confirmed that an api:access token can use https://api.x.ai/v1, list models, and complete inference; the base, subscription entitlement, and model access are verified.',
    },
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.x.ai/v1',
        keyUrl: 'https://console.x.ai',
        docsUrl: 'https://docs.x.ai/docs/api-reference',
      },
      {
        id: 'oauth-international',
        label: 'OAuth inference (xAI API)',
        baseUrl: XAI_OAUTH_INFERENCE_BASE_URL,
        keyUrl: 'https://console.x.ai',
        docsUrl: 'https://docs.x.ai/docs/api-reference',
        // The attended probe confirmed xAI's public API base accepts the OAuth bearer for inference.
        // Source: D22 step 4 probe evidence (2026-10-31).
        route: 'oauth',
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'chat-completions',
    auth: {
      methods: ['api-key'],
      source:
        'D22 follow-up (2026-10-30), DeepSeek OpenAI-compatible integration guide https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/',
      sourceDate: '2026-10-30',
      note: 'OpenAI-compatible API-key setup uses the provider base URL without a /v1 suffix.',
    },
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://api.deepseek.com',
        keyUrl: 'https://platform.deepseek.com/api_keys',
        docsUrl: 'https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/',
      },
    ],
  },
  {
    id: 'kilo',
    label: 'Kilo Gateway',
    api: 'chat-completions',
    auth: {
      methods: ['api-key'],
      source:
        'D22 follow-up (2026-10-30), Kilo Gateway API reference https://kilo.ai/docs/gateway/api-reference',
      sourceDate: '2026-10-30',
      note: 'The Kilo Gateway uses an API key with its OpenAI-compatible gateway base URL.',
    },
    regions: [
      {
        id: INTERNATIONAL,
        label: 'International',
        baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
        keyUrl: 'https://kilo.ai',
        docsUrl: 'https://kilo.ai/docs/gateway/api-reference',
      },
    ],
  },
];

export function findRegistryProvider(id: string): RegistryProvider | undefined {
  return PROVIDER_REGISTRY.find((provider) => provider.id === id);
}

/**
 * The authentication a custom OpenAI-compatible endpoint permits (PLAN-v4 §6d-1, rows 'OpenAI-compatible endpoint' and
 * 'Local model (LM Studio)').
 */
export const CUSTOM_PROVIDER_AUTH: ProviderAuthRule = {
  methods: ['api-key', 'none'],
  source:
    "PLAN-v4 §6d-1 table, rows 'OpenAI-compatible endpoint' and 'Local model (LM Studio)': §6c and D8",
  sourceDate: '2026-10-29',
  note: 'A key, or none at all for a local model on loopback (D8). A public endpoint waits for the S8 consent, which is still undecided.',
};

/** The authentication a provider permits. An unknown id permits nothing. */
export function permittedAuthMethods(provider: string): readonly ProviderAuthMethod[] {
  if (isCustomProviderId(provider)) return CUSTOM_PROVIDER_AUTH.methods;
  return findRegistryProvider(provider)?.auth.methods ?? [];
}

/** True when the provider permits this authentication method. */
export function isAuthMethodPermitted(provider: string, method: ProviderAuthMethod): boolean {
  return permittedAuthMethods(provider).includes(method);
}

/** True when generic auth-method selection is gated for this provider (PLAN-v4 §6d). */
export function isAuthGated(provider: string): boolean {
  if (isCustomProviderId(provider)) return false;
  return findRegistryProvider(provider)?.auth.gated === true;
}

/**
 * The methods shown by generic auth-method selection: permitted methods unless the provider is auth-gated.
 * A dedicated provider sign-in surface may still list that provider and enforce its own setup in the sign-in flow.
 */
export function offeredAuthMethods(provider: string): readonly ProviderAuthMethod[] {
  if (isAuthGated(provider)) return [];
  return permittedAuthMethods(provider);
}

/**
 * The registry providers that permit subscription sign-in under the owner-selected local routes: ChatGPT, Kimi Code,
 * MiniMax, and xAI. The desktop panel runs each provider's dedicated flow; generic profile auth selection remains
 * separately gated where the provider row says so.
 *
 * The sign-in surface is built from this list, so API-key-only providers do not offer a sign-in. It reads the
 * *permitted* methods, not `offeredAuthMethods()`: a provider may appear here while its generic auth methods remain
 * gated for profile setup.
 */
export function signInProviders(): readonly RegistryProviderId[] {
  return PROVIDER_REGISTRY.filter((provider) =>
    provider.auth.methods.includes('subscription-sign-in'),
  ).map((provider) => provider.id);
}

/** True when the provider permits a subscription sign-in, so the sign-in surface may offer it. */
export function isSignInProvider(provider: string): provider is RegistryProviderId {
  return signInProviders().includes(provider as RegistryProviderId);
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
