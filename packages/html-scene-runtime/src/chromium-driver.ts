/** Persistent CDP implementation for deterministic, bounded scene captures. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HeadlessCaptureRequest, HeadlessSceneDriver, HeadlessSurface } from './headless.js';
import { loadNotoSansArabicFaces, notoSansArabicFontCss } from './fonts.js';
import { SCENE_PAINT_SCRIPT } from './preview-protocol.js';

export interface ChromiumSceneDriverOptions {
  /** Absolute trusted path to JOY's Chromium binary. */
  readonly executablePath?: string;
  /** Startup and per-capture deadline; defaults to 15 seconds. */
  readonly timeoutMs?: number;
}

const CHROMIUM_CANDIDATES = [
  process.env.JOY_CHROMIUM_PATH,
  process.env.ProgramFiles &&
    join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] &&
    join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.ProgramFiles &&
    join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] &&
    join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((value): value is string => typeof value === 'string' && value.length > 0);

export function findChromiumExecutable(): string | undefined {
  return CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate));
}

const HEADER_BYTES = 16;
const ERROR_BYTES = 8_192;
const MAX_CAPTURE_PIXELS = 4_194_304;

/**
 * The worker body is plain JavaScript held as a string. A serialized TypeScript function can be
 * rewritten by bundlers (renamed identifiers, injected helpers), but this source runs exactly as
 * written. The worker owns one Chromium child and its CDP WebSocket. Shared memory keeps the
 * synchronous capture API, while WebSocket I/O stays asynchronous inside the worker.
 */
const CHROMIUM_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const HEADER_BYTES = 16;
const ERROR_BYTES = 8192;
let browser;
let socket;
let tempDirectory;
let endpoint;
let targetId;
let sessionId;
let activeControl;
let sequence = 0;
const pending = new Map();
const eventWaiters = new Map();
let tail = Promise.resolve();

function send(method, params, session) {
  const activeSocket = socket;
  if (!activeSocket) return Promise.reject(new Error('Chromium DevTools WebSocket is not connected'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP command timed out: ' + method));
    }, workerData.timeoutMs);
    pending.set(id, { resolve, reject, timer });
    activeSocket.send(JSON.stringify({ id, method, params: params || {}, ...(session ? { sessionId: session } : {}) }));
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const connection = new WebSocket(url);
    socket = connection;
    const timer = setTimeout(() => reject(new Error('Chromium DevTools WebSocket startup timed out')), workerData.timeoutMs);
    connection.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    connection.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cannot connect to Chromium DevTools WebSocket')); }, { once: true });
    connection.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (ignored) { return; }
      if (message.id && pending.has(message.id)) {
        const command = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(command.timer);
        if (message.error) command.reject(new Error(message.error.message || 'CDP command failed'));
        else command.resolve(message.result || {});
      } else if (message.method && eventWaiters.has(message.method)) {
        const waiters = eventWaiters.get(message.method);
        eventWaiters.delete(message.method);
        waiters.forEach((waiter) => { clearTimeout(waiter.timer); waiter.resolve(message.params || {}); });
      }
    });
  });
}

function waitForEvent(method) {
  return new Promise((resolve) => {
    const waiters = eventWaiters.get(method) || [];
    const waiter = { resolve, timer: undefined };
    waiters.push(waiter);
    eventWaiters.set(method, waiters);
    waiter.timer = setTimeout(() => {
      const remaining = eventWaiters.get(method) || [];
      eventWaiters.set(method, remaining.filter((item) => item !== waiter));
      resolve({ timeout: true });
    }, workerData.timeoutMs);
  });
}

function waitForEndpoint() {
  return new Promise((resolve, reject) => {
    let output = '';
    let foundEndpoint;
    const timer = setTimeout(() => reject(new Error('Chromium DevTools endpoint startup timed out')), workerData.timeoutMs);
    const child = browser;
    if (!child || !child.stderr) {
      clearTimeout(timer);
      reject(new Error('Chromium stderr endpoint channel is unavailable'));
      return;
    }
    child.stderr.setEncoding('utf8');
    const dataListener = (chunk) => {
      if (foundEndpoint) return;
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      const endpointUrl = match && match[1];
      if (endpointUrl) {
        foundEndpoint = endpointUrl;
        clearTimeout(timer);
        resolve(endpointUrl);
      }
    };
    child.stderr.on('data', dataListener);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (!foundEndpoint) { clearTimeout(timer); reject(new Error('Chromium exited before CDP startup (code ' + code + ')')); }
    });
  });
}

