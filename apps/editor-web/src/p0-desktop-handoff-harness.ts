import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type Plugin } from 'vite';
import { P0_TITLE_FONTS } from './p0-title-fonts.js';
import { findChromiumExecutable } from '@joy-media/html-scene-runtime';
import type {
  P0DesktopHandoffFont,
  P0DesktopHandoffOperation,
  P0DesktopHandoffResponse,
  P0DesktopHandoffSurface,
} from './p0-desktop-handoff-page.js';

export type { P0DesktopHandoffOperation } from './p0-desktop-handoff-page.js';

export interface DesktopHandoffSurface extends Omit<P0DesktopHandoffSurface, 'rgbaBase64'> {
  readonly data: Uint8Array;
}

export interface DesktopHandoffResult extends Omit<
  P0DesktopHandoffResponse['operations'][number],
  'surfaces'
> {
  readonly surfaces: Readonly<Record<string, DesktopHandoffSurface>>;
}

export interface DesktopHandoffResponse {
  readonly operations: readonly DesktopHandoffResult[];
  readonly cleanup: P0DesktopHandoffResponse['cleanup'];
}

export interface BrowserTitleCapture {
  readonly png: Uint8Array;
  close(): Promise<void>;
}

interface FontManifest {
  readonly files: readonly {
    readonly family: string;
    readonly weight: number;
    readonly subset: string;
    readonly file: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

interface BrowserServer {
  readonly vite: Awaited<ReturnType<typeof createServer>>;
  readonly server: Server;
  readonly origin: string;
}

interface BrowserResources {
  readonly browser: Browser;
  readonly server: BrowserServer;
  readonly fonts: readonly P0DesktopHandoffFont[];
}

let resourcesPromise: Promise<BrowserResources> | undefined;
const activePages = new Set<Page>();

async function readVerifiedFonts(): Promise<readonly P0DesktopHandoffFont[]> {
  const directory = new URL(
    '../../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/',
    import.meta.url,
  );
  const manifest = JSON.parse(
    await readFile(fileURLToPath(new URL('manifest.json', directory)), 'utf8'),
  ) as FontManifest;
  return Promise.all(
    P0_TITLE_FONTS.map(async (font) => {
      const filename = font.url.split('/').at(-1);
      if (filename === undefined) throw new Error(`Invalid bundled font path for ${font.weight}`);
      const entry = manifest.files.find(
        (candidate) =>
          candidate.family === font.family &&
          candidate.weight === font.weight &&
          candidate.subset === font.subset &&
          candidate.file === filename,
      );
      if (entry === undefined) throw new Error(`Font missing from bundled manifest: ${filename}`);
      const bytes = await readFile(fileURLToPath(new URL(filename, directory)));
      const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (
        bytes.byteLength !== entry.byteLength ||
        sha256 !== entry.sha256 ||
        sha256 !== font.sha256
      ) {
        throw new Error(`Bundled font integrity check failed: ${filename}`);
      }
      return {
        family: font.family,
        weight: font.weight,
        subset: font.subset,
        bytesBase64: bytes.toString('base64'),
      };
    }),
  );
}

/**
 * p0TitleFontFaces fetches its bundled fonts relative to the module URL, which the page serves
 * under /src. This plugin serves the same bundled files at that path, so the browser loads
 * identical bytes. configureServer runs before Vite's own middlewares, so it is not shadowed.
 */
function serveBundledFonts(fontRoot: string): Plugin {
  return {
    name: 'p0-bundled-fonts',
    configureServer(server) {
      server.middlewares.use(
        '/packages/html-scene-runtime/assets/fonts',
        (request, response, next) => {
          const relative = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/').replace(
            /^\/+/,
            '',
          );
          const file = resolve(fontRoot, relative);
          if (!file.startsWith(`${fontRoot}\\`) && !file.startsWith(`${fontRoot}/`)) {
            response.statusCode = 403;
            response.end();
            return;
          }
          readFile(file).then(
            (bytes) => {
              response.setHeader('content-type', 'font/woff2');
              response.end(bytes);
            },
            () => next(),
          );
        },
      );
    },
  };
}

async function servePage(): Promise<BrowserServer> {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const fontRoot = resolve(root, '..', '..', 'packages', 'html-scene-runtime', 'assets', 'fonts');
  const vite = await createServer({
    configFile: resolve(root, 'vite.config.ts'),
    root,
    appType: 'mpa',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    plugins: [serveBundledFonts(fontRoot)],
  });
  const server = createHttpServer(vite.middlewares);
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Vite server has no TCP address');
    return { vite, server, origin: `http://127.0.0.1:${address.port}` };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

async function closeServer(server: BrowserServer): Promise<void> {
  const failures: unknown[] = [];
  try {
    await new Promise<void>((resolveClose, reject) => {
      server.server.close((error) => (error ? reject(error) : resolveClose()));
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await server.vite.close();
  } catch (error) {
    failures.push(error);
  }
  if (server.server.listening) failures.push(new Error('P0 desktop handoff server process leaked'));
  if (failures.length > 0)
    throw new AggregateError(failures, 'P0 desktop handoff server cleanup failed');
}

async function createResources(): Promise<BrowserResources> {
  const executable = findChromiumExecutable();
  if (executable === undefined) throw new Error('Runtime Chromium executable was not found');
  try {
    await access(executable);
  } catch {
    throw new Error(`Playwright Chromium is missing at ${executable}`);
  }
  const fonts = await readVerifiedFonts();
  const server = await servePage();
  try {
    const browser = await chromium.launch({ headless: true, executablePath: executable });
    return { browser, server, fonts };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

/** Exact executable used by both the desktop harness and the CLI scene driver. */
export function p0DesktopHandoffChromiumExecutable(): string | undefined {
  return findChromiumExecutable();
}

async function getResources(): Promise<BrowserResources> {
  resourcesPromise ??= createResources();
  return resourcesPromise;
}

async function openPage(): Promise<{
  readonly page: Page;
  readonly fonts: readonly P0DesktopHandoffFont[];
}> {
  const resources = await getResources();
  const page = await resources.browser.newPage({
    viewport: { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
  });
  activePages.add(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  try {
    await page.goto(`${resources.server.origin}/p0-desktop-handoff.html`, {
      waitUntil: 'networkidle',
    });
    await page
      .waitForFunction(() => typeof window.__joyP0DesktopHandoff === 'function')
      .catch((error: unknown) => {
        throw new Error(
          `P0 desktop page did not register its entry: ${String(error)}; page errors: ${pageErrors.join(' | ') || 'none'}`,
        );
      });
    await page.evaluate(async (fontFaces) => {
      for (const font of fontFaces) {
        const face = await new FontFace(
          font.family,
          `url(data:font/woff2;base64,${font.bytesBase64})`,
          { weight: String(font.weight) },
        ).load();
        document.fonts.add(face);
      }
      await document.fonts.ready;
    }, resources.fonts);
    return { page, fonts: resources.fonts };
  } catch (error) {
    await closePage(page);
    throw error;
  }
}

async function closePage(page: Page): Promise<void> {
  await page.close();
  activePages.delete(page);
}

export async function prepareP0DesktopHandoff(): Promise<void> {
  await getResources();
}

export async function closeP0DesktopHandoff(): Promise<void> {
  const failures: unknown[] = [];
  for (const page of activePages) {
    try {
      await closePage(page);
    } catch (error) {
      failures.push(error);
    }
  }

  const resources = await resourcesPromise;
  if (resources !== undefined) {
    try {
      await resources.browser.close();
      if (resources.browser.isConnected())
        throw new Error('Chromium browser process leaked after close');
    } catch (error) {
      failures.push(error);
    }
    try {
      await closeServer(resources.server);
    } catch (error) {
      failures.push(error);
    }
  }
  resourcesPromise = undefined;
  if (failures.length > 0) throw new AggregateError(failures, 'P0 desktop handoff cleanup failed');
}

export async function runP0DesktopHandoff(
  operations: readonly P0DesktopHandoffOperation[],
): Promise<DesktopHandoffResponse> {
  const { page, fonts } = await openPage();
  let browserResult: unknown;
  try {
    browserResult = await page.evaluate(async (serialized: string): Promise<unknown> => {
      const entry = window.__joyP0DesktopHandoff;
      if (entry === undefined) throw new Error('P0 desktop handoff browser entry is unavailable');
      const request = JSON.parse(serialized) as Parameters<typeof entry>[0];
      return entry(request);
    }, JSON.stringify({ operations, fonts }));
  } finally {
    await closePage(page);
  }
  const response = browserResult as P0DesktopHandoffResponse;
  return {
    operations: response.operations.map((operation) => ({
      ...operation,
      surfaces: Object.fromEntries(
        Object.entries(operation.surfaces).map(([id, surface]) => [
          id,
          {
            width: surface.width,
            height: surface.height,
            data: Buffer.from(surface.rgbaBase64, 'base64'),
          },
        ]),
      ),
    })),
    cleanup: response.cleanup,
  };
}

/** Kept for focused title-frame checks; cache/compositor assertions use the entry above. */
export async function captureTitleMarkup(
  markup: string,
  width: number,
  height: number,
): Promise<BrowserTitleCapture> {
  const { page, fonts } = await openPage();
  try {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      async ({ content, fontFaces }) => {
        for (const font of fontFaces) {
          const face = await new FontFace(
            font.family,
            `url(data:font/woff2;base64,${font.bytesBase64})`,
            { weight: String(font.weight) },
          ).load();
          document.fonts.add(face);
        }
        await document.fonts.ready;
        document.body.innerHTML = content;
        document.body.style.cssText = 'margin:0;overflow:hidden;background:transparent';
      },
      { content: markup, fontFaces: fonts },
    );
    const png = new Uint8Array(await page.screenshot({ omitBackground: true }));
    return {
      png,
      async close() {
        await closePage(page);
      },
    };
  } catch (error) {
    await closePage(page);
    throw error;
  }
}
