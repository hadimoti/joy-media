import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const PROVIDER_CREDENTIAL_ENV_VARS = [
  'OPENROUTER_API_KEY',
  'KILO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'JOY_MEDIA_OPENROUTER_API_KEY',
  'JOY_MEDIA_SESSION_TOKEN',
] as const;

const BLOCKED_PROVIDER_HOSTS = [
  'openrouter.ai',
  'kilo.ai',
  'openai.com',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'joyst.ir',
];
const blockedMessage = 'live provider call blocked in tests';

function isBlockedProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return BLOCKED_PROVIDER_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

for (const key of PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key];

const childGuardPath = fileURLToPath(new URL('./live-provider-guard-child.mjs', import.meta.url));
const childGuardOption = `--import=${pathToFileURL(childGuardPath).href}`;
const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';
if (!existingNodeOptions.includes(childGuardPath))
  process.env.NODE_OPTIONS = `${existingNodeOptions} ${childGuardOption}`.trim();

function isBlockedProvider(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : input.toString();
  try {
    return isBlockedProviderHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (isBlockedProvider(input)) throw new Error(blockedMessage);
  return originalFetch(input, init);
}) as typeof fetch;

function requestHostname(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (first instanceof URL) return first.hostname;
  if (typeof first === 'string') {
    try {
      return new URL(first).hostname;
    } catch {
      return undefined;
    }
  }
  if (first && typeof first === 'object') {
    const options = first as { protocol?: string; hostname?: string; host?: string };
    const hostname = options.hostname ?? options.host;
    if (!hostname) return undefined;
    try {
      return new URL(`${options.protocol ?? 'http:'}//${hostname}`).hostname;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function guardNodeCall<T>(call: T): T {
  return ((...args: unknown[]) => {
    const hostname = requestHostname(args);
    if (hostname && isBlockedProviderHost(hostname)) throw new Error(blockedMessage);
    return Reflect.apply(call as (...args: unknown[]) => unknown, undefined, args);
  }) as T;
}

http.request = guardNodeCall(http.request);
http.get = guardNodeCall(http.get);
https.request = guardNodeCall(https.request);
https.get = guardNodeCall(https.get);
