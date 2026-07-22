import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ControlPlaneError, type Actor, type ControlPlane } from './control-plane.js';

export interface ApiAuthentication {
  authenticate(request: IncomingMessage): Actor | undefined | Promise<Actor | undefined>;
}

export interface ControlPlaneHttpServerOptions {
  readonly controlPlane: ControlPlane;
  readonly authentication: ApiAuthentication;
}

/**
 * Versioned transport boundary for the control-plane contract. Authentication
 * is injected so the public service can use the shared JOY identity boundary;
 * this module deliberately does not contain a header/token fallback.
 */
export function createControlPlaneHttpServer(options: ControlPlaneHttpServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      await route(options, request, response);
    } catch (error) {
      respondError(response, error);
    }
  });
}

async function route(
  options: ControlPlaneHttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://joy-media.invalid');
  if (request.method === 'GET' && url.pathname === '/health') {
    respondJson(response, 200, { ok: true, service: 'joy-media-api', controlPlane: true });
    return;
  }
  if (!url.pathname.startsWith('/v1/')) {
    respondJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND' } });
    return;
  }

  const actor = await options.authentication.authenticate(request);
  if (actor === undefined) throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');

  if (request.method === 'POST' && url.pathname === '/v1/projects') {
    const body = await readJson(request);
    respondJson(response, 201, {
      data: await options.controlPlane.createProject(
        actor,
        requiredString(body, 'id'),
        requiredString(body, 'title'),
      ),
    });
    return;
  }

  const workerPairMatch = /^\/v1\/workers\/([^/]+)\/pair$/.exec(url.pathname);
  if (request.method === 'POST' && workerPairMatch !== null) {
    const [, workerId] = workerPairMatch;
    respondJson(response, 200, {
      data: await options.controlPlane.pairWorker(actor, decodeURIComponent(workerId!)),
    });
    return;
  }

  const jobMatch = /^\/v1\/projects\/([^/]+)\/jobs$/.exec(url.pathname);
  if (request.method === 'POST' && jobMatch !== null) {
    const body = await readJson(request);
    respondJson(response, 201, {
      data: await options.controlPlane.enqueue(
        actor,
        requiredString(body, 'id'),
        decodeURIComponent(jobMatch[1]!),
        requiredString(body, 'type'),
      ),
    });
    return;
  }

  const leaseMatch = /^\/v1\/workers\/([^/]+)\/leases$/.exec(url.pathname);
  if (request.method === 'POST' && leaseMatch !== null) {
    const body = await readJson(request);
    const durationMs = optionalPositiveInteger(body, 'durationMs') ?? 30_000;
    const job = await options.controlPlane.lease(
      decodeURIComponent(leaseMatch[1]!),
      Date.now(),
      durationMs,
    );
    respondJson(response, 200, { data: job ?? null });
    return;
  }

  const completeMatch = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === 'POST' && completeMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.complete(
        decodeURIComponent(completeMatch[1]!),
        decodeURIComponent(completeMatch[2]!),
      ),
    });
    return;
  }

  const eventsMatch = /^\/v1\/projects\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method === 'GET' && eventsMatch !== null) {
    const cursor = optionalCursor(url.searchParams.get('cursor'));
    respondJson(response, 200, {
      data: await options.controlPlane.eventsAfter(
        actor,
        decodeURIComponent(eventsMatch[1]!),
        cursor,
      ),
    });
    return;
  }

  respondJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND' } });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ControlPlaneError('REQUEST_INVALID', 'request body must be valid JSON object');
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
  return value;
}

function optionalPositiveInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a positive integer`);
  return value;
}

function optionalCursor(value: string | null): number {
  if (value === null) return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ControlPlaneError('REQUEST_INVALID', 'cursor must be a non-negative integer');
  return cursor;
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof ControlPlaneError) {
    const status =
      error.code === 'AUTH_REQUIRED' ? 401 : error.code === 'REQUEST_INVALID' ? 400 : 409;
    respondJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  respondJson(response, 500, { error: { code: 'INTERNAL_ERROR' } });
}