async function closeBrowser() {
  const activeSocket = socket;
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    try { await send('Browser.close', {}); } catch (ignored) { /* bounded best effort */ }
    try { activeSocket.close(); } catch (ignored) { /* already closed */ }
  }
  const child = browser;
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tempDirectory) {
    try { rmSync(tempDirectory, { recursive: true, force: true }); } catch (ignored) { /* best effort after exit */ }
  }
  browser = undefined;
  socket = undefined;
  endpoint = undefined;
  targetId = undefined;
  sessionId = undefined;
}

async function ensureBrowser(request) {
  if (socket && targetId) return;
  tempDirectory = mkdtempSync(join(tmpdir(), 'joy-scene-cdp-'));
  browser = spawn(workerData.executablePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--lang=en-US',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost', '--remote-debugging-port=0',
    '--user-data-dir=' + tempDirectory, '--window-size=' + request.width + ',' + request.height,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
  if (activeControl && browser.pid) activeControl[3] = browser.pid;
  endpoint = await waitForEndpoint();
  await connect(endpoint);
  const created = await send('Target.createTarget', { url: 'about:blank' });
  targetId = created.targetId;
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  }, sessionId);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(detail || result.exceptionDetails.text || 'scene Runtime.evaluate failed');
  }
  return result.result && result.result.value;
}

async function capture(request) {
  await ensureBrowser(request);
  await send('Emulation.setDeviceMetricsOverride', {
    width: request.width, height: request.height, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await send('Emulation.setLocaleOverride', { locale: 'en-US' }, sessionId);
  const markup = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; font-src data: blob:; style-src \'unsafe-inline\'; script-src \'none\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"><style>' + workerData.fontCss + 'html,body,#joy-scene-root{margin:0;width:' + request.width + 'px;height:' + request.height + 'px;overflow:hidden;background:' + (request.transparent ? 'transparent' : '#000') + '}#joy-scene-root{position:relative}</style></head><body><div id="joy-scene-root">' + request.markup + '</div></body></html>';
  const pageLoaded = waitForEvent('Page.loadEventFired');
  await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(markup).toString('base64') }, sessionId);
  const loadEvent = await pageLoaded;
  if (loadEvent.timeout) throw new Error('Chromium scene document load timed out');
  await evaluate(workerData.painterScript);
  const loadFonts = '(async()=>{const faces=' + JSON.stringify(workerData.faces) + ';const loaded=[];for(const face of faces){const text=face.subset===\'arabic\'?String.fromCodePoint(0x627,0x644,0x639,0x631,0x628,0x64a,0x629,0x20,0x641,0x627,0x631,0x633,0x6cc):\'Noto Sans Arabic\';const list=await document.fonts.load(face.weight+\' 16px "Noto Sans Arabic"\',text);if(!list.length||!document.fonts.check(face.weight+\' 16px "Noto Sans Arabic"\',text))throw new Error("Noto Sans Arabic face failed to load: "+face.subset+" "+face.weight);loaded.push(face.subset+":"+face.weight)}return loaded})()';
  const loadedFonts = await evaluate(loadFonts);
  const lines = request.lines || [];
  const background = request.transparent ? 'transparent' : '#000';
  const result = await evaluate(
    'window.__joyPaintSceneSurface(' +
      request.width +
      ',' +
      request.height +
      ',' +
      JSON.stringify(lines) +
      ',' +
      JSON.stringify(background) +
      ')',
  );
  if (typeof result !== 'string') throw new Error('scene painter returned no RGBA payload');
  const rgba = Buffer.from(result, 'base64');
  if (rgba.byteLength !== request.width * request.height * 4) throw new Error('scene painter returned an invalid RGBA byte length');
  return { rgba, loadedFonts };
}

async function handle(message) {
  const control = new Int32Array(message.shared, 0, 4);
  const bytes = new Uint8Array(message.shared);
  activeControl = control;
  try {
    if (message.type === 'close') {
      await closeBrowser();
      Atomics.store(control, 0, 1);
    } else {
      if (!message.request) throw new Error('Chromium capture request is missing');
      const result = await capture(message.request);
      const outputAt = HEADER_BYTES + ERROR_BYTES;
      if (Atomics.load(control, 0) === 3) {
        await closeBrowser();
        bytes.set(Buffer.from('scene capture was cancelled', 'utf8'), HEADER_BYTES);
        control[2] = Buffer.byteLength('scene capture was cancelled');
        Atomics.store(control, 0, 2);
        Atomics.notify(control, 0);
        return;
      }
      bytes.set(result.rgba, outputAt);
      const fonts = Buffer.from(JSON.stringify(result.loadedFonts || []), 'utf8');
      control[1] = result.rgba.byteLength;
      control[3] = browser ? browser.pid || 0 : control[3];
      control[2] = Math.min(fonts.byteLength, ERROR_BYTES);
      bytes.set(fonts.subarray(0, ERROR_BYTES), HEADER_BYTES);
      Atomics.store(control, 0, 1);
    }
  } catch (error) {
    await closeBrowser();
    const messageBytes = Buffer.from(error && error.message ? error.message : String(error), 'utf8').subarray(0, ERROR_BYTES);
    bytes.set(messageBytes, HEADER_BYTES);
    control[2] = messageBytes.byteLength;
    Atomics.store(control, 0, 2);
  }
  Atomics.notify(control, 0);
}

