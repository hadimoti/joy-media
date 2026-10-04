import https from 'node:https';

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

export async function requestGateway(baseUrl, path, options = {}, host = 'joyst.ir', tls = {}) {
  const base = new URL(baseUrl);
  const pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  const body = options.body === undefined ? undefined : String(options.body);
  const response = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      request.destroy(new Error('Gateway smoke request timed out'));
    }, 10_000);
    const request = https.request(
      {
        protocol: 'https:',
        hostname: base.hostname,
        port: base.port || 443,
        method: options.method ?? 'GET',
        path: `${pathname}${base.search}`,
        servername: host,
        headers: { ...(options.headers ?? {}), Host: host },
        ...(tls.ca === undefined ? {} : { ca: tls.ca }),
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => {
          clearTimeout(deadline);
          const payload = Buffer.concat(chunks).toString('utf8');
          const headers = {
            get(name) {
              const value = incoming.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : (value ?? null);
            },
          };
          const result = {
            status: incoming.statusCode ?? 0,
            headers,
            async json() {
              return JSON.parse(payload);
            },
            clone() {
              return { json: async () => JSON.parse(payload) };
            },
          };
          resolve(result);
        });
      },
    );
    request.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
  return response;
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
