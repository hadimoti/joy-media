/**
 * A loopback fake of the MiniMax picture and video routes (T-C08). It answers the current (H3) and legacy routes that
 * the T-C02 adapters call, and the file-download host that a finished video is fetched from. Each route answers from a
 * queue of replies that the test fills, so a test can script queued, running, succeeded, failed and cancelled tasks,
 * a refused key, a missing plan, a balance error, an expired link, an oversize file and a connection dropped mid-body.
 *
 * It is a test double only: no real key, no real provider and no network beyond 127.0.0.1. The request log keeps whether
 * the bearer key was right, never the key itself. Plain Node, no dependencies, so it runs under vitest and node --test.
 */
import { createServer } from 'node:http';
import { URLSearchParams } from 'node:url';

/** The route labels a test queues replies for. `download` is the media host's file route. */
export const GENERATION_ROUTES = Object.freeze([
  'image',
  'image-legacy',
  'video-create',
  'video-create-legacy',
  'video-query',
  'video-query-legacy',
  'video-cancel',
  'file-link',
  'download',
]);

/** Query routes keep answering with their last reply once the queue is empty, so a task can stay "running". */
const STICKY_ROUTES = new Set(['video-query', 'video-query-legacy']);

/** The host the fake file link names. It does not resolve; the test maps it to this server's `/download/` path. */
export const FAKE_MEDIA_HOST = 'https://media.minimax.example';

const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * One scripted reply. JSON routes use `json` (or `text`); `status` defaults to 200. `drop: true` closes the connection
 * without a reply. The download route also takes `body` (bytes), `contentLength` (the length the header declares, which
 * may be larger than the body) and `dropAfterBytes` (close the connection after this many bytes of body).
 */
export function reply(spec) {
  return { ...spec };
}

function routeLabel(method, pathname) {
  if (method === 'POST' && pathname === '/v1/images/generations') return 'image';
  if (method === 'POST' && pathname === '/v1/image_generation') return 'image-legacy';
  if (method === 'POST' && pathname === '/v2/video_generation') return 'video-create';
  if (method === 'POST' && pathname === '/v1/video_generation') return 'video-create-legacy';
  if (method === 'GET' && pathname.startsWith('/v2/query/video_generation/')) return 'video-query';
  if (method === 'GET' && pathname === '/v1/query/video_generation') return 'video-query-legacy';
  if (method === 'DELETE' && pathname.startsWith('/v2/video_generation/')) return 'video-cancel';
  if (method === 'GET' && pathname === '/v1/files/retrieve') return 'file-link';
  if (method === 'GET' && pathname.startsWith('/download/')) return 'download';
  return 'unknown';
}

/** The reply a file-link request gets when the test has not queued one: a link on the fake media host. */
function defaultFileLink(search) {
  const fileId = new URLSearchParams(search).get('file_id') ?? 'file';
  return {
    json: {
      base_resp: { status_code: 0, status_msg: 'success' },
      file: { file_id: fileId, download_url: `${FAKE_MEDIA_HOST}/download/${fileId}.mp4` },
    },
  };
}

const BASE_HEADERS = Object.freeze({ 'cache-control': 'no-store' });

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function sendScripted(response, spec) {
  const status = spec.status ?? 200;
  if (spec.body !== undefined) {
    const declared = spec.contentLength ?? spec.body.byteLength;
    response.writeHead(status, {
      ...BASE_HEADERS,
      'content-type': 'video/mp4',
      'content-length': String(declared),
    });
    if (spec.dropAfterBytes !== undefined) {
      response.write(spec.body.subarray(0, spec.dropAfterBytes));
      // Closing before the declared length is the dropped connection the job manager must survive.
      response.destroy();
      return;
    }
    response.end(spec.body);
    return;
  }
  const text = spec.text ?? (spec.json === undefined ? '' : JSON.stringify(spec.json));
  response.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  });
  response.end(text);
}

/**
 * Starts the fake. `expectedKey` is the bearer key the adapters must send; it is compared, never logged.
 * Returns the origin to point the adapters at, the request log, `reply(label, ...replies)` to queue replies and `close()`.
 */
export async function startGenerationServer({ expectedKey, port = 0 } = {}) {
  if (typeof expectedKey !== 'string' || expectedKey.length === 0) {
    throw new Error('expectedKey is required');
  }
  const queues = new Map(GENERATION_ROUTES.map((label) => [label, []]));
  const lastServed = new Map();
  const requests = [];
  const sockets = new Set();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const label = routeLabel(request.method ?? 'GET', url.pathname);
    let body;
    try {
      body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    } catch {
      response.writeHead(413, { 'content-type': 'text/plain' });
      response.end('request too large');
      return;
    }
    requests.push({
      label,
      method: request.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      authorizationOk: request.headers.authorization === `Bearer ${expectedKey}`,
      body,
    });

    if (label === 'file-link' && (queues.get(label) ?? []).length === 0) {
      sendScripted(response, defaultFileLink(url.search));
      return;
    }

    const queue = queues.get(label);
    let spec;
    if (queue !== undefined && queue.length > 0) {
      spec = queue.shift();
    } else if (STICKY_ROUTES.has(label) && lastServed.has(label)) {
      spec = lastServed.get(label);
    } else {
      // An unscripted call is a visible failure in the test, never a silent success.
      spec = {
        status: 503,
        json: { base_resp: { status_code: 9999, status_msg: 'script exhausted' } },
      };
    }
    lastServed.set(label, spec);

    if (spec.drop === true) {
      request.socket.destroy();
      return;
    }
    sendScripted(response, spec);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind loopback port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    /** Queues replies for a route, in order. Query routes repeat their last reply once the queue is empty. */
    reply(label, ...replies) {
      const queue = queues.get(label);
      if (queue === undefined) throw new Error(`unknown route label: ${label}`);
      queue.push(...replies);
    },
    /** The number of queued replies still waiting for a route. */
    pending(label) {
      return queues.get(label)?.length ?? 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
