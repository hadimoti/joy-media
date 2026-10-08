import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const DEFAULT_CA_PATH = '/etc/ssl/joyst/origincertificate.pem';

export function parseSmokeArgs(argv, env = process.env) {
  let baseUrl = env.JOY_GATEWAY_BASE_URL ?? 'https://joyst.ir/api/v1/agent';
  let host = env.JOY_GATEWAY_HOST ?? 'joyst.ir';
  let edgeAddr = env.JOY_MEDIA_EDGE_ADDR;
  let caPath = env.JOY_MEDIA_CA_FILE ?? env.NODE_EXTRA_CA_CERTS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url' && argv[index + 1]) baseUrl = argv[++index];
    else if (arg === '--host' && argv[index + 1]) host = argv[++index];
    else if (arg === '--edge-addr' && argv[index + 1]) edgeAddr = argv[++index];
    else if (arg === '--ca' && argv[index + 1]) caPath = argv[++index];
    else throw new Error(`Unknown or incomplete smoke argument: ${arg}`);
  }
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Gateway smoke base URL must use HTTP or HTTPS.');
  if (url.protocol === 'https:') {
    if (!edgeAddr)
      throw new Error('JOY_MEDIA_EDGE_ADDR or --edge-addr is required for HTTPS smoke.');
    edgeAddr = normalizeIpLiteral(edgeAddr);
  }
  if (!caPath && existsSync(DEFAULT_CA_PATH)) caPath = DEFAULT_CA_PATH;
  if (caPath && !existsSync(caPath)) throw new Error(`CA file does not exist: ${caPath}`);
  return { baseUrl: url.toString().replace(/\/$/, ''), host, edgeAddr, caPath };
}

export function normalizeIpLiteral(value) {
  const normalized = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (!isIP(normalized))
    throw new Error(`Gateway smoke edge address must be an IP address: ${value}`);
  return normalized;
}

/** The production free catalog, default first (apps/api/src/joy-free-models.ts). */
export const JOY_FREE_MODEL_IDS = Object.freeze([
  'google/gemma-4-31b-it:free',
  'thinkingmachines/inkling:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free',
]);

export function modelsCatalogIssue(response) {
  try {
    const parsed = typeof response === 'string' ? JSON.parse(response) : response;
    const models = parsed?.models;
    if (!Array.isArray(models)) return 'GET /models response is not JSON with a models array.';
    const ids = models.map((model) => model?.id);
    if (
      ids.length !== JOY_FREE_MODEL_IDS.length ||
      ids.some((id, index) => id !== JOY_FREE_MODEL_IDS[index])
    )
      return `GET /models must list exactly the free catalog: ${JOY_FREE_MODEL_IDS.join(', ')}.`;
    if (models[0]?.isDefault !== true || models.filter((model) => model?.isDefault).length !== 1)
      return `GET /models must mark only ${JOY_FREE_MODEL_IDS[0]} as the default.`;
    return undefined;
  } catch {
    return 'GET /models response is not valid JSON.';
  }
}

export async function requestGateway(baseUrl, path, options = {}, host = 'joyst.ir', tls = {}) {
  const base = new URL(baseUrl);
  const pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  const body = options.body === undefined ? undefined : String(options.body);
  const response = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      request.destroy(new Error('Gateway smoke request timed out'));
    }, 10_000);
    const transport = base.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: base.protocol,
        hostname: tls.edgeAddr ?? base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        method: options.method ?? 'GET',
        path: `${pathname}${base.search}`,
        servername: host,
        headers: { ...(options.headers ?? {}), Host: host },
        ...(base.protocol !== 'https:' || tls.ca === undefined
          ? {}
          : { ca: Buffer.isBuffer(tls.ca) ? tls.ca : readFileSync(tls.ca) }),
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
