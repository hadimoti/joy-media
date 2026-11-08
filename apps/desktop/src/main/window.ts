import { ALLOWED_EDITOR_ORIGINS } from '../origin-policy.js';

/** The custom scheme used to serve the packaged renderer build. Registered as a
 * "standard, secure" privileged scheme in the electron entrypoint so it behaves like
 * https:// for origin checks, CSP, and fetch — see electron-entry.ts. */
export const PACKAGED_RENDERER_SCHEME = 'joy-media-app';
export const PACKAGED_RENDERER_ORIGIN = `${PACKAGED_RENDERER_SCHEME}://renderer`;

/** The dev-server origin the editor-web Vite server listens on. Must stay in the
 * shared allow-list (`origin-policy.ts`) or the IPC bridge will reject every request. */
export const DEV_RENDERER_URL = 'http://localhost:5173';

if (!(ALLOWED_EDITOR_ORIGINS as readonly string[]).includes(DEV_RENDERER_URL)) {
  throw new Error(`${DEV_RENDERER_URL} must be an allowed editor origin`);
}

/** Picks what the BrowserWindow should load. Pure so it is unit-testable without Electron. */
export function resolveRendererTarget(isDev: boolean): string {
  return isDev ? DEV_RENDERER_URL : `${PACKAGED_RENDERER_ORIGIN}/index.html`;
}

/** How long a development window waits before it asks the editor dev server again. */
export const DEV_RENDERER_RETRY_MS = 2000;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page a development window shows while the editor dev server does not answer. It names the URL and the command
 * that starts the server, so a blank window cannot pass for a finished launch. The reason text is escaped.
 */
export function devRendererFailureHtml(url: string, reason: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<title>JOY Media: editor server not running</title></head>',
    '<body style="font-family:system-ui,sans-serif;margin:48px;color:#1f2933;background:#ffffff">',
    '<h1>The editor dev server is not running</h1>',
    `<p>This development window loads <code>${escapeHtml(url)}</code>, and nothing answered (${escapeHtml(reason)}).</p>`,
    '<p>Start it in a terminal at the repository root:</p>',
    '<pre>pnpm --filter @joy-media/editor-web dev</pre>',
    `<p>This window retries every ${DEV_RENDERER_RETRY_MS / 1000} seconds and loads the editor as soon as the server answers.</p>`,
    '</body></html>',
  ].join('');
}

/** The security-relevant subset of `BrowserWindowConstructorOptions['webPreferences']`.
 * Every field here is load-bearing: flipping any of them weakens the sandbox boundary
 * the rest of this package assumes. */
export interface SecureWebPreferences {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly webviewTag: false;
  readonly preload: string;
}

export function buildSecureWebPreferences(preloadPath: string): SecureWebPreferences {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    preload: preloadPath,
  };
}
