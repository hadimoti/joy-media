export function parseSmokeArgs(argv, env = process.env) {
  let baseUrl = env.JOY_GATEWAY_BASE_URL ?? 'https://127.0.0.1/api/v1/agent';
  let host = env.JOY_GATEWAY_HOST ?? 'joyst.ir';
  let preCutover = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pre-cutover') preCutover = true;
    else if (arg === '--base-url' && argv[index + 1]) baseUrl = argv[++index];
    else if (arg === '--host' && argv[index + 1]) host = argv[++index];
    else throw new Error(`Unknown or incomplete smoke argument: ${arg}`);
  }
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()))
    throw new Error('Gateway smoke base URL must target a loopback host.');
  return { baseUrl: url.toString().replace(/\/$/, ''), host, preCutover };
}

export async function requestGateway(baseUrl, path, options = {}, host = 'joyst.ir') {
  return globalThis.fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...options,
    signal: globalThis.AbortSignal.timeout(10_000),
    headers: { ...(options.headers ?? {}), Host: host },
  });
}

export async function classifyKeyCheck(response) {
  if (response.status !== 503) return undefined;
  try {
    const data = await response.clone().json();
    return data?.error?.code === 'JOY_AGENT_UNCONFIGURED'
      ? 'OpenRouter key missing: see the credstore step in deploy/joy-media-api.override.conf.'
      : undefined;
  } catch {
    return undefined;
  }
}
