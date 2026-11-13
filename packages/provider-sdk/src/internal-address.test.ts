import { describe, expect, it } from 'vitest';
import { isPrivateOrInternalHost } from './internal-address.js';

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
    // The deprecated site-local range fec0::/10 is refused with link-local, whatever its case.
    '[fec0::1]',
    '[FEC0::1]',
    '[feff::1]',
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

/*
 * Table-driven checks for each IPv4-carrying IPv6 prefix (T-F07). Each refused row embeds a private or loopback IPv4
 * address; each allowed row embeds 8.8.8.8 or 93.184.216.34, or carries no IPv4 address that a rule judges.
 */
describe('IPv4 embedded in IPv6 prefixes (T-F07)', () => {
  describe('ISATAP (RFC 5214): interface identifier 0000:5efe or 0200:5efe, under any prefix', () => {
    it.each([
      ['0000:5efe with 192.168.1.1', '[2001:db8::5efe:c0a8:101]'],
      ['0000:5efe with 10.0.0.1', '[2001:db8::5efe:a00:1]'],
      ['0000:5efe with 172.16.0.1', '[2001:db8::5efe:ac10:1]'],
      ['0200:5efe with 127.0.0.1', '[2001:db8::200:5efe:7f00:1]'],
      ['0000:5efe with 169.254.169.254', '[2001:db8::5efe:a9fe:a9fe]'],
    ])('refuses ISATAP %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });

    it.each([
      ['0000:5efe with 8.8.8.8', '[2001:db8::5efe:808:808]'],
      ['0200:5efe with 8.8.8.8', '[2001:db8::200:5efe:808:808]'],
    ])('allows ISATAP %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(false);
    });
  });

  describe('NAT64 well-known prefix 64:ff9b::/96 (RFC 6052)', () => {
    it.each([
      ['10.0.0.1', '[64:ff9b::a00:1]'],
      ['127.0.0.1', '[64:ff9b::7f00:1]'],
      ['192.168.1.1', '[64:ff9b::c0a8:101]'],
    ])('refuses the private IPv4 %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });

    it.each([['8.8.8.8', '[64:ff9b::808:808]']])('allows the public IPv4 %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(false);
    });
  });

  describe('NAT64 local-use prefix 64:ff9b:1::/48 (refused whatever it carries)', () => {
    it.each(['[64:ff9b:1::808:808]', '[64:ff9b:1:0:0:0:0:1]'])('refuses %s', (host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });
  });

  describe('network-specific NAT64 (RFC 6052), IPv4 after a /32 prefix', () => {
    it.each([
      ['10.0.0.1', '[2001:db8:a00:1::]'],
      ['192.168.1.1', '[2001:db8:c0a8:101::]'],
    ])('refuses the private IPv4 %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8', () => {
      expect(isPrivateOrInternalHost('[2001:db8:808:808::]')).toBe(false);
    });
  });

  describe('network-specific NAT64 (RFC 6052), IPv4 after a /40 prefix', () => {
    it('refuses the private IPv4 10.0.0.1 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:a:0:1::]')).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:8:808:8::]')).toBe(false);
    });
  });

  describe('network-specific NAT64 (RFC 6052), IPv4 after a /48 prefix', () => {
    it('refuses the private IPv4 10.0.0.1 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:0:a00:0:100::]')).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:0:808:8:800::]')).toBe(false);
    });
  });

  describe('network-specific NAT64 (RFC 6052), IPv4 after a /56 prefix', () => {
    it('refuses the private IPv4 10.0.0.1 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:0:a:0:1::]')).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:0:8:8:808::]')).toBe(false);
    });
  });

  describe('network-specific NAT64 (RFC 6052), IPv4 after a /64 prefix', () => {
    it('refuses the private IPv4 10.0.0.1 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:0:0:a:0:100:0]')).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8 in the translated shape', () => {
      expect(isPrivateOrInternalHost('[2001:db8:0:0:8:808:800:0]')).toBe(false);
    });
  });

  describe('network-specific NAT64 (RFC 6052), IPv4 after a /96 prefix', () => {
    it.each([
      ['10.0.0.1', '[2001:db8::a00:1]'],
      ['127.0.0.1', '[2001:db8::7f00:1]'],
      ['192.168.1.1', '[2001:db8::c0a8:101]'],
    ])('refuses the private IPv4 %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8', () => {
      expect(isPrivateOrInternalHost('[2001:db8::808:808]')).toBe(false);
    });
  });

  describe('6rd (RFC 5969) with the IPv4 address after a /32 prefix', () => {
    it.each([
      ['192.168.1.1', '[2001:db8:c0a8:101::1]'],
      ['127.0.0.1', '[2001:db8:7f00:1::1]'],
    ])('refuses the private IPv4 %s', (_label, host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });

    it('allows the public IPv4 8.8.8.8', () => {
      expect(isPrivateOrInternalHost('[2001:db8:808:808::1]')).toBe(false);
    });
  });

  describe('6to4 (2002::/16): refused whatever IPv4 address it carries', () => {
    it.each(['[2002:c0a8:101::1]', '[2002:808:808::1]'])('refuses %s', (host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });
  });

  describe('an address whose bits carry no private IPv4 address is allowed', () => {
    it.each(['[2001:db8::1]', '[2001:db8:0:0:1:0:0:1]'])('allows %s', (host) => {
      expect(isPrivateOrInternalHost(host)).toBe(false);
    });
  });
});
