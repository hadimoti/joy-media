import type { IncomingMessage } from 'node:http';
import { createControlPlaneHttpServer, LocalControlPlane } from '../apps/api/src/index.js';
import type { ApiAuthentication } from '../apps/api/src/http-server.js';
import type { MediaAuthApi, MediaAuthMethod } from '../apps/api/src/media-auth.js';
import type { PrivateObjectDescriptor, PrivateObjectStore } from '../apps/api/src/index.js';

/** Test-only owner/session. This file is never imported by production builds. */
export const E2E_TOKEN = 'joy-media-e2e-token';
export const E2E_OWNER = 'e2e-owner@example.test';

class MemoryPrivateObjectStore implements PrivateObjectStore {
  readonly #objects = new Map<
    string,
    { readonly descriptor: PrivateObjectDescriptor; readonly bytes: Uint8Array }
  >();

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    this.#objects.set(descriptor.ref, { descriptor, bytes: new Uint8Array(bytes) });
  }

  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    const object = this.#objects.get(descriptor.ref);
    if (object === undefined) throw new Error(`test object ${descriptor.ref} is missing`);
    return new Uint8Array(object.bytes);
  }

  async remove(ref: string): Promise<void> {
    this.#objects.delete(ref);
  }
}

class TestMediaAuth implements MediaAuthApi {
  async requestOtp(_contact: string, _method: MediaAuthMethod): Promise<{ message: string }> {
    return { message: 'Test OTP requested.' };
  }

  async verifyOtp(_contact: string, _method: MediaAuthMethod, _code: string): Promise<string> {
    return E2E_TOKEN;
  }

  async logout(_token: string): Promise<void> {}

  async authenticate(request: IncomingMessage): Promise<{ readonly id: string } | undefined> {
    return bearer(request) === E2E_TOKEN ? { id: E2E_OWNER } : undefined;
  }

  async sessionProfile(request: IncomingMessage): Promise<
    | {
        readonly contact: string;
        readonly method: MediaAuthMethod;
        readonly displayName: string;
        readonly avatarAvailable: false;
      }
    | undefined
  > {
    if (bearer(request) !== E2E_TOKEN) return undefined;
    return {
      contact: E2E_OWNER,
      method: 'gmail',
      displayName: 'JOY E2E',
      avatarAvailable: false,
    };
  }

  async avatarBytes(_request: IncomingMessage): Promise<undefined> {
    return undefined;
  }
}

const authentication: ApiAuthentication = {
  authenticate: (request) => (bearer(request) === E2E_TOKEN ? { id: E2E_OWNER } : undefined),
};

const server = createControlPlaneHttpServer({
  controlPlane: new LocalControlPlane(),
  authentication,
  mediaAuth: new TestMediaAuth(),
  privateObjectStore: new MemoryPrivateObjectStore(),
  // The browser suite intentionally exercises dozens of flows with one
  // disposable owner/IP. Abuse protection is covered by the API transport
  // tests; keep this deterministic harness from turning a long suite into a
  // cascade of unrelated 429s.
  rateLimit: { maxRequests: 100_000 },
  queryObservability: true,
});

server.listen(Number(process.env.JOY_MEDIA_E2E_API_PORT ?? 4174), '127.0.0.1');
server.once('listening', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    process.stderr.write('E2E API failed to bind\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`JOY_MEDIA_E2E_API_READY http://127.0.0.1:${address.port}\n`);
});

const shutdown = () => server.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ')
    ? value.slice('Bearer '.length)
    : undefined;
}
