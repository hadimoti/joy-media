/** Persistent CDP implementation for deterministic, bounded scene captures. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import type { HeadlessCaptureRequest, HeadlessSceneDriver, HeadlessSurface } from './headless.js';
import { loadNotoSansArabicFaces, notoSansArabicFontCss } from './fonts.js';
import { isScenePaintFrame } from './preview-protocol.js';
import { SCENE_PAINT_SCRIPT } from './preview-protocol.js';

declare module './headless.js' {
  interface HeadlessCaptureRequest {
    readonly rejectImages?: boolean;
  }
}

export interface ChromiumSceneDriverOptions {
  /** Absolute trusted path to JOY's Chromium binary. */
  readonly executablePath?: string;
  /** Startup and per-capture deadline; defaults to 15 seconds. */
  readonly timeoutMs?: number;
  /** Test seam for deterministic worker and process-tree ownership checks. */
  readonly workerFactory?: (source: string, options: WorkerOptions) => ChromiumWorker;
  readonly killTree?: (pid: number | undefined, profileDirectory?: string) => void;
  readonly removeProfile?: (directory: string) => void;
}

interface ChromiumWorker {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: { type?: string; requestId?: string }) => void): this;
  off(event: 'message', listener: (message: { type?: string; requestId?: string }) => void): this;
  once(event: 'error', listener: (error: unknown) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
  unref(): void;
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

function chromiumPidsForProfile(
  profileDirectory: string,
  timeoutMs = 1_500,
  runSpawnSync: typeof spawnSync = spawnSync,
): number[] {
  const escapedProfile = profileDirectory.replace(/'/g, "''");
  const scan = runSpawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$profile='${escapedProfile}'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs },
  );
  if (scan.error !== undefined || scan.status !== 0)
    throw new Error(
      `cannot verify Chromium processes for profile: ${scan.stderr || scan.error?.message || `status ${scan.status}`}`,
    );
  return scan.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

export function killChromiumTree(
  pid: number | undefined,
  profileDirectory?: string,
  runSpawnSync: typeof spawnSync = spawnSync,
  removeProfileDirectory: (directory: string) => void = (directory) =>
    rmSync(directory, { recursive: true, force: true }),
): void {
  const validPid = pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
  if (!validPid && (process.platform !== 'win32' || profileDirectory === undefined)) return;
  if (process.platform === 'win32') {
    const deadline = Date.now() + 2_000;
    let remaining: number[] = validPid ? [pid!] : [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const remainingPid of remaining) {
        if (Date.now() >= deadline) break;
        runSpawnSync('taskkill', ['/T', '/F', '/PID', String(remainingPid)], {
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          timeout: Math.max(1, deadline - Date.now()),
        });
        // Keep processing every profile-owned PID from the scan. A successful parent kill
        // does not prove that previously discovered browser processes have all exited.
      }
      if (attempt === 0 && profileDirectory !== undefined) {
        const everyOwnedProcessExited = remaining.every((ownedPid) => {
          try {
            process.kill(ownedPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'EPERM';
          }
        });
        let profileRemovedOnFirstAttempt = false;
        try {
          removeProfileDirectory(profileDirectory);
          profileRemovedOnFirstAttempt = !existsSync(profileDirectory);
        } catch {
          // A failed first removal requires the process scan, even when the root PID exited.
        }
        if (everyOwnedProcessExited && profileRemovedOnFirstAttempt) return;
      }
      if (profileDirectory !== undefined) {
        // The scan has its own budget. taskkill can use most of the shared deadline on a loaded
        // machine, and a scan starved of time reports a false "cannot verify" failure.
        remaining = chromiumPidsForProfile(profileDirectory, 2_000, runSpawnSync);
      } else {
        try {
          process.kill(pid!, 0);
          remaining = [pid!];
        } catch {
          remaining = [];
        }
      }
      if (remaining.length === 0) return;
    }
    throw new Error(
      `Chromium process tree survivors after 3 taskkill attempts: ${remaining.join(', ')}`,
    );
  }
  try {
    process.kill(-pid!, 'SIGKILL');
  } catch {
    try {
      process.kill(pid!, 'SIGKILL');
    } catch {
      /* already exited */
    }
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
const { spawn, spawnSync } = require('node:child_process');
const HEADER_BYTES = 16;
const ERROR_BYTES = 8192;
let browser;
let socket;
let endpoint;
let targetId;
let sessionId;
let browserVersion;
let measureSessionId;
let measurementPageReady = false;
let activeControl;
let sequence = 0;
const pending = new Map();
const eventWaiters = new Map();
let tail = Promise.resolve();
let activeDeadline = 0;

function killBrowserTree(pid, deadline = Date.now() + 2000) {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    // taskkill and PowerShell startup can use most of a 2-second shared deadline on a loaded host.
    // Windows cleanup gets its own budget, so a starved scan is not reported as a failed kill.
    const cleanupDeadline = Math.max(deadline, Date.now() + 10000);
    const remainingMs = () => Math.max(1, cleanupDeadline - Date.now());
    const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true, shell: false, timeout: remainingMs() });
    if (!result.error && result.status === 0) return;
    // taskkill exits non-zero when a child process exited before its own kill. That is benign, so the
    // profile scan decides whether any Chromium process survived.
    const escapedProfile = workerData.profileDirectory.replace(/'/g, "''");
    const scanProfile = () => {
      const scan = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$profile='" + escapedProfile + "'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8', windowsHide: true, shell: false, timeout: remainingMs() });
      if (scan.error || scan.status !== 0) throw new Error('cannot verify Chromium processes for its isolated profile');
      return String(scan.stdout || '').split(/\r?\n/).map((line) => Number(line.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
    };
    let remaining = scanProfile();
    for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
      for (const remainingPid of remaining) {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(remainingPid)], { encoding: 'utf8', windowsHide: true, shell: false, timeout: remainingMs() });
      }
      remaining = scanProfile();
    }
    if (remaining.length === 0) return;
    throw new Error('Chromium process tree survivors after taskkill of ' + pid + ': ' + remaining.join(', ') + ' (' + ((result.stderr || (result.error && result.error.message)) || ('status ' + result.status)) + ')');
  }
  try { process.kill(-pid, 'SIGKILL'); } catch (ignored) {
    try { process.kill(pid, 'SIGKILL'); } catch (alreadyExited) { /* already exited */ }
  }
}

