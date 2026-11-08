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

/** How often a development window checks the editor while it shows the loading page. */
export const DEV_RENDERER_RETRY_MS = 2000;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The app's own colours (apps/editor-web/src/app.css): black ground, light text, gold accent. */
const LOADING_PAGE_CSS = [
  'html,body{height:100%;margin:0}',
  'body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;',
  'background:#000000;color:#ececef;',
  "font-family:'Inter Variable','Vazirmatn Variable','Noto Sans Arabic',Tahoma,system-ui,sans-serif}",
  'img{width:128px;height:128px;object-fit:contain;transform-origin:50% 50%;animation:wiggle 2.4s ease-in-out infinite}',
  '.wordmark{margin:0;font-size:40px;font-weight:700;letter-spacing:0.02em}',
  '.status{margin:0;font-size:15px;color:#a8a8b0}',
  '.retry{display:inline-block;padding:10px 22px;border-radius:8px;background:#f4b72f;color:#1a1408;',
  'font-size:14px;font-weight:600;text-decoration:none}',
  '.retry:hover{background:#ffc94f}',
  '@keyframes wiggle{0%{transform:rotate(0deg)}10%{transform:rotate(-7deg)}20%{transform:rotate(6deg)}30%{transform:rotate(-5deg)}40%{transform:rotate(3deg)}50%{transform:rotate(-2deg)}60%,100%{transform:rotate(0deg)}}',
  '@media (prefers-reduced-motion:reduce){img{animation:none}}',
].join('');

/**
 * The page a development window shows while the editor is not ready yet: the JOY Media logo, a loading line, and a
 * Try again link that asks for the editor again at once. It is dark, in the app's style, and never mentions a server.
 */
export function devLoadingPageHtml(logoDataUrl: string | undefined, retryUrl: string): string {
  const logo =
    logoDataUrl === undefined
      ? '<p class="wordmark">JOY Media</p>'
      : `<img src="${escapeHtml(logoDataUrl)}" alt="JOY Media" width="128" height="128">`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    '<title>JOY Media</title>',
    `<style>${LOADING_PAGE_CSS}</style>`,
    '</head><body>',
    logo,
    '<p class="status">Loading JOY Media&hellip;</p>',
    `<a class="retry" href="${escapeHtml(retryUrl)}">Try again</a>`,
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
