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
    '[64:ff9b::5db8:d822]',
    '[64:ff9b:1::a00:1]',
    '[2002:c0a8:101::1]',
    '[2002:5db8:d822::1]',
    '[0:0:0:0:0:0:7f00:1]',
    '[0:0:0:0:ffff:0:a00:1]',
    '[0064:ff9b:0:0:0:0:a9fe:a9fe]',
  ])('refuses %s', (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '[2606:4700:4700::1111]',
    '[2001:4860:4860::8888]',
    '[::ffff:93.184.216.34]',
    'api.example.com',
  ])('allows the public %s', (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(false);
  });
});
