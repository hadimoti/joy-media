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
  ])('refuses %s', (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '[2606:4700:4700::1111]', 'api.example.com'])(
    'allows the public %s',
    (host) => {
      expect(isPrivateOrInternalHost(host)).toBe(false);
    },
  );
});
