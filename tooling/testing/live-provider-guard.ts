import http from 'node:http';
import https from 'node:https';

const BLOCKED_PROVIDER_HOSTS = new Set([
  'openrouter.ai',
  'api.kilo.ai',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'joyst.ir',
]);
const blockedMessage = 'live provider call blocked in tests';

function isBlockedProvider(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : input.toString();
  try {
    return BLOCKED_PROVIDER_HOSTS.has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (isBlockedProvider(input)) throw new Error(blockedMessage);
  return originalFetch(input, init);
}) as typeof fetch;

function guardNodeRequest<T extends typeof http.request>(request: T): T {
  return ((...args: Parameters<T>) => {
    const first = args[0] as unknown;
    const url =
      first instanceof URL
        ? first
        : typeof first === 'string'
          ? new URL(first)
          : first && typeof first === 'object'
            ? new URL(
                `${(first as { protocol?: string }).protocol ?? 'http:'}//${(first as { hostname?: string; host?: string }).hostname ?? (first as { host?: string }).host ?? ''}`,
              )
            : undefined;
    if (url && BLOCKED_PROVIDER_HOSTS.has(url.hostname.toLowerCase()))
      throw new Error(blockedMessage);
    return request(...args);
  }) as T;
}

http.request = guardNodeRequest(http.request);
https.request = guardNodeRequest(https.request as typeof http.request) as typeof https.request;
