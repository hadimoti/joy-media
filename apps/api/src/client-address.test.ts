import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createClientAddressResolver, trustedProxyAddressesFromEnv } from './client-address.js';

describe('client address resolution', () => {
  it('ignores spoofed forwarding headers from an untrusted direct peer', () => {
    const resolve = createClientAddressResolver();
    expect(resolve(request('203.0.113.10', '198.51.100.7'))).toBe('203.0.113.10');
  });

  it('uses the nearest untrusted address behind an explicitly trusted proxy chain', () => {
    const resolve = createClientAddressResolver({
      trustedProxyAddresses: ['127.0.0.1', '10.0.0.2'],
    });
    expect(resolve(request('127.0.0.1', '198.51.100.7, 10.0.0.2'))).toBe('198.51.100.7');

    const onlyEdgeTrusted = createClientAddressResolver({
      trustedProxyAddresses: ['127.0.0.1'],
    });
    expect(onlyEdgeTrusted(request('127.0.0.1', '198.51.100.7, 10.0.0.2'))).toBe('10.0.0.2');
  });

  it('falls back to the trusted socket peer when the forwarding chain is malformed', () => {
    const resolve = createClientAddressResolver({ trustedProxyAddresses: ['127.0.0.1'] });
    expect(resolve(request('127.0.0.1', '198.51.100.7, not-an-ip'))).toBe('127.0.0.1');
    expect(resolve(request('127.0.0.1', '198.51.100.7,'))).toBe('127.0.0.1');
  });

  it('canonicalizes equivalent IPv6 forms into one stable bucket key', () => {
    const resolve = createClientAddressResolver({ trustedProxyAddresses: ['::1'] });
    expect(resolve(request('0:0:0:0:0:0:0:1', '2001:0db8:0:0:0:0:0:1'))).toBe('2001:db8::1');
  });

  it('strictly parses and deduplicates the trusted-proxy environment contract', () => {
    expect(trustedProxyAddressesFromEnv(undefined)).toEqual([]);
    expect(trustedProxyAddressesFromEnv('127.0.0.1, ::1,127.0.0.1')).toEqual(['127.0.0.1', '::1']);
    expect(() => trustedProxyAddressesFromEnv('127.0.0.1,')).toThrow(/invalid/);
    expect(() => trustedProxyAddressesFromEnv('proxy.internal')).toThrow(/IP literals/);
  });
});

function request(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  } as IncomingMessage;
}
