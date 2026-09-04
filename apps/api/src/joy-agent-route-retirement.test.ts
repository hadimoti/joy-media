import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import {
  isRetiredJoyAgentRoute,
  JOY_AGENT_RETIRED_ROUTE_RESPONSE,
} from './joy-agent-route-retirement.js';

describe('built-in JOY Agent route retirement', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error === undefined ? resolve() : reject(error))),
            ),
        ),
    );
  });

  it.each([
    '/v1/projects/project-1/creative-brief',
    '/v1/projects/project-1/joy-code/plans',
    '/v1/projects/project-1/creative-brief-opt-in',
    '/v1/projects/project-1/joy-code-opt-in',
  ])('identifies %s as retired', (pathname) => {
    expect(isRetiredJoyAgentRoute(pathname)).toBe(true);
  });

  it('does not catch unrelated project or media routes', () => {
    expect(isRetiredJoyAgentRoute('/v1/projects/project-1/document')).toBe(false);
    expect(isRetiredJoyAgentRoute('/v1/projects/project-1/jobs')).toBe(false);
    expect(JOY_AGENT_RETIRED_ROUTE_RESPONSE).toEqual({
      code: 'JOY_AGENT_BUILT_IN_REQUIRED',
      message: expect.stringContaining('built-in JOY Agent Engine'),
    });
  });

  it('returns 410 for authenticated former reasoning routes without invoking a resolver', async () => {
    const server = createControlPlaneHttpServer({
      controlPlane: new LocalControlPlane(),
      authentication: { authenticate: () => ({ id: 'owner' }) },
      mediaAuth: new DisabledMediaAuth(),
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects/p/joy-code/plans`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'ignored' }),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: JOY_AGENT_RETIRED_ROUTE_RESPONSE,
    });
  });
});
