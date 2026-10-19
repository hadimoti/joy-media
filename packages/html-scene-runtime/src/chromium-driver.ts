/** Persistent CDP implementation for deterministic, bounded scene captures. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function playwrightCandidates(): string[] {
  const roots = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : process.platform === 'win32'
      ? [process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '']
      : [join(process.env.HOME ?? '', '.cache', 'ms-playwright')];
  const candidates: { revision: number; paths: string[] }[] = [];
  for (const root of roots.filter(Boolean)) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^chromium-(\d+)$/.exec(entry);
      if (!match) continue;
      const revision = Number(match[1]);
      const base = join(root, entry);
      candidates.push({
        revision,
        paths:
          process.platform === 'win32'
            ? [join(base, 'chrome-win64', 'chrome.exe'), join(base, 'chrome-win', 'chrome.exe')]
            : [join(base, 'chrome-linux', 'chrome')],
      });
    }
  }
  return candidates.sort((a, b) => b.revision - a.revision).flatMap(({ paths }) => paths);
}

export function findChromiumExecutable(): string | undefined {
  return [...CHROMIUM_CANDIDATES, ...playwrightCandidates()].find((candidate) =>
    existsSync(candidate),
  );
}

function killVerifiedChromium(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  const probe =
    process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
        })
      : spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
          encoding: 'utf8',
          shell: false,
        });
  if (probe.error !== undefined || probe.status !== 0) return;
  if (!/(chrom|msedge|headless_shell)/i.test(probe.stdout)) return;
  try {
    process.kill(pid);
  } catch {
    /* already exited */
  }
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
const HEADER_BYTES = 16;
const ERROR_BYTES = 8192;
let browser;
let socket;
let endpoint;
let targetId;
let sessionId;
let measureSessionId;
let measurementPageReady = false;
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

async function closeBrowser(skipProtocolClose) {
  const activeSocket = socket;
  if (activeSocket) {
    if (!skipProtocolClose && activeSocket.readyState === WebSocket.OPEN) {
      try { await send('Browser.close', {}); } catch (ignored) { /* bounded best effort */ }
    }
    try { activeSocket.close(); } catch (ignored) { /* already closed */ }
  }
  const child = browser;
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  }
  browser = undefined;
  socket = undefined;
  endpoint = undefined;
  targetId = undefined;
  sessionId = undefined;
  measureSessionId = undefined;
  measurementPageReady = false;
  if (activeControl) activeControl[3] = 0;
}

async function ensureBrowser(request) {
  if (socket && targetId) return;
  browser = spawn(workerData.executablePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--lang=en-US',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost', '--remote-debugging-port=0',
    '--user-data-dir=' + workerData.profileDirectory, '--window-size=' + request.width + ',' + request.height,
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

async function measure(requests) {
  await ensureBrowser({ width: 1, height: 1 });
  if (!measureSessionId) {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    measureSessionId = attached.sessionId;
    await send('Page.enable', {}, measureSessionId);
    await send('Runtime.enable', {}, measureSessionId);
  }
  if (!measurementPageReady) {
    const markup = '<!doctype html><html><head><meta charset="utf-8"><style>' + workerData.fontCss + '</style></head><body></body></html>';
    const loaded = waitForEvent('Page.loadEventFired');
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(markup).toString('base64') }, measureSessionId);
    if ((await loaded).timeout) throw new Error('Chromium measurement document load timed out');
    measurementPageReady = true;
  }
  const fonts = '(async()=>{const faces=' + JSON.stringify(workerData.faces) + ';for(const face of faces){const sample=face.subset===\'arabic\'?String.fromCodePoint(0x627,0x644,0x639,0x631,0x628,0x64a,0x629,0x20,0x641,0x627,0x631,0x633,0x6cc):\'Noto Sans Arabic\';const list=await document.fonts.load(face.weight+\' 16px "Noto Sans Arabic"\',sample);if(!list.length||!document.fonts.check(face.weight+\' 16px "Noto Sans Arabic"\',sample))throw new Error("Noto Sans Arabic face failed to load: "+face.subset+" "+face.weight)}return true})()';
  await evaluateIn(measureSessionId, fonts);
  return await evaluateIn(measureSessionId, '(()=>{const requests=' + JSON.stringify(requests) + ';const context=document.createElement("canvas").getContext("2d");return requests.map(r=>{context.font=r.weight+" "+r.fontSizePx+"px \\"Noto Sans Arabic\\"";return context.measureText(r.text).width})})()');
}

async function evaluateIn(session, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Chromium measurement failed');
  return result.result && result.result.value;
}