function send(method, params, session) {
  const activeSocket = socket;
  if (!activeSocket) return Promise.reject(new Error('Chromium DevTools WebSocket is not connected'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP command timed out: ' + method));
    }, Math.max(1, activeDeadline - Date.now()));
    pending.set(id, { resolve, reject, timer });
    activeSocket.send(JSON.stringify({ id, method, params: params || {}, ...(session ? { sessionId: session } : {}) }));
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const connection = new WebSocket(url);
    socket = connection;
    const timer = setTimeout(() => reject(new Error('Chromium DevTools WebSocket startup timed out')), Math.max(1, activeDeadline - Date.now()));
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
    }, Math.max(1, activeDeadline - Date.now()));
  });
}

function waitForEndpoint() {
  return new Promise((resolve, reject) => {
    let output = '';
    let foundEndpoint;
    const timer = setTimeout(() => reject(new Error('Chromium DevTools endpoint startup timed out')), Math.max(1, activeDeadline - Date.now()));
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
      try {
        await Promise.race([
          send('Browser.close', {}),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
      } catch (ignored) { /* bounded best effort */ }
    }
    try { activeSocket.close(); } catch (ignored) { /* already closed */ }
  }
  const child = browser;
  let killError;
  if (child && child.pid) {
    const deadline = Date.now() + 2000;
    try { killBrowserTree(child.pid, deadline); } catch (error) { killError = error; }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null)
      throw new Error('Chromium process tree did not stop within 2 seconds');
  }
  browser = undefined;
  socket = undefined;
  endpoint = undefined;
  targetId = undefined;
  sessionId = undefined;
  browserVersion = undefined;
  measureSessionId = undefined;
  measurementPageReady = false;
  if (activeControl && !killError) activeControl[3] = 0;
      if (killError) throw killError;
}

async function ensureBrowser(request) {
  if (socket && targetId) return;
  browser = spawn(workerData.executablePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--lang=en-US',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost', '--remote-debugging-port=0',
    '--user-data-dir=' + workerData.profileDirectory, '--window-size=' + request.width + ',' + request.height,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
  if (activeControl && browser.pid) activeControl[3] = browser.pid;
  endpoint = await waitForEndpoint();
  await connect(endpoint);
  const version = await send('Browser.getVersion');
  browserVersion = typeof version.product === 'string' ? version.product.trim() : undefined;
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
  activeDeadline = Date.now() + workerData.timeoutMs;
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
  const rejectImages = request.rejectImages === true;
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
      ',' +
      JSON.stringify(rejectImages) +
      ',' +
      JSON.stringify(request.paint || null) +
      ')',
  );
  if (typeof result !== 'string') throw new Error('scene painter returned no RGBA payload');
  const rgba = Buffer.from(result, 'base64');
  if (rgba.byteLength !== request.width * request.height * 4) throw new Error('scene painter returned an invalid RGBA byte length');
  return { rgba, loadedFonts, browserVersion };
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
  activeDeadline = Date.now() + (message.type === 'close' ? 250 : workerData.timeoutMs);
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
          new Promise((resolve, reject) => { measureTimer = setTimeout(() => reject(new Error('Chromium text measurement exceeded its ' + workerData.timeoutMs + 'ms budget')), workerData.timeoutMs); }),
        ]).finally(() => clearTimeout(measureTimer));
        const payload = Buffer.from(JSON.stringify(result), 'utf8');
        if (payload.byteLength > bytes.byteLength - HEADER_BYTES - ERROR_BYTES) throw new Error('Chromium measurement result exceeds shared-memory capacity');
        bytes.set(payload, HEADER_BYTES + ERROR_BYTES); control[1] = payload.byteLength; control[3] = browser ? browser.pid || 0 : 0;
        Atomics.store(control, 0, 1);
      } else {
      if (!message.request) throw new Error('Chromium capture request is missing');
      const budgetMs = workerData.timeoutMs;
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
      const fonts = Buffer.from(JSON.stringify({ loadedFonts: result.loadedFonts || [], browserVersion: result.browserVersion }), 'utf8');
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
    let message = error && error.message ? error.message : String(error);
    try {
      await closeBrowser(budgetExpired);
    } catch (cleanupError) {
      message += '; browser cleanup failed: ' + (cleanupError && cleanupError.message ? cleanupError.message : String(cleanupError));
    }
    const messageBytes = Buffer.from(message, 'utf8').subarray(0, ERROR_BYTES);
    bytes.set(messageBytes, HEADER_BYTES);
    control[2] = messageBytes.byteLength;
    Atomics.store(control, 0, 2);
  }
  Atomics.notify(control, 0);
  parentPort.postMessage({ type: 'complete', requestId: message.requestId });
}

