/**
 * Pinned browser capture implementation for scene export. The scene VM emits
 * static markup; Chromium owns layout, font shaping, and pixel capture under a
 * default-deny document CSP. This is deliberately a concrete driver, rather
 * than a test-only fake, so preview/golden/export all have one pixel boundary.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeadlessCaptureRequest, HeadlessSceneDriver, HeadlessSurface } from './headless.js';

export interface ChromiumSceneDriverOptions {
  /** Absolute trusted path to JOY's pinned Chromium binary. */
  readonly executablePath?: string;
  /** Per-frame browser process timeout. Defaults to 15 seconds. */
  readonly timeoutMs?: number;
}

const CHROMIUM_CANDIDATES = [
  process.env.JOY_CHROMIUM_PATH,
  process.env.ProgramFiles &&
    join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] &&
    join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((value): value is string => typeof value === 'string' && value.length > 0);

/** Returns the configured/pinned Chromium executable when it is locally available. */
export function findChromiumExecutable(): string | undefined {
  return CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate));
}

/**
 * Creates the production headless driver. The generated document is offline:
 * it accepts only resolver-provided data/blob resources and never executes
 * scene scripts while exporting the already-evaluated markup.
 */
export function createChromiumSceneDriver(
  options: ChromiumSceneDriverOptions = {},
): HeadlessSceneDriver {
  const executablePath = options.executablePath ?? findChromiumExecutable();
  if (executablePath === undefined) {
    throw new Error('pinned Chromium is required for scene capture (set JOY_CHROMIUM_PATH)');
  }
  if (!existsSync(executablePath)) {
    throw new Error(`configured Chromium executable does not exist: ${executablePath}`);
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('Chromium scene capture timeoutMs must be a positive safe integer');

  return {
    capture(request): HeadlessSurface {
      assertCaptureRequest(request);
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'joy-scene-capture-'));
      const documentPath = join(temporaryDirectory, 'scene.html');
      const screenshotPath = join(temporaryDirectory, 'scene.png');
      try {
        writeFileSync(documentPath, captureDocument(request), 'utf8');
        const browser = spawnSync(
          executablePath,
          [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--no-first-run',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost',
            `--default-background-color=${request.transparent ? '00000000' : '000000ff'}`,
            `--window-size=${request.width},${request.height}`,
            `--screenshot=${screenshotPath}`,
            pathToFileURL(documentPath).href,
          ],
          { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false },
        );
        if (browser.error !== undefined || browser.status !== 0 || !existsSync(screenshotPath)) {
          const detail = browser.error?.message ?? browser.stderr ?? `status ${browser.status}`;
          throw new Error(`Chromium scene capture failed: ${detail}`);
        }
        return { rgba: decodePngRgba(screenshotPath, request.width, request.height, timeoutMs) };
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  };
}

function captureDocument(request: HeadlessCaptureRequest): string {
  const background = request.transparent ? 'transparent' : '#000';
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">`,
    `<style>html,body,#joy-scene-root{margin:0;width:${request.width}px;height:${request.height}px;overflow:hidden;background:${background};}#joy-scene-root{position:relative;}</style>`,
    '</head><body><div id="joy-scene-root">',
    request.markup,
    '</div></body></html>',
  ].join('');
}

function decodePngRgba(path: string, width: number, height: number, timeoutMs: number): Uint8Array {
  // FFmpeg is already JOY's export dependency. Asking it for raw RGBA avoids a
  // second, potentially divergent PNG decoder in the render path.
  const decoded = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    {
      encoding: null,
      timeout: timeoutMs,
      maxBuffer: width * height * 8,
      windowsHide: true,
      shell: false,
    },
  );
  if (decoded.error !== undefined || decoded.status !== 0) {
    const detail =
      decoded.error?.message ?? decoded.stderr.toString() ?? `status ${decoded.status}`;
    throw new Error(`scene screenshot decode failed: ${detail}`);
  }
  const rgba = new Uint8Array(decoded.stdout);
  const expectedLength = width * height * 4;
  if (rgba.length !== expectedLength) {
    throw new Error(
      `Chromium screenshot must decode to ${expectedLength} RGBA bytes, got ${rgba.length}`,
    );
  }
  return rgba;
}

function assertCaptureRequest(request: HeadlessCaptureRequest): void {
  if (
    !Number.isSafeInteger(request.width) ||
    !Number.isSafeInteger(request.height) ||
    request.width <= 0 ||
    request.height <= 0
  )
    throw new RangeError('scene capture viewport must be positive integer dimensions');
  if (!Number.isSafeInteger(request.timeUs) || request.timeUs < 0)
    throw new RangeError('scene capture timeUs must be a non-negative safe integer');
  if (typeof request.markup !== 'string')
    throw new TypeError('scene capture markup must be a string');
}

/** Exposed for integration diagnostics without leaking the temporary document. */
export function readChromiumVersion(executablePath: string): string {
  const version = spawnSync(executablePath, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    shell: false,
  });
  if (version.error !== undefined || version.status !== 0) {
    const detail = version.error?.message ?? version.stderr ?? `status ${version.status}`;
    throw new Error(`cannot read Chromium version: ${detail}`);
  }
  return version.stdout.trim();
}
