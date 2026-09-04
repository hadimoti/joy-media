import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_FONT_REQUEST_TIMEOUT_MS, createFontCatalogSession } from './font-catalog.js';

describe('font catalog session', () => {
  it('returns the bundled catalog without a key or network request', async () => {
    const fetchImpl = vi.fn();
    const session = createFontCatalogSession();

    const entries = await session.discoverGoogleFonts(fetchImpl);

    expect(entries).toEqual(session.localEntries);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(session.hasGoogleApiKey()).toBe(false);
    expect(session.localEntries.filter((entry) => entry.bundled)).toHaveLength(4);
    expect(session.localEntries.find((entry) => entry.family === 'system-ui')).toMatchObject({
      bundled: false,
      source: 'Operating system',
    });
  });

  it('discovers metadata with a session-only key and does not expose it on the session', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              family: 'Example Sans',
              subsets: ['arabic', 'latin'],
              variants: ['400', '700'],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const session = createFontCatalogSession();
    const key = 'test-google-key';

    session.setGoogleApiKey(key);
    const entries = await session.discoverGoogleFonts(fetchImpl);
    const requestUrl = String(fetchImpl.mock.calls[0]?.[0]);

    expect(session.hasGoogleApiKey()).toBe(true);
    expect(requestUrl).toContain(encodeURIComponent(key));
    expect(entries.at(-1)).toMatchObject({
      family: 'Example Sans',
      scripts: 'arabic · latin',
      weights: '400, 700',
      bundled: false,
    });
    expect(JSON.stringify(session)).not.toContain(key);
  });

  it('clears the key and returns to local-only discovery', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const session = createFontCatalogSession();
    session.setGoogleApiKey('temporary-key');
    session.clearGoogleApiKey();

    expect(session.hasGoogleApiKey()).toBe(false);
    expect(await session.discoverGoogleFonts(fetchImpl)).toEqual(session.localEntries);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a stalled provider request and reports a timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      });
      const session = createFontCatalogSession();
      session.setGoogleApiKey('temporary-key');
      const request = session.discoverGoogleFonts(fetchImpl);
      // Attach the rejection observer before advancing the clock so the
      // abort-triggered rejection is handled in the same turn it settles.
      const timeoutAssertion = expect(request).rejects.toThrow('timed out');

      await vi.advanceTimersByTimeAsync(GOOGLE_FONT_REQUEST_TIMEOUT_MS);

      await timeoutAssertion;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates provider failures without retaining the key in the error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable'));
    const session = createFontCatalogSession();
    const key = 'temporary-key';
    session.setGoogleApiKey(key);

    await expect(session.discoverGoogleFonts(fetchImpl)).rejects.toThrow('network unavailable');
    await expect(session.discoverGoogleFonts(fetchImpl)).rejects.not.toThrow(key);
  });
});
