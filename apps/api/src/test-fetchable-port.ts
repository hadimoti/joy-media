import { once } from 'node:events';
import type { Server } from 'node:http';

/**
 * Ports the Fetch standard refuses: `fetch` rejects them with "bad port" before it connects.
 * This is the WHATWG Fetch bad-port set. Every entry was checked against the undici fetch on
 * Node 24, and a random sample of unlisted ports showed no extra refusals.
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

/**
 * Listens on an OS-assigned loopback port that `fetch` accepts. The dynamic TCP range can include
 * a Fetch-blocked port (on this host it is 1024-65534), and a plain `listen(0)` may return one.
 * Requests to such a server then fail with "fetch failed: bad port" before reaching it. A blocked
 * draw is closed and the server listens again.
 */
export async function listenOnFetchablePort(server: Server, host = '127.0.0.1'): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    server.listen(0, host);
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind TCP');
    if (!isFetchBlockedPort(address.port)) return address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  throw new Error('test server could not bind a fetchable TCP port');
}
