/* global window */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  countFiles,
  isInside,
  linkOnPath,
  ownerDefaultLibrary,
  systemTool,
} from '../../release/attended/scenario-rules.mjs';

export const EXPECTED_JOY_HASH = 'AF05BE55222C86FECE27E738B7E8A931CB4261C9797261C67DDE3C71A4E5CAC0';
export const LOCK_PATH = 'C:\\jgp\\LOCK-app-run.txt';
export const OS_FILE_DROP_SELECTORS = Object.freeze({
  timeline: '.timeline-lane, .timeline-empty-state, .timeline-file-new-track-drop',
  monitor: '.monitor-canvas-wrap',
  media: '.asset-library-main',
});
const APP_NAME = 'joy-media.exe';
const CDP_HOST = '127.0.0.1';
const OWNER_HOME = 'C:\\Users\\HadiMoti';
const DROP_FIXTURE_ROOT = 'C:\\jgp\\v111\\dnd';

function fail(message) {
  const error = new Error(message);
  error.code = 'LIVE_PREFLIGHT_REFUSED';
  return error;
}

/**
 * The environment of a test launch. Every folder is scratch (user data, USERPROFILE, HOME, APPDATA, TEMP,
 * LOCALAPPDATA), except in sign-in mode (`--needs-sign-in`): there LOCALAPPDATA stays the owner's real one, so
 * the sign-in page opens in the normal Chrome profile. Everything else stays scratch in both modes.
 * Pure: it touches no disk. The caller creates `scratchDirs` and prints `modeLine`.
 */
export function buildLaunchEnvironment({ baseEnv, envRoot, needsSignIn, electronDir }) {
  const scratch = {
    USERPROFILE: join(envRoot, 'User'),
    HOME: join(envRoot, 'User'),
    APPDATA: join(envRoot, 'Roaming'),
    TEMP: join(envRoot, 'Temp'),
    TMP: join(envRoot, 'Temp'),
  };
  const env = { ...baseEnv, ...scratch, ELECTRON_OVERRIDE_DIST_PATH: electronDir };
  const scratchDirs = [scratch.USERPROFILE, scratch.APPDATA, scratch.TEMP];
  if (needsSignIn) {
    const realLocalAppData = baseEnv.LOCALAPPDATA;
    if (!realLocalAppData) {
      throw fail('--needs-sign-in needs the real LOCALAPPDATA, and this environment has none');
    }
    env.LOCALAPPDATA = realLocalAppData;
    return {
      env,
      scratchDirs,
      mode: 'sign-in',
      modeLine:
        'mode: sign-in (LOCALAPPDATA is the real one, kept for the sign-in page; user data, USERPROFILE, HOME, APPDATA and TEMP are scratch)',
    };
  }
  env.LOCALAPPDATA = join(envRoot, 'Local');
  scratchDirs.push(env.LOCALAPPDATA);
  return {
    env,
    scratchDirs,
    mode: 'scratch',
    modeLine: 'mode: scratch (every folder is scratch; no sign-in)',
  };
}

