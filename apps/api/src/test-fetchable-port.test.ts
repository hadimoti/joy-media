import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isFetchBlockedPort, listenOnFetchablePort } from './test-fetchable-port.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('test fetchable port helper', () => {
  it('names the ports that fetch refuses', () => {
    expect(isFetchBlockedPort(6000)).toBe(true);
    expect(isFetchBlockedPort(10080)).toBe(true);
    expect(isFetchBlockedPort(49200)).toBe(false);
  });

  it('returns a loopback port that a fetch can reach', async () => {
    const server = createServer((_request, response) => response.end('reachable'));
    servers.push(server);
    const port = await listenOnFetchablePort(server);
    expect(isFetchBlockedPort(port)).toBe(false);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe('reachable');
  });
});
