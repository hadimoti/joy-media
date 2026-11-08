import { describe, expect, it } from 'vitest';
import {
  DEV_RENDERER_RETRY_MS,
  DEV_RENDERER_URL,
  PACKAGED_RENDERER_ORIGIN,
  buildSecureWebPreferences,
  devRendererFailureHtml,
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

describe('devRendererFailureHtml', () => {
  it('names the URL and the command that starts the editor dev server, and the retry', () => {
    const page = devRendererFailureHtml(DEV_RENDERER_URL, 'ERR_CONNECTION_REFUSED');
    expect(page).toContain(DEV_RENDERER_URL);
    expect(page).toContain('pnpm --filter @joy-media/editor-web dev');
    expect(page).toContain(`retries every ${DEV_RENDERER_RETRY_MS / 1000} seconds`);
  });

  it('escapes the reason, so it cannot inject markup into the page', () => {
    const page = devRendererFailureHtml(DEV_RENDERER_URL, '<script>alert(1)</script>');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&#60;script&#62;');
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
