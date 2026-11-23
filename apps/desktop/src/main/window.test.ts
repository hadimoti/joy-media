import { afterEach, describe, expect, it, vi } from 'vitest';
import * as windowModule from './window.js';
import {
  DEV_LOADING_BAR_MS,
  DEV_RENDERER_URL,
  PACKAGED_LOADING_DELAY_MS,
  PACKAGED_RENDERER_ORIGIN,
  buildSecureWebPreferences,
  isWindowMaximizedOrFullscreen,
  toggleWindowFullscreen,
  toggleWindowMaximize,
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
    const page = devLoadingPageHtml('data:image/png;base64,AAAA');
    expect(page).toContain('src="data:image/png;base64,AAAA"');
    expect(page).toContain('Loading JOY Media');
  });

  it('shows the name in text when the logo file is missing', () => {
    const page = devLoadingPageHtml(undefined);
    expect(page).toContain('class="wordmark">JOY Media');
    expect(page).not.toContain('<img');
  });

  it('shows a loading bar that fills over the loading time, and no button', () => {
    const page = devLoadingPageHtml(undefined);
    expect(page).toContain('class="bar"');
    expect(page).toContain(`${DEV_LOADING_BAR_MS}ms`);
    expect(page).toContain('@keyframes fill');
    expect(page).not.toContain('Try again');
    expect(page).not.toContain('href=');
  });

  it('wiggles the logo, and keeps it still when motion is reduced', () => {
    const page = devLoadingPageHtml(undefined);
    expect(page).toContain('@keyframes wiggle');
    expect(page).toContain('animation:wiggle');
    expect(page).toContain('prefers-reduced-motion');
  });

  it('is dark and in the app style, never white and never about a server', () => {
    const page = devLoadingPageHtml(undefined);
    expect(page).toContain('background:#000000');
    expect(page).not.toMatch(/#fff(fff)?\b/i);
    expect(page).not.toMatch(/dev server|not running|pnpm --filter/i);
  });

  it('makes no network request: a strict policy and no remote URL', () => {
    const page = devLoadingPageHtml('data:image/png;base64,AAAA');
    expect(page).toContain(`default-src 'none'`);
    expect(page).not.toMatch(/https?:\/\//i);
    expect(page).not.toMatch(/<script/i);
  });
});

describe('PACKAGED_LOADING_DELAY_MS', () => {
  it('waits briefly before showing the loading window on packaged starts', () => {
    expect(PACKAGED_LOADING_DELAY_MS).toBe(300);
  });
});

describe('createPackagedLoadingGate', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the renderer without ever showing the splash when ready before the delay', () => {
    vi.useFakeTimers();
    const showLoading = vi.fn();
    const showRenderer = vi.fn();
    const createGate = windowModule.createPackagedLoadingGate;

    expect(createGate).toBeTypeOf('function');
    const gate = createGate!(showLoading, showRenderer);
    vi.advanceTimersByTime(PACKAGED_LOADING_DELAY_MS - 1);

    expect(showLoading).not.toHaveBeenCalled();
    gate.rendererReady();
    expect(showRenderer).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(showLoading).not.toHaveBeenCalled();
  });

  it('shows the splash after the delay and the renderer when it becomes ready', () => {
    vi.useFakeTimers();
    const showLoading = vi.fn();
    const showRenderer = vi.fn();
    const createGate = windowModule.createPackagedLoadingGate;

    expect(createGate).toBeTypeOf('function');
    const gate = createGate!(showLoading, showRenderer);
    vi.advanceTimersByTime(PACKAGED_LOADING_DELAY_MS);

    expect(showLoading).toHaveBeenCalledOnce();
    expect(showRenderer).not.toHaveBeenCalled();

    gate.rendererReady();
    expect(showRenderer).toHaveBeenCalledOnce();
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

describe('desktop window presentation', () => {
  function windowState(initial: { fullscreen?: boolean; maximized?: boolean } = {}) {
    let fullscreen = initial.fullscreen ?? false;
    let maximized = initial.maximized ?? false;
    return {
      isFullScreen: () => fullscreen,
      setFullScreen: (next: boolean) => {
        fullscreen = next;
        if (next) maximized = false;
      },
      isMaximized: () => maximized,
      maximize: () => {
        maximized = true;
      },
      unmaximize: () => {
        maximized = false;
      },
    };
  }

  it('starts the desktop window in native fullscreen by default', () => {
    expect(windowModule.buildMainWindowOptions('/preload.cjs', true).fullscreen).toBe(true);
    expect(windowModule.buildMainWindowOptions('/preload.cjs', false).fullscreen).toBe(true);
  });

  it('lets the restore control leave fullscreen for a normal window', () => {
    const win = windowState({ fullscreen: true });
    expect(isWindowMaximizedOrFullscreen(win)).toBe(true);
    expect(toggleWindowMaximize(win)).toBe(false);
    expect(win.isFullScreen()).toBe(false);
    expect(win.isMaximized()).toBe(false);
  });

  it('keeps ordinary maximize and restore behavior outside fullscreen', () => {
    const win = windowState();
    expect(toggleWindowMaximize(win)).toBe(true);
    expect(isWindowMaximizedOrFullscreen(win)).toBe(true);
    expect(toggleWindowMaximize(win)).toBe(false);
  });

  it('toggles native fullscreen independently of monitor/document fullscreen', () => {
    const win = windowState();
    expect(toggleWindowFullscreen(win)).toBe(true);
    expect(win.isFullScreen()).toBe(true);
    expect(toggleWindowFullscreen(win)).toBe(false);
    expect(win.isFullScreen()).toBe(false);
  });
});
