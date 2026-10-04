import http from 'node:http';
import https from 'node:https';

const credentialVariables = [
  'OPENROUTER_API_KEY',
  'KILO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'JOY_MEDIA_OPENROUTER_API_KEY',
  'JOY_MEDIA_SESSION_TOKEN',
];
for (const key of credentialVariables) delete process.env[key];

const blockedDomains = [
  'openrouter.ai',
  'kilo.ai',
  'openai.com',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'joyst.ir',
];
const blockedMessage = 'live provider call blocked in tests';
const blockedHost = (name) => {
  const hostname = name.toLowerCase().replace(/\.$/u, '');
  return blockedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
};

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : (input.url ?? input.toString());
  try {
    if (blockedHost(new URL(raw).hostname)) throw new Error(blockedMessage);
  } catch (error) {
    if (error instanceof Error && error.message === blockedMessage) throw error;
  }
  return originalFetch(input, init);
};

const hostnameOf = (args) => {
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
    const hostname = first.hostname ?? first.host;
    if (!hostname) return undefined;
    try {
      return new URL(`${first.protocol ?? 'http:'}//${hostname}`).hostname;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
const guard = (call) =>
  function guarded(...args) {
    const hostname = hostnameOf(args);
    if (hostname && blockedHost(hostname)) throw new Error(blockedMessage);
    return call(...args);
  };

http.request = guard(http.request);
http.get = guard(http.get);
https.request = guard(https.request);
https.get = guard(https.get);
