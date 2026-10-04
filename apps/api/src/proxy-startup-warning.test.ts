import { describe, expect, it, vi } from 'vitest';
import { warnIfLoopbackProxyIsUnconfigured } from './proxy-startup-warning.js';

describe('loopback trusted proxy startup warning', () => {
  it('warns once without exposing configuration values when loopback has no trusted proxy', () => {
    const warn = vi.fn();

    warnIfLoopbackProxyIsUnconfigured('127.0.0.1', [], warn);
    warnIfLoopbackProxyIsUnconfigured('127.0.0.1', [], warn);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'JOY Media API is listening on loopback with no trusted proxy configured; all clients will share one rate-limit bucket.',
    );
  });

  it.each([
    ['0.0.0.0', []],
    ['127.0.0.1', ['127.0.0.1']],
    ['::1', ['127.0.0.1']],
  ])('does not warn for host=%s and trusted proxies=%j', (host, proxies) => {
    const warn = vi.fn();
    warnIfLoopbackProxyIsUnconfigured(host, proxies, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
