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