parentPort.on('message', (message) => {
  if (message.type === 'abort') {
    const control = new Int32Array(message.shared, 0, 4);
    Atomics.compareExchange(control, 0, 0, 3);
    void closeBrowser(true).then(() => {
      Atomics.store(control, 0, 4);
      Atomics.notify(control, 0);
      parentPort.postMessage({ type: 'aborted', requestId: message.requestId });
    }, () => {
      Atomics.store(control, 0, 5);
      Atomics.notify(control, 0);
      parentPort.postMessage({ type: 'aborted', requestId: message.requestId, failed: true });
    });
    return;
  }
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
  let worker: ChromiumWorker;
  const removeProfileDirectory =
    options.removeProfile ??
    ((directory: string) => rmSync(directory, { recursive: true, force: true }));
  const killTree =
    options.killTree ??
    ((pid: number | undefined, profile?: string) =>
      killChromiumTree(pid, profile, spawnSync, removeProfileDirectory));
  try {
    const workerOptions: WorkerOptions = {
      eval: true,
      workerData: {
        executablePath,
        timeoutMs,
        profileDirectory,
        painterScript: SCENE_PAINT_SCRIPT,
        fontCss: notoSansArabicFontCss(faces),
        faces: faces.map(({ weight, subset }) => ({ weight, subset })),
      },
    };
    worker = options.workerFactory
      ? options.workerFactory(CHROMIUM_WORKER_SOURCE, workerOptions)
      : new Worker(CHROMIUM_WORKER_SOURCE, workerOptions);
  } catch (error) {
    rmSync(profileDirectory, { recursive: true, force: true });
    throw error;
  }
  worker.unref();
  let closed = false;
  let lastBrowserPid: number | undefined;
  let sessionPidControl: Int32Array | undefined;
  let cleanupTask: Promise<void> | undefined;
  let cancellationDeadlineAt: number | undefined;
  let profileRemoved = false;
  const removeProfile = (): void => {
    if (profileRemoved) return;
    profileRemoved = true;
    try {
      removeProfileDirectory(profileDirectory);
    } catch {
      /* best effort during exit; normal close retries after worker termination */
      profileRemoved = false;
    }
  };
  const cleanupBrowserOnExit = (): void => {
    try {
      const sharedPid = sessionPidControl ? Atomics.load(sessionPidControl, 3) : 0;
      killTree(sharedPid > 0 ? sharedPid : lastBrowserPid, profileDirectory);
    } catch {
      /* process exit must continue; normal operations surface the cleanup error */
    }
    removeProfile();
  };
  process.once('exit', cleanupBrowserOnExit);

  const cleanupAfterWorkerEnd = (): Promise<void> => {
    if (cleanupTask) return cleanupTask;
    cleanupTask = (async () => {
      const deadline = cancellationDeadlineAt ?? Date.now() + 2_000;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let workerStopped: boolean;
      try {
        workerStopped = await Promise.race([
          worker.terminate().then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            terminationTimer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally {
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      }
      if (!workerStopped)
        throw new Error('Capture worker did not stop before its cleanup deadline');
      const sharedPid = sessionPidControl ? Atomics.load(sessionPidControl, 3) : 0;
      const pid = sharedPid > 0 ? sharedPid : lastBrowserPid;
      killTree(pid, profileDirectory);
      lastBrowserPid = undefined;
      if (sessionPidControl) Atomics.store(sessionPidControl, 3, 0);
      await removeProfileWithRetries(cancellationDeadlineAt ?? Date.now() + 2_000);
      process.removeListener('exit', cleanupBrowserOnExit);
    })().catch((error: unknown) => {
      cleanupTask = undefined;
      throw error;
    });
    return cleanupTask;
  };
  const removeProfileWithRetries = async (deadline: number): Promise<void> => {
    let lastError: unknown;
    while (existsSync(profileDirectory) && Date.now() < deadline) {
      try {
        removeProfileDirectory(profileDirectory);
        lastError = undefined;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
        lastError = error;
      }
      if (existsSync(profileDirectory))
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
        );
    }
    if (existsSync(profileDirectory))
      throw lastError ?? new Error('Chromium profile remained after bounded cleanup');
  };
  worker.once('error', () => {
    void cleanupAfterWorkerEnd().catch(() => {
      /* Keep ownership and the exit hook so close() can retry. */
    });
  });
  worker.once('exit', (code) => {
    if (code !== 0 && !closed)
      void cleanupAfterWorkerEnd().catch(() => {
        /* Keep ownership and the exit hook so close() can retry. */
      });
  });

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
    sessionPidControl = control;
    const at = (index: number): number => control[index] ?? 0;
    worker.postMessage({ type, request, shared });
    const budgetMs = timeoutMs;
    // A Windows worker's cleanup can use its own 10-second budget before it reports.
    const waitMs = type === 'close' ? 250 + 10_000 + 2_000 + 500 : budgetMs + 2_000;
    const state = Atomics.wait(control, 0, 0, waitMs);
    lastBrowserPid = at(3) > 0 ? at(3) : lastBrowserPid;
    if (state === 'timed-out') {
      Atomics.store(control, 0, 3);
      closed = true;
      void worker.terminate();
      void cleanupAfterWorkerEnd().catch(() => {
        /* Keep ownership and the exit hook so close() can retry. */
      });
      throw new Error(
        `Chromium ${type === 'measure' ? 'text measurement' : 'scene capture'} exceeded ${type === 'close' ? waitMs : budgetMs}ms; browser process tree was stopped and its profile removed`,
      );
    }
    if (at(0) !== 1) {
      const size = Math.min(at(2), ERROR_BYTES);
      const message = new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, size));
      closed = true;
      void worker.terminate();
      void cleanupAfterWorkerEnd().catch(() => {
        /* Keep ownership and the exit hook so close() can retry. */
      });
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
    const captureFacts = JSON.parse(
      new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, fontLength)),
    ) as { readonly loadedFonts?: string[]; readonly browserVersion?: string };
    lastBrowserVersion = captureFacts.browserVersion;
    return {
      rgba,
      ...(captureFacts.loadedFonts === undefined ? {} : { loadedFonts: captureFacts.loadedFonts }),
    };
  }

  let lastBrowserVersion: string | undefined;

  async function exchangeAsync(
    type: 'capture' | 'close',
    request?: HeadlessCaptureRequest,
    signal?: AbortSignal,
  ): Promise<HeadlessSurface> {
    if (signal?.aborted) throw new Error('Render cancelled before title capture.');
    const pixels = request ? request.width * request.height : 0;
    const shared = new SharedArrayBuffer(HEADER_BYTES + ERROR_BYTES + pixels * 4);
    const control = new Int32Array(shared, 0, 4);
    sessionPidControl = control;
    const requestId = `${Date.now()}-${Math.random()}`;
    let abortSent = false;
    let resolveAbort!: () => void;
    const abortRequested = new Promise<'signal-abort'>((resolve) => {
      resolveAbort = () => resolve('signal-abort');
    });
    const abort = (): void => {
      if (abortSent) return;
      abortSent = true;
      const reason = signal?.reason;
      const requestedDeadline =
        typeof reason === 'object' && reason !== null && 'deadlineAt' in reason
          ? reason.deadlineAt
          : undefined;
      cancellationDeadlineAt ??=
        typeof requestedDeadline === 'number' && Number.isFinite(requestedDeadline)
          ? requestedDeadline
          : Date.now() + 5_000;
      Atomics.compareExchange(control, 0, 0, 3);
      Atomics.notify(control, 0);
      worker.postMessage({ type: 'abort', shared, requestId });
      resolveAbort();
    };
    const onAbort = (): void => abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const completion = new Promise<'complete' | 'aborted'>((resolve) => {
      const listener = (message: { type?: string; requestId?: string }): void => {
        if (message.requestId !== requestId) return;
        if (message.type === 'complete' || message.type === 'aborted') {
          worker.off('message', listener);
          resolve(message.type);
        }
      };
      worker.on('message', listener);
    });
    worker.postMessage({ type, request, shared, requestId });
    let operationTimer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([
        completion,
        abortRequested,
        new Promise<'timed-out'>((resolve) => {
          operationTimer = setTimeout(
            () => resolve('timed-out'),
            type === 'close' ? 250 : timeoutMs,
          );
        }),
      ]);
      lastBrowserPid = Atomics.load(control, 3) > 0 ? Atomics.load(control, 3) : lastBrowserPid;
      if (status === 'timed-out') {
        abort();
        if (type !== 'close')
          await Promise.race([
            completion,
            new Promise<void>((resolve) => setTimeout(resolve, 250)),
          ]);
        lastBrowserPid = Atomics.load(control, 3) > 0 ? Atomics.load(control, 3) : lastBrowserPid;
        closed = true;
        let cancelError: unknown;
        try {
          await cleanupAfterWorkerEnd();
        } catch (error) {
          cancelError = error;
        }
        const workerStopped = await Promise.race([
          worker.terminate().then(
            () => true,
            (error: unknown) => {
              cancelError = error;
              return true;
            },
          ),
          new Promise<boolean>((resolve) =>
            setTimeout(
              () => resolve(false),
              Math.max(1, Math.min(500, (cancellationDeadlineAt ?? Date.now()) - Date.now())),
            ),
          ),
        ]);
        if (!workerStopped || cancelError || Date.now() >= (cancellationDeadlineAt ?? 0))
          throw new Error(
            `RENDER_CANCEL_TIMEOUT: Chromium cancellation cleanup exceeded five seconds: ${cancelError instanceof Error ? cancelError.message : String(cancelError ?? 'capture worker did not stop within 500 ms')}`,
          );
        if (type === 'close') return { rgba: new Uint8Array() };
        throw new Error(`RENDER_CAPTURE_TIMEOUT: Chromium ${type} exceeded ${timeoutMs}ms`);
      }
      lastBrowserPid = (control[3] ?? 0) > 0 ? control[3] : lastBrowserPid;
      if (
        status === 'aborted' ||
        signal?.aborted ||
        control[0] === 3 ||
        control[0] === 4 ||
        control[0] === 5
      ) {
        closed = true;
        await Promise.race([completion, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
        lastBrowserPid = Atomics.load(control, 3) > 0 ? Atomics.load(control, 3) : lastBrowserPid;
        let cancelError: unknown;
        try {
          await cleanupAfterWorkerEnd();
        } catch (error) {
          cancelError = error;
        }
        const workerStopped = await Promise.race([
          worker.terminate().then(
            () => true,
            (error: unknown) => {
              cancelError = error;
              return true;
            },
          ),
          new Promise<boolean>((resolve) =>
            setTimeout(
              () => resolve(false),
              Math.max(1, Math.min(500, (cancellationDeadlineAt ?? Date.now()) - Date.now())),
            ),
          ),
        ]);
        if (!workerStopped || cancelError || Date.now() >= (cancellationDeadlineAt ?? 0))
          throw new Error(
            `RENDER_CANCEL_TIMEOUT: Chromium cancellation cleanup exceeded five seconds: ${cancelError instanceof Error ? cancelError.message : String(cancelError ?? 'capture worker did not stop within 500 ms')}`,
          );
        throw new Error('Render cancelled during title capture.');
      }
      if (control[0] !== 1) {
        const length = Math.min(control[2] ?? 0, ERROR_BYTES);
        const message = new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, length));
        lastBrowserPid = Atomics.load(control, 3) > 0 ? Atomics.load(control, 3) : lastBrowserPid;
        closed = true;
        try {
          await cleanupAfterWorkerEnd();
          lastBrowserPid = undefined;
        } catch (cleanupError) {
          throw new Error(
            `Chromium scene capture failed: ${message || 'worker failed'}; browser cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        } finally {
          void worker.terminate();
        }
        throw new Error(`Chromium scene capture failed: ${message || 'worker failed'}`);
      }
      if (type === 'close') return { rgba: new Uint8Array() };
      const length = control[1] ?? 0;
      const rgba = new Uint8Array(shared, HEADER_BYTES + ERROR_BYTES, length).slice();
      const fontLength = Math.min(control[2] ?? 0, ERROR_BYTES);
      const facts = JSON.parse(
        new TextDecoder().decode(new Uint8Array(shared, HEADER_BYTES, fontLength)),
      ) as { readonly loadedFonts?: string[]; readonly browserVersion?: string };
      lastBrowserVersion = facts.browserVersion;
      return {
        rgba,
        ...(facts.loadedFonts === undefined ? {} : { loadedFonts: facts.loadedFonts }),
      };
    } finally {
      if (operationTimer) clearTimeout(operationTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return {
    get browserVersion(): string | undefined {
      if (!lastBrowserVersion && !closed) {
        exchange('capture', {
          markup: '',
          width: 1,
          height: 1,
          transparent: true,
          timeUs: 0,
          frameRate: { num: 1, den: 1 },
          locale: 'en-US',
          seed: 'chromium-version-probe',
          lines: [],
        });
      }
      return lastBrowserVersion;
    },
    get browserProcessId(): number | undefined {
      const sharedPid = sessionPidControl ? Atomics.load(sessionPidControl, 3) : 0;
      return sharedPid > 0 ? sharedPid : lastBrowserPid;
    },
    capture(request): HeadlessSurface {
      if (closed) throw new Error('Chromium scene driver is closed');
      assertCaptureRequest(request);
      return exchange('capture', request);
    },
    async captureAsync(request, signal): Promise<HeadlessSurface> {
      if (closed) throw new Error('Chromium scene driver is closed');
      assertCaptureRequest(request);
      return exchangeAsync('capture', request, signal);
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
      const shouldCloseWorker = !closed;
      closed = true;
      try {
        if (shouldCloseWorker) exchange('close');
      } finally {
        void cleanupAfterWorkerEnd().catch(() => {
          /* Keep ownership so a later closeAsync can retry. */
        });
        if (shouldCloseWorker) void worker.terminate();
      }
    },
    async closeAsync(deadlineAt?: number): Promise<void> {
      cancellationDeadlineAt ??= deadlineAt ?? Date.now() + 5_000;
      const shouldCloseWorker = !closed;
      closed = true;
      let closeError: unknown;
      if (shouldCloseWorker) {
        try {
          await exchangeAsync('close');
        } catch (error) {
          closeError = error;
        }
      }
      try {
        await cleanupAfterWorkerEnd();
      } catch (error) {
        closeError ??= error;
      }
      const workerStopped = await Promise.race([
        worker.terminate().then(
          () => true,
          (error: unknown) => {
            closeError ??= error;
            return true;
          },
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(
            () => resolve(false),
            Math.max(1, Math.min(500, cancellationDeadlineAt! - Date.now())),
          ),
        ),
      ]);
      if (!workerStopped) closeError ??= new Error('Capture worker did not stop within 500 ms');
      if (Date.now() >= cancellationDeadlineAt!)
        closeError ??= new Error('RENDER_CANCEL_TIMEOUT: Chromium cleanup exceeded five seconds');
      if (closeError) throw closeError;
    },
    get profileDirectory(): string {
      return profileDirectory;
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
  if (request.paint !== undefined && !isScenePaintFrame(request.paint))
    throw new TypeError('scene capture paint frame is invalid');
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

export type ChromiumProbeResult = { readonly version: string } | { readonly reason: string };

/** Starts a short-lived isolated headless session and reads its version over CDP. */
export async function probeChromium(
  options: ChromiumSceneDriverOptions & { readonly signal?: AbortSignal } = {},
): Promise<ChromiumProbeResult> {
  const executablePath = options.executablePath ?? findChromiumExecutable();
  if (!executablePath) return { reason: 'Chromium executable was not found.' };
  let driver: HeadlessSceneDriver | undefined;
  try {
    driver = createChromiumSceneDriver({ ...options, executablePath, timeoutMs: 3_000 });
    await driver.captureAsync!(
      {
        markup: '',
        width: 1,
        height: 1,
        transparent: true,
        timeUs: 0,
        frameRate: { num: 1, den: 1 },
        locale: 'en-US',
        seed: 'chromium-version-probe',
        lines: [],
      },
      options.signal,
    );
    const version = driver.browserVersion?.trim();
    if (!version) return { reason: 'Chromium capture session did not report its browser version.' };
    driver.close?.();
    driver = undefined;
    return { version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `Chromium could not be launched headlessly: ${message}` };
  } finally {
    try {
      if (driver?.closeAsync) await driver.closeAsync();
      else driver?.close?.();
    } catch {
      /* close performs tree termination and profile cleanup before reporting an error */
    }
  }
}
