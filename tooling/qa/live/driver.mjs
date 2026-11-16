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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  countFiles,
  isInside,
  linkOnPath,
  ownerDefaultLibrary,
  systemTool,
} from '../../release/attended/scenario-rules.mjs';

import { labRoots, PC_JOY_HASH } from './lab-roots.mjs';

const LAB = labRoots();
// PC defaults; a second machine sets JOY_QA_ROOT, JOY_QA_LOCK and JOY_QA_EXPECTED_JOY_HASH (see lab-roots.mjs).
export const EXPECTED_JOY_HASH = LAB.expectedJoyHash;
export { PC_JOY_HASH };
export const LOCK_PATH = LAB.lockPath;
export const OS_FILE_DROP_SELECTORS = Object.freeze({
  timeline: '.timeline-lane, .timeline-empty-state, .timeline-file-new-track-drop',
  monitor: '.monitor-canvas-wrap',
  media: '.asset-library-main',
});
const APP_NAME = 'joy-media.exe';
const CDP_HOST = '127.0.0.1';
const OWNER_HOME = 'C:\\Users\\HadiMoti';
const DROP_FIXTURE_ROOT = LAB.drops;

/** Files in the owner's default library; a machine with no such folder has none to protect. */
function ownerLibraryCount(home) {
  const folder = ownerDefaultLibrary(home);
  return existsSync(folder) ? countFiles(folder) : 0;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'LIVE_PREFLIGHT_REFUSED';
  return error;
}

/**
 * The environment of one launch. Every folder is scratch (user data, USERPROFILE, HOME, APPDATA, TEMP,
 * LOCALAPPDATA), except in a sign-in launch (`needsSignIn`, asked for by `--needs-sign-in` and only for the sign-in
 * step): there LOCALAPPDATA is the owner's real one, so the sign-in page opens in the normal Chrome profile. The live
 * rows never run in that launch. Everything else stays scratch in both modes.
 * Pure: it touches no disk. The caller creates `scratchDirs` and prints `modeLine`.
 */
export function buildLaunchEnvironment({
  baseEnv,
  envRoot,
  needsSignIn,
  electronDir,
  testDownloadDirectory,
}) {
  const scratch = {
    USERPROFILE: join(envRoot, 'User'),
    HOME: join(envRoot, 'User'),
    // The worker keeps its state under JOY_MEDIA_HOME when it is set: never the machine's own value.
    JOY_MEDIA_HOME: join(envRoot, 'JoyMediaHome'),
    APPDATA: join(envRoot, 'Roaming'),
    TEMP: join(envRoot, 'Temp'),
    TMP: join(envRoot, 'Temp'),
  };
  const env = { ...baseEnv, ...scratch, ELECTRON_OVERRIDE_DIST_PATH: electronDir };
  if (testDownloadDirectory !== undefined) {
    env.JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY = testDownloadDirectory;
  }
  const scratchDirs = [scratch.USERPROFILE, scratch.APPDATA, scratch.TEMP, scratch.JOY_MEDIA_HOME];
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

/** True for the editor window (served from the app scheme); false for devtools and the loading window. */
/**
 * A Playwright connection over CDP takes over the page's downloads (it saves them under a temp name of its
 * own), so the app's will-download handler never writes the file into the scratch download folder: found live,
 * every export row then waited three minutes for a file that was not there. Save each download there instead.
 * `downloadDir` is the scratch folder inside the profile (the driver checked that already).
 */
export function keepDownloadsInScratch(page, downloadDir) {
  page.on('download', (download) => {
    const name = basename(download.suggestedFilename() || 'download.bin');
    download.saveAs(join(downloadDir, name)).catch(() => undefined);
  });
}

export function isAppEditorUrl(url) {
  return typeof url === 'string' && url.startsWith('joy-media-app://');
}

export function buildLaunchArguments({ profileDir, port, testMode = false }) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    ...(testMode ? ['--joy-media-test-mode'] : []),
  ];
}

/** The owner's folders a live run must never read or write. */
export function protectedRootsOf(ownerHome, installedDir) {
  return [
    ownerDefaultLibrary(ownerHome),
    join(ownerHome, 'Desktop'),
    join(ownerHome, 'Downloads'),
    join(ownerHome, 'joy-media'),
    join(ownerHome, '.joy-media'),
    join(ownerHome, 'Documents', 'JOY Projects'),
    installedDir,
    join(ownerHome, 'AppData', 'Roaming', '@joy-media'),
    join(ownerHome, 'AppData', 'Roaming', 'JOY Media'),
  ];
}