export async function checkLaunchRules(config, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') throw fail('live app runs require Windows');

  const appDir = resolve(config.appDir);
  const appExe = join(appDir, APP_NAME);
  if (!isAbsolute(config.appDir) || !existsSync(appExe)) {
    throw fail('unpacked joy-media.exe is missing');
  }
  const ownerHome = deps.ownerHome ?? OWNER_HOME;
  const installedDir =
    deps.installedDir ?? join(ownerHome, 'AppData', 'Local', 'Programs', 'JOY Media');
  if (isInside(appExe, installedDir)) throw fail('refusing to launch the installed JOY Media app');

  const playwrightPackage = join(
    appDir,
    'resources',
    'app',
    'node_modules',
    'playwright-core',
    'package.json',
  );
  if (!existsSync(playwrightPackage)) {
    throw fail('playwright-core is missing from the unpacked app');
  }

  const electronDir = resolve(config.electronDir ?? process.env.ELECTRON_OVERRIDE_DIST_PATH ?? '');
  if (electronDir === resolve('.') || !isAbsolute(electronDir)) {
    throw fail('ELECTRON_OVERRIDE_DIST_PATH is required');
  }
  if (!existsSync(join(electronDir, 'electron.exe'))) {
    throw fail('Electron 44.3.0 cache is missing electron.exe');
  }
  const versionFile = join(electronDir, 'version');
  const version =
    deps.electronVersion ??
    (existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '');
  if (version !== '44.3.0') throw fail('Electron 44.3.0 is required');

  const runPaths = {
    out: config.outDir,
    profile: config.profileDir,
    library: config.libraryDir,
  };
  for (const [name, path] of Object.entries(runPaths)) {
    if (!path || !isAbsolute(path)) throw fail(`${name} path must be absolute`);
    const abs = resolve(path);
    if (isInside(abs, process.cwd())) throw fail(`${name} path must be outside the worktree`);
    if (linkOnPath(abs)) throw fail(`${name} path contains a link or junction`);
  }
  if (existsSync(config.outDir) && readdirSync(config.outDir).length > 0) {
    throw fail('output folder must be empty so prior evidence is not overwritten');
  }
  const protectedRoots = [
    ownerDefaultLibrary(ownerHome),
    join(ownerHome, 'Desktop'),
    join(ownerHome, 'Downloads'),
    join(ownerHome, 'joy-media'),
    installedDir,
    join(ownerHome, 'AppData', 'Roaming', '@joy-media'),
    join(ownerHome, 'AppData', 'Roaming', 'JOY Media'),
  ];
  for (const [name, path] of Object.entries(runPaths)) {
    const abs = resolve(path);
    if (protectedRoots.some((root) => isInside(abs, root) || isInside(root, abs))) {
      throw fail(`${name} path overlaps a protected owner folder`);
    }
  }
  const paths = Object.values(runPaths);
  const pathsOverlap = paths.some((path, index) =>
    paths.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        (isInside(resolve(path), resolve(other)) || isInside(resolve(other), resolve(path))),
    ),
  );
  if (pathsOverlap) {
    throw fail('output, profile, and scratch library paths must be separate');
  }
  if (existsSync(config.profileDir)) throw fail('profile path must be new for each run');
  if (existsSync(config.libraryDir)) throw fail('scratch library path must be new for each run');
  if (
    config.needsSignIn &&
    config.localAppData !== undefined &&
    config.localAppData !== process.env.LOCALAPPDATA
  ) {
    throw fail('--needs-sign-in must retain the real LOCALAPPDATA');
  }

  const lock = deps.lock ?? inspectLock(config.lockPath ?? LOCK_PATH);
  if (lock.status === 'busy') throw fail('app lock is younger than 30 minutes');
  if (lock.status === 'error') throw fail('could not inspect the app lock');
  const joyHash = deps.joyHash ?? exportJoyHash(config.outDir);
  if (joyHash !== EXPECTED_JOY_HASH) {
    throw fail('joy:// registry hash does not match the approved value');
  }
  const before = deps.ownerLibraryFiles ?? countFiles(ownerDefaultLibrary(ownerHome));
  const running = deps.runningProcesses ?? countJoyAndElectronProcesses(appDir);
  if (running !== 0) throw fail('a JOY Media or Electron process is already running');
  const portAvailable = deps.portAvailable ?? (await isPortAvailable());
  if (!portAvailable) throw fail('could not reserve a CDP port');
  return { appDir, appExe, electronDir, ownerLibraryFiles: before, joyHash };
}

export function verifyAfterRun(before, after) {
  if (after.joyHash !== EXPECTED_JOY_HASH || after.joyHash !== before.joyHash) {
    throw fail('joy:// registry hash changed during the run');
  }
  if (after.ownerLibraryFiles !== before.ownerLibraryFiles) {
    throw fail('owner library file count changed during the run');
  }
  if (after.runningProcesses !== 0) {
    throw fail('a JOY Media or Electron process remains after the run');
  }
}

