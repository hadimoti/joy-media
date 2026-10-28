import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobProtocolError, type JobOrchestrator } from './job-orchestrator.js';
import { MAX_LOCAL_ORIGINAL_BYTES } from '../main/local-originals.js';

/**
 * Loopback HTTP API that the local Worker process speaks to. It implements the same
 * `/v1/workers/:workerId/...` endpoints the Worker's control-plane client already uses, so the
 * Worker runs unchanged. It binds only to 127.0.0.1 on a random port and every request needs the
 * per-run bearer token, which is handed to the Worker through its environment, never its argv.
 */

const MAX_JSON_BYTES = 64 * 1024;
const MAX_DERIVATIVE_BYTES = 64 * 1024 * 1024;
/**
 * Largest source served over the loopback route. It is the registration limit, so every original
 * that registers can render. The source is read into memory on both sides, so a large file is a
 * real load on the desktop process. Streaming is the follow-up.
 */
export const MAX_LOCAL_SOURCE_BYTES = MAX_LOCAL_ORIGINAL_BYTES;
const MAX_CAPABILITIES = 64;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CAPABILITY_PATTERN = /^[a-z0-9._-]{1,64}$/;
const DERIVATIVE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
};

export interface LocalJobApiOptions {
  readonly orchestrator: JobOrchestrator;
  /** Where accepted derivatives are written. Created on first use. */
  readonly derivativeDirectory: string;
  /** Size in bytes of a registered local file, checked before any read. */
  readonly sourceSize: (refId: string) => Promise<number>;
  /** Reads the bytes of a registered local file. The main process resolves the path, never the Worker. */
  readonly readSource: (refId: string) => Promise<Uint8Array>;
  readonly maxSourceBytes?: number;
  readonly onWarning?: (message: string) => void;
  /** Fixed token for tests. Production always uses a fresh random token per app run. */
  readonly token?: string;
}