parentPort.on('message', (message) => {
  tail = tail.then(() => handle(message));
});
`;

export function createChromiumSceneDriver(
  options: ChromiumSceneDriverOptions = {},
): HeadlessSceneDriver {
  const executablePath = options.executablePath ?? findChromiumExecutable();
  if (!executablePath)
    throw new Error(
      'Chromium is required for scene capture; set JOY_CHROMIUM_PATH to the browser executable',
    );
  if (!existsSync(executablePath))
    throw new Error(`configured Chromium executable does not exist: ${executablePath}`);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new RangeError('Chromium scene capture timeoutMs must be between 1 and 120000');
  }
  const faces = loadNotoSansArabicFaces();
  const worker = new Worker(CHROMIUM_WORKER_SOURCE, {
    eval: true,
    workerData: {
      executablePath,
      timeoutMs,
      painterScript: SCENE_PAINT_SCRIPT,
      fontCss: notoSansArabicFontCss(faces),
      faces: faces.map(({ weight, subset }) => ({ weight, subset })),
    },
  });
  worker.unref();
  let closed = false;
  let lastBrowserPid: number | undefined;
  const cleanupBrowserOnExit = (): void => {
    if (lastBrowserPid === undefined) return;
    try {
      process.kill(lastBrowserPid);
    } catch {
      /* already exited */
    }
  };
  process.once('exit', cleanupBrowserOnExit);

  function exchange(type: 'capture' | 'close', request?: HeadlessCaptureRequest): HeadlessSurface {
    const pixels = request ? request.width * request.height : 0;
    const shared = new SharedArrayBuffer(HEADER_BYTES + ERROR_BYTES + pixels * 4);
    const control = new Int32Array(shared, 0, 4);
    const at = (index: number): number => control[index] ?? 0;
    worker.postMessage({ type, request, shared });
    const state = Atomics.wait(control, 0, 0, timeoutMs + 2_000);
    if (state === 'timed-out') {
      if (at(3) > 0) lastBrowserPid = at(3);
      Atomics.store(control, 0, 3);
      throw new Error(`Chromium scene capture exceeded ${timeoutMs}ms; browser cleanup is pending`);
    }
    if (at(0) !== 1) {
      const size = Math.min(at(2), ERROR_BYTES);
      const message = new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, size));
      throw new Error(`Chromium scene capture failed: ${message || 'worker failed'}`);
    }
    if (at(3) > 0) lastBrowserPid = at(3);
    if (type === 'close') return { rgba: new Uint8Array() };
    const length = at(1);
    const rgba = new Uint8Array(shared, HEADER_BYTES + ERROR_BYTES, length).slice();
    const fontLength = Math.min(at(2), ERROR_BYTES);
    const loadedFonts = JSON.parse(
      new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, fontLength)),
    ) as string[];
    return { rgba, loadedFonts };
  }

  return {
    get browserProcessId(): number | undefined {
      return lastBrowserPid;
    },
    capture(request): HeadlessSurface {
      if (closed) throw new Error('Chromium scene driver is closed');
      assertCaptureRequest(request);
      return exchange('capture', request);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        exchange('close');
        process.removeListener('exit', cleanupBrowserOnExit);
      } finally {
        void worker.terminate();
      }
    },
  };
}

function assertCaptureRequest(request: HeadlessCaptureRequest): void {
  if (
    !Number.isSafeInteger(request.width) ||
    !Number.isSafeInteger(request.height) ||
    request.width < 1 ||
    request.height < 1
  )
    throw new RangeError('scene capture viewport must be positive integer dimensions');
  if (request.width * request.height > MAX_CAPTURE_PIXELS)
    throw new RangeError(`scene capture is limited to ${MAX_CAPTURE_PIXELS} pixels`);
  if (!Number.isSafeInteger(request.timeUs) || request.timeUs < 0)
    throw new RangeError('scene capture timeUs must be a non-negative safe integer');
  if (typeof request.markup !== 'string')
    throw new TypeError('scene capture markup must be a string');
  for (const line of request.lines ?? []) {
    if (
      !line.text ||
      !line.font ||
      !Number.isFinite(line.x) ||
      !Number.isFinite(line.y) ||
      (line.height !== undefined && (!Number.isFinite(line.height) || line.height <= 0))
    )
      throw new TypeError(
        'explicit scene capture lines require text, font, and finite x/y coordinates',
      );
  }
}

/** Exposed for integration diagnostics without leaking the temporary profile. */
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
