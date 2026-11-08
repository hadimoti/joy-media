import { describe, expect, it } from 'vitest';
import { isPrivateOrInternalHost } from './registry.js';

describe('internal address names (S8 item 4)', () => {
  it.each([
    'localhost',
    'api.internal',
    'metadata.google.internal',
    '127.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '0.0.0.0',
    '[::]',
    '[::1]',
    '[fd00::1]',
    '[fe80::1]',
    '[ff02::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:10.0.0.1]',
    '[::ffff:7f00:1]',
    // IPv4 carried in an address prefix that a router or a NAT64 gateway can deliver to (S8 item 4, extended).
    '[::7f00:1]',
    '[::a00:1]',
    '[::ffff:0:a00:1]',
    '[64:ff9b::a9fe:a9fe]',
    '[64:ff9b:1::a00:1]',
    '[64:ff9b:1::5db8:d822]',
    '[2002:c0a8:101::1]',
    '[2002:5db8:d822::1]',
    '[0:0:0:0:0:0:7f00:1]',
    '[0:0:0:0:ffff:0:a00:1]',
    '[0064:ff9b:0:0:0:0:a9fe:a9fe]',
    // Upper-case spellings are judged like lower-case ones, and a dotted NAT64 tail is read as its IPv4 address.
    '[FD00::1]',
    '[FE80::1]',
    '[64:FF9B::A9FE:A9FE]',
    '[2002:C0A8:101::1]',
    '[::FFFF:7F00:1]',
    '[64:ff9b::192.168.1.1]',
    // The IPv4-compatible range refuses a public IPv4 it carries, as the 6to4 and local-use prefixes do.
    '[::5db8:d822]',
  ])('refuses %s', (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(true);
  });

  it.each([
    // Malformed text is not an address, so it is not judged private; a loosened parser guard would change that.
    '[64:ff9b::a9fe::a9fe]',
    '[64:ff9b:0:0:0:0:0:a9fe:a9fe]',
    '[64:ff9b:0:a9fe:a9fe]',
    '[64:ff9b:0:0:0:0:0::a9fe]',
    '[64:ff9b::a9fe:]',
    '[64:ff9b::1.2.3.4:5]',
    '[64:ff9b::256.1.1.1]',
    '[1:2:3:4:5:6:7::8]',
  ])('does not judge malformed IPv6 text %s private', (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(false);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '[2606:4700:4700::1111]',
    '[2001:4860:4860::8888]',
    '[::ffff:93.184.216.34]',
    // A NAT64 or translated address is judged by the IPv4 it carries: a DNS64 network returns these for public servers.
    '[64:ff9b::5db8:d822]',
    '[64:ff9b::808:808]',
    '[::ffff:0:5db8:d822]',
    '[64:ff9b::8.8.8.8]',
    '[64:FF9B::5DB8:D822]',
    '[::FFFF:0:5DB8:D822]',
    'api.example.com',
  ])('allows the public %s', (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(false);
  });
});
