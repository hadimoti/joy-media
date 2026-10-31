import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

const MAX_FORWARDED_HEADER_LENGTH = 4_096;
const MAX_FORWARDED_HOPS = 32;
const MAX_TRUSTED_PROXY_ADDRESSES = 64;

export type ClientAddressResolver = (request: IncomingMessage) => string;

export interface ClientAddressResolverOptions {
  /** Exact IP addresses of reverse proxies allowed to supply X-Forwarded-For. */
  readonly trustedProxyAddresses?: readonly string[];
}

/**
 * Parses the non-secret trusted-proxy allow-list. Invalid entries fail startup
 * rather than silently widening or weakening the trust boundary.
 */
export function trustedProxyAddressesFromEnv(
  value = process.env.JOY_MEDIA_TRUSTED_PROXY_ADDRESSES,
): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_PROXY_ADDRESSES || entries.some((entry) => entry.length === 0)) {
    throw new Error('JOY_MEDIA_TRUSTED_PROXY_ADDRESSES is invalid');
  }
  return normalizeTrustedProxyAddresses(entries);
}

/**
 * Resolves a stable client address for abuse controls. X-Forwarded-For is
 * accepted only when the direct socket peer is explicitly trusted. For a
 * multi-proxy chain, the nearest untrusted hop is authoritative; entries to
 * its left are untrusted input and cannot select a different bucket.
 */
export function createClientAddressResolver(
  options: ClientAddressResolverOptions = {},
): ClientAddressResolver {
  const trustedAddresses = normalizeTrustedProxyAddresses(options.trustedProxyAddresses ?? []);
  const trusted = new BlockList();
  for (const address of trustedAddresses) trusted.addAddress(address, ipType(address));

  return (request) => {
    const peer = normalizeIpAddress(request.socket.remoteAddress);
    if (peer === undefined) return 'unknown';
    if (!trusted.check(peer, ipType(peer))) return peer;

    const forwarded = forwardedAddresses(request.headers['x-forwarded-for']);
    if (forwarded === undefined || forwarded.length === 0) return peer;
    for (let index = forwarded.length - 1; index >= 0; index -= 1) {
      const address = forwarded[index]!;
      if (!trusted.check(address, ipType(address))) return address;
    }
    return forwarded[0]!;
  };
}

function normalizeTrustedProxyAddresses(values: readonly string[]): readonly string[] {
  if (values.length > MAX_TRUSTED_PROXY_ADDRESSES) {
    throw new Error('trusted proxy address limit exceeded');
  }
  const normalized = values.map(normalizeIpAddress);
  if (normalized.some((value) => value === undefined)) {
    throw new Error('trusted proxy addresses must be IP literals');
  }
  return [...new Set(normalized as string[])];
}

function forwardedAddresses(
  value: string | readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return [];
  const raw = typeof value === 'string' ? value : value.join(',');
  if (raw.length > MAX_FORWARDED_HEADER_LENGTH) return undefined;
  const entries = raw.split(',').map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > MAX_FORWARDED_HOPS ||
    entries.some((entry) => entry.length === 0)
  ) {
    return undefined;
  }
  const normalized = entries.map(normalizeIpAddress);
  return normalized.some((entry) => entry === undefined)
    ? undefined
    : (normalized as readonly string[]);
}

function normalizeIpAddress(value: string | undefined): string | undefined {
  const address = value?.trim();
  if (address === undefined || address.length === 0 || address.includes('%')) return undefined;
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return undefined;
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

function ipType(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 4 ? 'ipv4' : 'ipv6';
}