/**
 * Refuses a file the run would write (the lock file, the app log) when it lies in or around a protected owner
 * folder. Called before anything is created, so a wrong environment variable cannot write there.
 */
export function refuseProtectedFile(path, label, ownerHome = OWNER_HOME) {
  const installedDir = join(ownerHome, 'AppData', 'Local', 'Programs', 'JOY Media');
  const abs = resolve(path);
  if (protectedRootsOf(ownerHome, installedDir).some((root) => isInside(abs, root))) {
    throw fail(`${label} path is inside a protected owner folder`);
  }
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
  if (!config.reuseExisting && existsSync(config.outDir) && readdirSync(config.outDir).length > 0) {
    throw fail('output folder must be empty so prior evidence is not overwritten');
  }
  const protectedRoots = protectedRootsOf(ownerHome, installedDir);
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
  if (!config.reuseExisting && existsSync(config.profileDir))
    throw fail('profile path must be new for each run');
  if (!config.reuseExisting && existsSync(config.libraryDir))
    throw fail('scratch library path must be new for each run');
  const downloadDir = config.downloadDir ?? join(config.profileDir, 'downloads');
  if (config.testMode === true) {
    if (!isInside(resolve(downloadDir), resolve(config.profileDir)) || linkOnPath(downloadDir)) {
      throw fail('test-mode downloads must be a regular folder inside the scratch profile');
    }
  }
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
  const before = deps.ownerLibraryFiles ?? ownerLibraryCount(ownerHome);
  const running = deps.runningProcesses ?? countJoyAndElectronProcesses(appDir);
  if (running !== 0) throw fail('a JOY Media or Electron process is already running');
  const portAvailable = deps.portAvailable ?? (await isPortAvailable());
  if (!portAvailable) throw fail('could not reserve a CDP port');
  return { appDir, appExe, electronDir, ownerLibraryFiles: before, joyHash, downloadDir };
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
  const agentRoot = LAB.scratch;
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

  /**
   * Starts the app. `signIn: true` is the sign-in launch of a `--needs-sign-in` run: the only launch that gets the
   * real LOCALAPPDATA. A plain launch is always scratch, so the live rows never see the owner's real folder.
   */
  async function launch({ signIn = false } = {}) {
    if (signIn === true && config.needsSignIn !== true) {
      throw fail('the sign-in launch needs --needs-sign-in');
    }
    // Nothing is created or deleted before these two files are known to be outside the owner's folders.
    refuseProtectedFile(lockPath, 'app lock');
    if (process.env.JOY_QA_APP_LOG) refuseProtectedFile(process.env.JOY_QA_APP_LOG, 'app log');
    const lockState = inspectLockFile(lockPath);
    if (lockState.status === 'busy') throw fail('app lock is younger than 30 minutes');
    if (lockState.status === 'error') throw fail('could not inspect the app lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    const lock = takeLock(lockPath, config.reason ?? `JOY Media live QA ${runId}`, runId);
    lockFd = lock.fd;
    lockContents = lock.contents;
    try {
      baseline = await checkLaunchRules(
        { ...launchConfig, needsSignIn: signIn === true },
        {
          ...options.preflightDeps,
          lock: { status: 'available' },
        },
      );
    } catch (error) {
      if (error?.code === 'LIVE_PREFLIGHT_REFUSED') throw error;
      throw fail(`launch preflight failed: ${String(error?.message ?? error).split('\n')[0]}`);
    }
    mkdirSync(dirname(profileDir), { recursive: true });
    mkdirSync(dirname(libraryDir), { recursive: true });
    if (config.reuseExisting !== true) {
      mkdirSync(profileDir, { recursive: false });
      mkdirSync(libraryDir, { recursive: false });
    }
    mkdirSync(config.outDir, { recursive: true });
    if (config.reuseExisting !== true) {
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
    }

    const downloadDir = baseline.downloadDir;
    if (config.testMode === true) mkdirSync(downloadDir, { recursive: true });

    const port = await findFreePort();
    const envRoot = join(profileDir, 'environment');
    const launchEnv = buildLaunchEnvironment({
      baseEnv: process.env,
      envRoot,
      needsSignIn: signIn === true,
      electronDir: baseline.electronDir,
      testDownloadDirectory: config.testMode === true ? downloadDir : undefined,
    });
    const env = launchEnv.env;
    for (const path of launchEnv.scratchDirs) mkdirSync(path, { recursive: true });
    process.stdout.write(`${launchEnv.modeLine}\n`);
    const requireFromApp = createRequire(join(baseline.appDir, 'resources', 'app', 'package.json'));
    const { chromium: appChromium } = requireFromApp('playwright-core');
    // JOY_QA_APP_LOG: a file that receives the app's own output (stdout and stderr) for a diagnosis.
    const appLogPath = process.env.JOY_QA_APP_LOG;
    const appLogFd = appLogPath ? openSync(appLogPath, 'a') : undefined;
    child = spawnProcess(
      baseline.appExe,
      buildLaunchArguments({ profileDir, port, testMode: config.testMode === true }),
      {
        cwd: baseline.appDir,
        env,
        stdio: appLogFd === undefined ? 'ignore' : ['ignore', appLogFd, appLogFd],
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
    // The packaged app first shows a small loading window (a data: page) that closes after about two seconds;
    // the editor is the page served from the app's own scheme. Take that one, never the loading window.
    const pageDeadline = Date.now() + 30_000;
    while (Date.now() < pageDeadline && !page) {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => isAppEditorUrl(candidate.url()));
      if (!page) await delay(250);
    }
    if (!page) throw fail('CDP connected but no app window was found');
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    if (config.testMode === true) keepDownloadsInScratch(page, downloadDir);
    return {
      page,
      profileDir,
      libraryDir,
      downloadDir: config.testMode === true ? downloadDir : undefined,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (lockFd === undefined) return;
    let lockOwnershipChanged = false;
    let appStillRunning = false;
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
      // The app we started did not quit by itself (a hung window, a lost page): stop that one process we
      // spawned, never anything else, and count again.
      if (afterProcesses > 0 && child !== undefined && child.exitCode === null) {
        child.kill();
        for (let attempt = 0; afterProcesses > 0 && attempt < 10; attempt += 1) {
          await delay(1_000);
          afterProcesses = countJoyAndElectronProcesses(baseline.appDir);
        }
      }
      appStillRunning = afterProcesses > 0;
      const afterCount = ownerLibraryCount(OWNER_HOME);
      verifyAfterRun(baseline, {
        joyHash: afterHash,
        ownerLibraryFiles: afterCount,
        runningProcesses: afterProcesses,
      });
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      // A lock stays while an app is still running: the next run must be refused, not collide with it.
      if (existsSync(lockPath) && !appStillRunning) {
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
      await page.screenshot({ path, fullPage: false });
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

/** The sign-in launch's record: the page title and a screenshot, in `<outDir>/sign-in`. */
async function recordSignInPage(page, outDir) {
  const dir = join(outDir, 'sign-in');
  mkdirSync(dir, { recursive: true });
  const title = await page.title().catch(() => '');
  writeFileSync(
    join(dir, 'result.json'),
    `${JSON.stringify({ title, localAppData: 'the real one, for this launch only' }, null, 2)}\n`,
    'utf8',
  );
  await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: false }).catch(() => null);
}

/** Launches the driver. A launch that throws still closes it, so the app lock is released and no app is left running. */
async function launchOrClose(driver, options) {
  try {
    return await driver.launch(options);
  } catch (error) {
    await driver.close().catch(() => {});
    throw error;
  }
}

/**
 * The launches of one run. With `needsSignIn` (`--needs-sign-in`) the real LOCALAPPDATA is used for the sign-in
 * launch only: the sign-in page is recorded and that app is closed, then the live rows run on a scratch launch of
 * the same profile. Without it, the one launch is scratch. `makeDriver(reuseExisting)` builds a driver for one
 * launch. Returns the driver to close at the end and the session to run the rows on.
 */
export async function launchForRun({
  makeDriver,
  needsSignIn,
  outDir,
  recordSignIn = recordSignInPage,
}) {
  if (needsSignIn !== true) {
    const driver = makeDriver();
    return { driver, session: await launchOrClose(driver) };
  }
  const signInDriver = makeDriver();
  const signInSession = await launchOrClose(signInDriver, { signIn: true });
  try {
    await recordSignIn(signInSession.page, outDir);
  } finally {
    await signInDriver.close();
  }
  const driver = makeDriver(true);
  return { driver, session: await launchOrClose(driver) };
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
  // A trailing separator: a sibling folder that only starts with the same letters is not this app.
  const directory = `${appDir.replace(/[\\/]+$/u, '')}\\`.replace(/'/gu, "''");
  const script = [
    `$d = '${directory}';`,
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
