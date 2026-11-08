import { describe, expect, it } from 'vitest';
import {
  DEV_RENDERER_URL,
  PACKAGED_RENDERER_ORIGIN,
  buildSecureWebPreferences,
  devLoadingPageHtml,
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

describe('devLoadingPageHtml', () => {
  it('shows the JOY Media logo and a loading line', () => {
    const page = devLoadingPageHtml('data:image/png;base64,AAAA', DEV_RENDERER_URL);
    expect(page).toContain('src="data:image/png;base64,AAAA"');
    expect(page).toContain('Loading JOY Media');
  });

  it('shows the name in text when the logo file is missing', () => {
    const page = devLoadingPageHtml(undefined, DEV_RENDERER_URL);
    expect(page).toContain('class="wordmark">JOY Media');
    expect(page).not.toContain('<img');
  });

  it('has a Try again link to the editor address', () => {
    const page = devLoadingPageHtml(undefined, DEV_RENDERER_URL);
    expect(page).toContain(`href="${DEV_RENDERER_URL}"`);
    expect(page).toContain('Try again');
  });

  it('wiggles the logo, and keeps it still when motion is reduced', () => {
    const page = devLoadingPageHtml(undefined, DEV_RENDERER_URL);
    expect(page).toContain('@keyframes wiggle');
    expect(page).toContain('animation:wiggle');
    expect(page).toContain('prefers-reduced-motion');
  });

  it('is dark and in the app style, never white and never about a server', () => {
    const page = devLoadingPageHtml(undefined, DEV_RENDERER_URL);
    expect(page).toContain('background:#000000');
    expect(page).not.toMatch(/#fff(fff)?\b/i);
    expect(page).not.toMatch(/dev server|not running|pnpm --filter/i);
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
