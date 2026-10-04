import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export function isLoopbackSocketPeer(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) !== 6) return false;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (canonical === '::1') return true;
    const mappedV4 = canonical.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mappedV4 !== undefined) return isIP(mappedV4) === 4 && mappedV4.startsWith('127.');
    const mappedHex = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
    if (mappedHex === null) return false;
    const high = Number.parseInt(mappedHex[1]!, 16);
    return high >>> 8 === 127;
  } catch {
    return false;
  }
}

/** Return a process-keyed opaque value; never return the address or request headers. */
export function hashDiagnosticClientKey(clientAddressKey: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(clientAddressKey).digest('hex');
}

export function createClientKeyDiagnosticResponse(
  remoteAddress: string | undefined,
  clientAddress: string,
  secret: Uint8Array,
):
  | { readonly status: 200; readonly body: { readonly clientKey: string } }
  | {
      readonly status: 404;
      readonly body: { readonly error: { readonly code: 'ROUTE_NOT_FOUND' } };
    } {
  if (!isLoopbackSocketPeer(remoteAddress)) {
    return { status: 404, body: { error: { code: 'ROUTE_NOT_FOUND' } } };
  }
  return {
    status: 200,
    body: { clientKey: hashDiagnosticClientKey(clientAddress, secret) },
  };
}