export interface LocalJobApi {
  readonly url: string;
  /** Environment the supervisor gives the Worker. The token never goes in argv. */
  readonly workerEnv: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

export async function startLocalJobApi(options: LocalJobApiOptions): Promise<LocalJobApi> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const tokenBuffer = Buffer.from(token);
  const warn = options.onWarning ?? (() => undefined);
  const { orchestrator } = options;

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof JobProtocolError) {
        sendError(response, error.status, error.message);
        return;
      }
      warn(
        `local job API request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      sendError(response, 500, 'internal error');
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAuthorized(request.headers.authorization, tokenBuffer)) {
      sendError(response, 401, 'unauthorized');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = /^\/v1\/workers\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (route === null) {
      sendError(response, 404, 'not found');
      return;
    }
    const workerId = decodeId(route[1]);
    const rest = route[2] ?? '';
    const method = request.method ?? 'GET';

    if (rest === 'hello' && method === 'POST') {
      const body = await readJson(request);
      const capabilities = body.capabilities;
      if (
        !Array.isArray(capabilities) ||
        capabilities.length > MAX_CAPABILITIES ||
        !capabilities.every((item) => typeof item === 'string' && CAPABILITY_PATTERN.test(item))
      )
        throw new JobProtocolError(422, 'invalid capabilities');
      orchestrator.hello(workerId, capabilities as string[]);
      sendData(response, null);
      return;
    }
    if (rest === 'leases' && method === 'POST') {
      const body = await readJson(request);
      const durationMs = typeof body.durationMs === 'number' ? body.durationMs : undefined;
      const leased = orchestrator.lease(workerId, durationMs);
      sendData(
        response,
        leased === undefined
          ? null
          : {
              id: leased.id,
              projectId: 'local',
              type: leased.jobType,
              assetId: leased.refId,
              leaseToken: leased.leaseToken,
              ...(leased.payload === undefined ? {} : { payload: leased.payload }),
            },
      );
      return;
    }
    if (rest === 'preview/next' && method === 'POST') {
      // GPU preview is not part of the local job route; the Worker treats null as "nothing queued".
      sendData(response, null);
      return;
    }
    const jobRoute = /^jobs\/([^/]+)\/(heartbeat|complete|fail|source|derivative)$/.exec(rest);
    if (jobRoute === null) {
      sendError(response, 404, 'not found');
      return;
    }
    const jobId = decodeId(jobRoute[1]);
    const action = jobRoute[2];

    if (action === 'source' && method === 'GET') {
      const job = orchestrator.assertLeaseHolder(
        workerId,
        jobId,
        headerValue(request, 'x-joy-lease-token'),
      );
      const limit = options.maxSourceBytes ?? MAX_LOCAL_SOURCE_BYTES;
      if ((await options.sourceSize(job.refId)) > limit)
        throw new JobProtocolError(413, 'source is larger than the local route allows');
      const bytes = await options.readSource(job.refId);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.byteLength,
        'cache-control': 'no-store',
      });
      response.end(bytes);
      return;
    }
    if (action === 'derivative' && method === 'POST') {
      await acceptDerivative(request, response, workerId, jobId);
      return;
    }
    if (method !== 'POST') {
      sendError(response, 404, 'not found');
      return;
    }
    const body = await readJson(request);
    const leaseToken = typeof body.leaseToken === 'string' ? body.leaseToken : '';
    if (action === 'heartbeat') {
      const progress = typeof body.progress === 'number' ? body.progress : 0;
      sendData(response, orchestrator.heartbeat(workerId, jobId, leaseToken, progress));
      return;
    }
    if (action === 'complete') {
      const result = isRecord(body.result) ? body.result : undefined;
      if (result === undefined || typeof result.kind !== 'string')
        throw new JobProtocolError(422, 'invalid result');
      orchestrator.complete(workerId, jobId, leaseToken, {
        kind: result.kind,
        ...(typeof result.sha256 === 'string' ? { sha256: result.sha256 } : {}),
        ...(typeof result.bytes === 'number' ? { bytes: result.bytes } : {}),
        resultJson: JSON.stringify(result),
      });
      sendData(response, null);
      return;
    }
    if (action === 'fail') {
      const error = typeof body.error === 'string' ? body.error : 'unknown Worker failure';
      orchestrator.fail(workerId, jobId, leaseToken, error);
      sendData(response, null);
      return;
    }
    sendError(response, 404, 'not found');
  }

  async function acceptDerivative(
    request: IncomingMessage,
    response: ServerResponse,
    workerId: string,
    jobId: string,
  ): Promise<void> {
    const leaseToken = headerValue(request, 'x-joy-lease-token');
    orchestrator.assertLeaseHolder(workerId, jobId, leaseToken);
    const mimeType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    const extension = DERIVATIVE_EXTENSIONS[mimeType];
    if (extension === undefined) throw new JobProtocolError(422, 'unsupported derivative type');
    const expectedSha = headerValue(request, 'x-joy-sha256');
    const expectedBytes = Number(headerValue(request, 'x-joy-bytes'));
    const bytes = await readBytes(request, MAX_DERIVATIVE_BYTES);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length < 1 || bytes.length !== expectedBytes || sha256 !== expectedSha)
      throw new JobProtocolError(422, 'derivative bytes do not match their digest');

    await mkdir(options.derivativeDirectory, { recursive: true });
    const path = join(options.derivativeDirectory, `${jobId}-${sha256.slice(0, 16)}.${extension}`);
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    try {
      await rename(temporary, path);
      orchestrator.recordDerivative(workerId, jobId, leaseToken, {
        sha256,
        bytes: bytes.length,
        mimeType,
        path,
      });
    } catch (error) {
      await rm(temporary, { force: true });
      await rm(path, { force: true });
      throw error;
    }
    sendData(response, null);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('local job API did not bind to a TCP port');
  const url = `http://127.0.0.1:${address.port}`;

  // Expired leases are swept on a timer so a Worker that died mid-job never leaves a job "running".
  const sweeper = setInterval(() => {
    try {
      orchestrator.expireLeases();
    } catch (error) {
      warn(`lease sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }, 1_000);
  sweeper.unref();

  return {
    url,
    workerEnv: {
      JOY_MEDIA_API_URL: url,
      JOY_MEDIA_WORKER_LOCAL_TOKEN: token,
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(sweeper);
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function decodeId(raw: string | undefined): string {
  const value = decodeURIComponent(raw ?? '');
  if (!ID_PATTERN.test(value)) throw new JobProtocolError(422, 'invalid identifier');
  return value;
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > limit) throw new JobProtocolError(422, 'payload is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBytes(request, MAX_JSON_BYTES)).toString('utf8');
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JobProtocolError(422, 'body is not JSON');
  }
  if (!isRecord(parsed)) throw new JobProtocolError(422, 'body must be a JSON object');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The Worker client reads `data` from every JSON envelope, so responses use that shape. */
function sendData(response: ServerResponse, data: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ data }));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { message } }));
}