/** Dispatch a Chromium trusted drag event using real files from the isolated fixture folder. */
export async function dispatchOSFileDrop(
  page,
  surface,
  filePaths,
  { allowedRoot = DROP_FIXTURE_ROOT, selector, position } = {},
) {
  const targetSelector = selector ?? OS_FILE_DROP_SELECTORS[surface];
  if (targetSelector === undefined) throw fail(`unknown OS file-drop surface: ${surface}`);
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw fail('at least one real OS file is required for a file-drop run');
  }
  const allowedRootPath = resolve(allowedRoot);
  const files = filePaths.map((filePath) => {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
      throw fail('drop fixture paths must be absolute');
    }
    const absolute = resolve(filePath);
    if (!isInside(absolute, allowedRootPath) || linkOnPath(absolute)) {
      throw fail('drop fixture must be a regular path inside the isolated fixture folder');
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw fail('drop fixture path must name an existing file');
    }
    return absolute;
  });

  const target = page.locator(targetSelector).first();
  const box = await target.boundingBox();
  if (box === null) throw fail(`OS file-drop target is not visible: ${targetSelector}`);
  const x = box.x + Math.max(1, Math.min(box.width - 1, position?.x ?? box.width / 2));
  const y = box.y + Math.max(1, Math.min(box.height - 1, position?.y ?? box.height / 2));
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await session.send('Input.dispatchDragEvent', { type, x, y, data });
    }
  } finally {
    await session.detach();
  }
}

export function createLiveDriver(config, options = {}) {
  const runId = config.runId ?? randomUUID();
  const agentRoot = 'C:\\jgp\\v111\\codex';
  const profileDir = config.profileDir ?? join(agentRoot, 'profiles', runId);
  const libraryDir = config.libraryDir ?? join(agentRoot, 'libraries', runId);
  const lockPath = config.lockPath ?? LOCK_PATH;
  const launchConfig = { ...config, runId, profileDir, libraryDir, lockPath };
  const spawnProcess = options.spawn ?? spawn;
  const inspectLockFile = options.inspectLock ?? inspectLock;
  const takeLock = options.acquireLock ?? acquireLock;
  let child;
  let browser;
  let page;
  let lockFd;
  let lockContents;
  let baseline;
  let started = false;
  let closed = false;

  async function launch() {
    const lockState = inspectLockFile(lockPath);
    if (lockState.status === 'busy') throw fail('app lock is younger than 30 minutes');
    if (lockState.status === 'error') throw fail('could not inspect the app lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    const lock = takeLock(lockPath, config.reason ?? `JOY Media live QA ${runId}`, runId);
    lockFd = lock.fd;
    lockContents = lock.contents;
    try {
      baseline = await checkLaunchRules(launchConfig, {
        ...options.preflightDeps,
        lock: { status: 'available' },
      });
    } catch (error) {
      if (error?.code === 'LIVE_PREFLIGHT_REFUSED') throw error;
      throw fail(`launch preflight failed: ${String(error?.message ?? error).split('\n')[0]}`);
    }
    mkdirSync(dirname(profileDir), { recursive: true });
    mkdirSync(dirname(libraryDir), { recursive: true });
    mkdirSync(profileDir, { recursive: false });
    mkdirSync(libraryDir, { recursive: false });
    mkdirSync(config.outDir, { recursive: true });
    const emptyCatalog = {
      version: 1,
      counts: { total: 0, audio: 0, image: 0 },
      assets: [],
    };
    writeFileSync(
      join(libraryDir, 'catalog.json'),
      `${JSON.stringify(emptyCatalog, null, 2)}\n`,
      'utf8',
    );

    const port = await findFreePort();
    const envRoot = join(profileDir, 'environment');
    const launchEnv = buildLaunchEnvironment({
      baseEnv: process.env,
      envRoot,
      needsSignIn: config.needsSignIn === true,
      electronDir: baseline.electronDir,
    });
    const env = launchEnv.env;
    for (const path of launchEnv.scratchDirs) mkdirSync(path, { recursive: true });
    process.stdout.write(`${launchEnv.modeLine}\n`);
    const requireFromApp = createRequire(join(baseline.appDir, 'resources', 'app', 'package.json'));
    const { chromium: appChromium } = requireFromApp('playwright-core');
    child = spawnProcess(
      baseline.appExe,
      [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`],
      {
        cwd: baseline.appDir,
        env,
        stdio: 'ignore',
        windowsHide: false,
      },
    );
    started = true;
    const deadline = Date.now() + (config.attachTimeoutMs ?? 60_000);
    while (Date.now() < deadline && !browser) {
      if (child.exitCode !== null) throw fail('unpacked app exited before CDP became ready');
      browser = await appChromium
        .connectOverCDP(`http://${CDP_HOST}:${port}`)
        .catch(() => undefined);
      if (!browser) await delay(500);
    }
    if (!browser) throw fail('unpacked app did not expose CDP before timeout');
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.url().startsWith('devtools://'));
    if (!page) throw fail('CDP connected but no app window was found');
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    return { page, profileDir, libraryDir };
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (lockFd === undefined) return;
    let lockOwnershipChanged = false;
    try {
      if (!started) return;
      await page
        ?.evaluate(() => window.joyDesktop?.invoke?.('desktop.window-close', {}))
        .catch(() => {});
      await delay(1_000);
      await browser?.close().catch(() => {});
      const afterHash = exportJoyHash(config.outDir);
      let afterProcesses = countJoyAndElectronProcesses(baseline.appDir);
      for (let attempt = 0; afterProcesses > 0 && attempt < 30; attempt += 1) {
        await delay(1_000);
        afterProcesses = countJoyAndElectronProcesses(baseline.appDir);
      }
      const afterCount = countFiles(ownerDefaultLibrary(OWNER_HOME));
      verifyAfterRun(baseline, {
        joyHash: afterHash,
        ownerLibraryFiles: afterCount,
        runningProcesses: afterProcesses,
      });
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      if (existsSync(lockPath)) {
        if (readFileSync(lockPath, 'utf8') !== lockContents) {
          lockOwnershipChanged = true;
        } else {
          rmSync(lockPath, { force: true });
        }
      }
    }
    if (lockOwnershipChanged) {
      throw fail('app lock ownership changed; preserved the current lock');
    }
  }

  return {
    launch,
    close,
    get page() {
      return page;
    },
    async screenshot(path) {
      await page.screenshot({ path, fullPage: true });
    },
    async visibleText() {
      return page.locator('body').innerText();
    },
    async title() {
      return page.title();
    },
    async dropFiles(surface, filePaths, dropOptions = {}) {
      if (page === undefined) throw fail('launch the unpacked app before dispatching a file drop');
      return dispatchOSFileDrop(page, surface, filePaths, dropOptions);
    },
  };
}

function inspectLock(path) {
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    return { status: ageMs < 30 * 60_000 ? 'busy' : 'stale' };
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'available' } : { status: 'error' };
  }
}

