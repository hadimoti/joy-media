import { describe, expect, it } from 'vitest';
import {
  DEV_RENDERER_URL,
  PACKAGED_RENDERER_ORIGIN,
  buildSecureWebPreferences,
  resolveRendererTarget,
} from './window.js';

describe('resolveRendererTarget', () => {
  it('loads the Vite dev server in dev', () => {
    expect(resolveRendererTarget(true)).toBe(DEV_RENDERER_URL);
  });

  it('loads the packaged custom-scheme origin outside dev', () => {
    expect(resolveRendererTarget(false)).toBe(`${PACKAGED_RENDERER_ORIGIN}/index.html`);
  });
});

describe('buildSecureWebPreferences', () => {
  it('never allows nodeIntegration, always sandboxes and isolates the context', () => {
    const prefs = buildSecureWebPreferences('/path/to/preload.cjs');
    expect(prefs).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      preload: '/path/to/preload.cjs',
    });
  });
});
