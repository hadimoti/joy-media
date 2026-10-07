import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { warnIfLoopbackProxyIsUnconfigured } from './proxy-startup-warning.js';

type WarnIfLoopbackProxyIsUnconfigured = typeof warnIfLoopbackProxyIsUnconfigured;

const LOOPBACK_WARNING =
  'JOY Media API is listening on loopback with no trusted proxy configured; all clients will share one rate-limit bucket.';

// The warning is latched once per process, so each test loads a fresh module.
// Otherwise an earlier warning would make every later "does not warn" check
// pass vacuously.
async function freshWarning(): Promise<WarnIfLoopbackProxyIsUnconfigured> {
  vi.resetModules();
  return (await import('./proxy-startup-warning.js')).warnIfLoopbackProxyIsUnconfigured;
}

describe('loopback trusted proxy startup warning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('warns once without exposing configuration values when loopback has no trusted proxy', async () => {
    const warnIfLoopbackProxyIsUnconfigured = await freshWarning();
    const warn = vi.fn();

    warnIfLoopbackProxyIsUnconfigured('127.0.0.1', [], warn);
    warnIfLoopbackProxyIsUnconfigured('127.0.0.1', [], warn);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(LOOPBACK_WARNING);
  });

  it.each(['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', ' LOCALHOST '])(
    'warns for loopback host %j with no trusted proxy',
    async (host) => {
      const warnIfLoopbackProxyIsUnconfigured = await freshWarning();
      const warn = vi.fn();
      warnIfLoopbackProxyIsUnconfigured(host, [], warn);
      expect(warn).toHaveBeenCalledWith(LOOPBACK_WARNING);
    },
  );

  it.each([
    ['0.0.0.0', []],
    ['::', []],
    ['10.0.0.5', []],
    ['127.0.0.1', ['127.0.0.1']],
    ['::1', ['127.0.0.1']],
  ])('does not warn for host=%s and trusted proxies=%j', async (host, proxies) => {
    const warnIfLoopbackProxyIsUnconfigured = await freshWarning();
    const warn = vi.fn();

    warnIfLoopbackProxyIsUnconfigured(host, proxies, warn);
    expect(warn).not.toHaveBeenCalled();

    // Prove the latch was still open: the same fresh module does warn for an
    // unconfigured loopback listener, so the silence above was a real decision.
    warnIfLoopbackProxyIsUnconfigured('127.0.0.1', [], warn);
    expect(warn).toHaveBeenCalledOnce();
  });
});
