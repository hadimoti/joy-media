import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCors, corsAllowedOriginsFromEnv } from './cors.js';

// Desktop OTP bug (15 Oct): the packaged renderer (joy-media-app://renderer) preflights
// POST /v1/auth/request-otp; the API answered 401 AUTH_REQUIRED with no CORS headers.
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

async function serve(allowed = corsAllowedOriginsFromEnv({})): Promise<string> {
  server = createServer((req, res) => {
    if (applyCors(req, res, allowed)) return;
    // Stands in for the authenticated router: anything that gets here is "auth required".
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"AUTH_REQUIRED"}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function send(base: string, method: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = httpRequest(`${base}/v1/auth/request-otp`, { method, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    },
  );
}

const preflight = (origin: string) => ({
  origin,
  'access-control-request-method': 'POST',
  'access-control-request-headers': 'content-type',
});

describe('CORS for the desktop renderer', () => {
  it.each(['joy-media-app://renderer', 'https://joyst.ir', 'https://www.joyst.ir'])(
    'answers a preflight from %s with 204 and the allow headers, before auth',
    async (origin) => {
      const response = await send(await serve(), 'OPTIONS', preflight(origin));
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(String(response.headers['access-control-allow-methods'])).toContain('POST');
      expect(String(response.headers['access-control-allow-headers'])).toContain('content-type');
      expect(String(response.headers['access-control-allow-headers'])).toContain('authorization');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers.vary).toBe('Origin');
    },
  );

  it.each(['https://evil.example', 'null', 'file://', 'https://joyst.ir.evil.example'])(
    'refuses a preflight from unknown origin %s with no Access-Control-* headers',
    async (origin) => {
      const response = await send(await serve(), 'OPTIONS', preflight(origin));
      expect(response.status).toBe(403);
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
    },
  );

  it('echoes an allowed origin on the actual request, never a wildcard', async () => {
    const response = await send(await serve(), 'POST', { origin: 'joy-media-app://renderer' });
    expect(response.headers['access-control-allow-origin']).toBe('joy-media-app://renderer');
    const other = await send(await serve(), 'POST', { origin: 'https://evil.example' });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves same-origin requests (no Origin) and plain OPTIONS alone', async () => {
    const base = await serve();
    expect((await send(base, 'POST', {})).headers['access-control-allow-origin']).toBeUndefined();
    expect((await send(base, 'OPTIONS', {})).status).toBe(401);
  });

  it('adds extra origins from JOY_MEDIA_CORS_EXTRA_ORIGINS but ignores * and null', () => {
    const origins = corsAllowedOriginsFromEnv({
      JOY_MEDIA_CORS_EXTRA_ORIGINS: 'https://staging.joyst.ir, *, null',
    });
    expect(origins.has('https://staging.joyst.ir')).toBe(true);
    expect(origins.has('*')).toBe(false);
    expect(origins.has('null')).toBe(false);
  });
});
