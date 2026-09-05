// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScenePreviewHost, findFirstPartyScene } from '@joy-media/html-scene-runtime/browser';

describe('browser scene host teardown', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });
  const createHost = () =>
    createScenePreviewHost({
      instanceId: 'fixture',
      scene: findFirstPartyScene('joy.firstparty.title')!,
    });

  it('rejects readiness and capture when removed before the iframe is ready', async () => {
    const host = createHost();
    const ready = expect(host.ready).rejects.toThrow('destroyed');
    const capture = expect(host.capture(32, 48)).rejects.toThrow('destroyed');
    host.destroy();
    host.destroy();
    await Promise.all([ready, capture]);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(host.update(0, {})).toBe(false);
    await expect(host.capture(32, 48)).rejects.toThrow('destroyed');
  });

  it('rejects an in-flight capture, removes its timer, and ignores late iframe messages', async () => {
    vi.useFakeTimers();
    const host = createHost();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: host.iframe.contentWindow,
        data: { type: 'joy.scene.ready.v1', instanceId: 'fixture' },
      }),
    );
    await host.ready;
    const capture = expect(host.capture(32, 48, 8000)).rejects.toThrow('destroyed');
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    host.destroy();
    await capture;
    // jsdom delivers already-posted iframe messages with a zero-delay timer.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });
});