function acquireLock(path, reason, runId) {
  const status = inspectLock(path);
  if (status.status === 'busy') throw fail('app lock is younger than 30 minutes');
  if (status.status === 'stale') rmSync(path, { force: true });
  let fd;
  try {
    fd = openSync(path, 'wx');
    const contents = `Codex CX\n${new Date().toISOString()}\n${reason}\nrun=${runId}\n`;
    writeFileSync(fd, contents);
    return { fd, contents };
  } catch {
    if (fd !== undefined) closeSync(fd);
    if (fd !== undefined && existsSync(path)) rmSync(path, { force: true });
    throw fail('could not create the app lock');
  }
}

function exportJoyHash(outDir) {
  const file = join(outDir, `.joy-registry-${randomUUID()}.reg`);
  mkdirSync(outDir, { recursive: true });
  const result = spawnSync(
    systemTool('reg.exe'),
    ['export', 'HKCU\\Software\\Classes\\joy', file, '/y'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    },
  );
  try {
    if (result.status !== 0 || !existsSync(file)) return '';
    return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
  } finally {
    rmSync(file, { force: true });
  }
}

function countJoyAndElectronProcesses(appDir) {
  const directory = appDir.replace(/'/gu, "''");
  const script = [
    `$d = '${directory}'`,
    '@(Get-CimInstance Win32_Process | Where-Object {',
    "$_.Name -eq 'joy-media.exe' -or",
    '($_.ExecutablePath -and',
    '$_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase))',
    '}).Count',
  ].join(' ');
  const result = spawnSync(
    systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  const count = Number.parseInt(String(result.stdout).trim(), 10);
  if (result.status !== 0 || !Number.isInteger(count)) {
    throw fail('could not inspect JOY/Electron processes');
  }
  return count;
}

function isPortAvailable() {
  return findFreePort().then(
    () => true,
    () => false,
  );
}

function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, CDP_HOST, () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}
