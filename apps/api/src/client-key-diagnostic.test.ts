import { describe, expect, it } from 'vitest';
import {
  createClientKeyDiagnosticResponse,
  hashDiagnosticClientKey,
  isLoopbackSocketPeer,
} from './client-key-diagnostic.js';

describe('loopback client-key diagnostics', () => {
  it.each(['127.0.0.1', '127.22.3.4', '::1', '::ffff:127.0.0.1'])(
    'accepts loopback socket peer %s',
    (address) => expect(isLoopbackSocketPeer(address)).toBe(true),
  );

  it.each([undefined, '198.51.100.2', '::ffff:198.51.100.2', 'not-an-ip'])(
    'rejects non-loopback socket peer %s',
    (address) => expect(isLoopbackSocketPeer(address)).toBe(false),
  );

  it('returns a keyed digest instead of the address', () => {
    const secret = Buffer.from('per-process-test-key');
    const digest = hashDiagnosticClientKey('198.51.100.7', secret);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain('198.51.100.7');
    expect(hashDiagnosticClientKey('198.51.100.8', secret)).not.toBe(digest);
    expect(hashDiagnosticClientKey('198.51.100.7', Buffer.from('another-key'))).not.toBe(digest);
  });

  it('returns 404 for a non-loopback diagnostic peer', () => {
    expect(
      createClientKeyDiagnosticResponse('198.51.100.8', '198.51.100.8', Buffer.from('test')),
    ).toEqual({ status: 404, body: { error: { code: 'ROUTE_NOT_FOUND' } } });
  });
});