async function handle(message) {
  const control = new Int32Array(message.shared, 0, 4);
  const bytes = new Uint8Array(message.shared);
  activeControl = control;
  let budgetExpired = false;
  try {
    if (message.type === 'close') {
      await closeBrowser();
      Atomics.store(control, 0, 1);
    } else {
      if (message.type === 'measure') {
        if (!Array.isArray(message.request)) throw new Error('Chromium measurement requests are missing');
        let measureTimer;
        const result = await Promise.race([
          measure(message.request),
          new Promise((resolve, reject) => { measureTimer = setTimeout(() => reject(new Error('Chromium text measurement exceeded its ' + workerData.timeoutMs * 4 + 'ms budget')), workerData.timeoutMs * 4); }),
        ]).finally(() => clearTimeout(measureTimer));
        const payload = Buffer.from(JSON.stringify(result), 'utf8');
        if (payload.byteLength > bytes.byteLength - HEADER_BYTES - ERROR_BYTES) throw new Error('Chromium measurement result exceeds shared-memory capacity');
        bytes.set(payload, HEADER_BYTES + ERROR_BYTES); control[1] = payload.byteLength; control[3] = browser ? browser.pid || 0 : 0;
        Atomics.store(control, 0, 1);
      } else {
      if (!message.request) throw new Error('Chromium capture request is missing');
      const budgetMs = workerData.timeoutMs * 4;
      let budgetTimer;
      const result = await Promise.race([
        capture(message.request),
        new Promise((resolve, reject) => {
          budgetTimer = setTimeout(() => {
            budgetExpired = true;
            reject(new Error('Chromium scene capture exceeded its ' + budgetMs + 'ms budget'));
          }, budgetMs);
        }),
      ]).finally(() => clearTimeout(budgetTimer));
      const outputAt = HEADER_BYTES + ERROR_BYTES;
      bytes.set(result.rgba, outputAt);
      const fonts = Buffer.from(JSON.stringify(result.loadedFonts || []), 'utf8');
      control[1] = result.rgba.byteLength;
      control[2] = Math.min(fonts.byteLength, ERROR_BYTES);
      control[3] = browser ? browser.pid || 0 : 0;
      bytes.set(fonts.subarray(0, ERROR_BYTES), HEADER_BYTES);
      if (Atomics.compareExchange(control, 0, 0, 1) !== 0) {
        await closeBrowser(true);
        return;
      }
      }
    }
  } catch (error) {
    await closeBrowser(budgetExpired);
    control[3] = 0;
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
  const profileDirectory = mkdtempSync(join(tmpdir(), 'joy-scene-cdp-'));
  const worker = new Worker(CHROMIUM_WORKER_SOURCE, {
    eval: true,
    workerData: {
      executablePath,
      timeoutMs,
      profileDirectory,
      painterScript: SCENE_PAINT_SCRIPT,
      fontCss: notoSansArabicFontCss(faces),
      faces: faces.map(({ weight, subset }) => ({ weight, subset })),
    },
  });
  worker.unref();
  let closed = false;
  let lastBrowserPid: number | undefined;
  const cleanupBrowserOnExit = (): void => {
    killVerifiedChromium(lastBrowserPid);
    try {
      rmSync(profileDirectory, { recursive: true, force: true });
    } catch {
      /* best effort during exit */
    }
  };
  process.once('exit', cleanupBrowserOnExit);

  function exchange(
    type: 'capture' | 'close' | 'measure',
    request?:
      HeadlessCaptureRequest | readonly { text: string; fontSizePx: number; weight: 400 | 700 }[],
  ): HeadlessSurface {
    const pixels = request && 'width' in request ? request.width * request.height : 0;
    const extra =
      type === 'measure' ? Math.max(1024, JSON.stringify(request).length * 4) : pixels * 4;
    const shared = new SharedArrayBuffer(HEADER_BYTES + ERROR_BYTES + extra);
    const control = new Int32Array(shared, 0, 4);
    const at = (index: number): number => control[index] ?? 0;
    worker.postMessage({ type, request, shared });
    const budgetMs = timeoutMs * 4;
    const waitMs = (type === 'close' ? timeoutMs : budgetMs) + 2_000;
    const state = Atomics.wait(control, 0, 0, waitMs);
    lastBrowserPid = at(3) > 0 ? at(3) : undefined;
    if (state === 'timed-out') {
      Atomics.store(control, 0, 3);
      throw new Error(
        `Chromium ${type === 'measure' ? 'text measurement' : 'scene capture'} exceeded ${type === 'close' ? timeoutMs : budgetMs}ms; browser cleanup is pending`,
      );
    }
    if (at(0) !== 1) {
      const size = Math.min(at(2), ERROR_BYTES);
      const message = new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, size));
      throw new Error(
        `Chromium ${type === 'measure' ? 'text measurement' : 'scene capture'} failed: ${message || 'worker failed'}`,
      );
    }
    if (type === 'close') return { rgba: new Uint8Array() };
    if (type === 'measure') {
      const length = at(1);
      const widths = JSON.parse(
        new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES + ERROR_BYTES, length)),
      ) as number[];
      if (!Array.isArray(widths) || widths.some((width) => !Number.isFinite(width) || width < 0))
        throw new Error('Chromium text measurement returned invalid widths');
      return { rgba: new Uint8Array(), loadedFonts: widths.map(String) };
    }
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
    measureTextWidths(requests) {
      if (closed) throw new Error('Chromium scene driver is closed');
      for (const request of requests) {
        if (!Number.isFinite(request.fontSizePx) || request.fontSizePx <= 0)
          throw new RangeError('text measurement fontSizePx must be finite and positive');
        if (request.weight !== 400 && request.weight !== 700)
          throw new RangeError('text measurement weight must be 400 or 700');
        if (typeof request.text !== 'string')
          throw new TypeError('text measurement text must be a string');
      }
      const result = exchange('measure', requests);
      return (result.loadedFonts ?? []).map(Number);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        try {
          exchange('close');
        } catch (error) {
          killVerifiedChromium(lastBrowserPid);
          throw error;
        }
      } finally {
        const removeProfile = (): void => {
          try {
            rmSync(profileDirectory, { recursive: true, force: true });
          } catch {
            /* best effort after worker termination */
          }
          process.removeListener('exit', cleanupBrowserOnExit);
        };
        void worker.terminate().then(removeProfile, removeProfile);
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
