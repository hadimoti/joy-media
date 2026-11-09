// The machine side of the attended scenario. It implements the ScenarioDriver interface from
// tooling/release/src/attended-scenario.ts with real processes, files, the registry and the editor
// bridge. Nothing in this file runs until the CLI is given --launch, which the owner approves per run.
//
// The bridge is reached the way the discovery run reached it: the app starts with a Chromium debug
// port, playwright-core (from the candidate's own node_modules) attaches over CDP, and the calls go
// through window.joyDesktop.invoke in the page's main world.

/* global window, document, atob, btoa -- used only inside page.evaluate callbacks, which run in the editor page */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { libraryDirectoryOf } from '../src/attended-fresh-process.ts';
import { countFiles, folderSignature, systemTool } from './scenario-rules.mjs';

const JOY_KEY_PATH = 'HKCU\\Software\\Classes\\joy';

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Waits for a promise, but no longer than ms. The timer is referenced while it runs, so the wait is real,
 * and it is cleared as soon as the promise settles, so it does not hold the process open afterwards.
 */
export function boundedWait(promise, ms) {
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(resolvePromise, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Waits for a call to the app no longer than ms. A call that does not answer in time is an error, so the run
 * fails with a reason instead of waiting on a frozen renderer.
 */
async function withinTime(promise, what, ms) {
  const outcome = await boundedWait(
    promise.then((value) => ({ value })),
    ms,
  );
  if (outcome === undefined) {
    throw new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds`);
  }
  return outcome.value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tail(text, lines = 12) {
  return String(text ?? '')
    .trim()
    .split(/\r?\n/u)
    .slice(-lines)
    .join('\n');
}

/** A rate such as "30000/1001" or "30/1" as a number, or undefined when it is not one. */
function parseRate(text) {
  const [numerator, denominator = 1] = String(text ?? '')
    .split('/')
    .map(Number);
  const rate = numerator / denominator;
  return denominator > 0 && Number.isFinite(rate) ? rate : undefined;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else, so it is still alive.
    return error.code === 'EPERM';
  }
}

/** Finds the editor page: the first page in the debug session that exposes the bridge. */
async function findBridgePage(browser, deadline) {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (Date.now() >= deadline) break;
        const ready = await withinTime(
          page.evaluate(() => typeof window.joyDesktop?.invoke === 'function'),
          'the page check',
          5_000,
        ).catch(() => false);
        if (ready) return page;
      }
    }
    await sleep(1000);
  }
  throw new Error('no page exposed window.joyDesktop before the timeout');
}

function editorPageOf(browser, page) {
  // Under PWDEBUG Playwright's action timeout is 0, so the page's default is set here to keep actions bounded.
  page.setDefaultTimeout(30_000);
  return {
    page,
    invoke: (channel, payload) =>
      withinTime(
        page.evaluate(([name, body]) => window.joyDesktop.invoke(name, body), [channel, payload]),
        `the bridge call ${channel}`,
        120_000,
      ),
    // Bytes cross the debug session as base64 and are rebuilt in the page as a Uint8Array.
    uploadOriginal: async (assetId, bytes) => {
      await withinTime(
        page.evaluate(
          async ([id, base64]) => {
            const binary = atob(base64);
            const data = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1)
              data[index] = binary.charCodeAt(index);
            await window.joyDesktop.invoke('desktop.media.asset.upload-original', {
              assetId: id,
              bytes: data,
            });
          },
          [assetId, Buffer.from(bytes).toString('base64')],
        ),
        'the upload',
        300_000,
      );
    },
    fetchDerivative: async (jobId) => {
      const answer = await withinTime(
        page.evaluate(
          async ([id]) => {
            const result = await window.joyDesktop.invoke('desktop.media.derivative.bytes', {
              jobId: id,
            });
            const data =
              result.bytes instanceof Uint8Array ? result.bytes : Uint8Array.from(result.bytes);
            let binary = '';
            for (let index = 0; index < data.length; index += 0x8000) {
              binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
            }
            return { mimeType: result.mimeType, sha256: result.sha256, base64: btoa(binary) };
          },
          [jobId],
        ),
        'the derivative read',
        300_000,
      );
      return {
        mimeType: answer.mimeType,
        sha256: answer.sha256,
        bytes: Buffer.from(answer.base64, 'base64'),
      };
    },
    // On a browser connected over CDP, browser.close() closes only this harness's WebSocket. In
    // playwright-core 1.62.1 the connected browser's close is the transport close, and Browser.close is
    // sent only to browsers that Playwright launched itself. The app is not closed here, so a timeout
    // leaves it running. The wait is bounded, so a close that never reports does not hang the run.
    disconnect: () =>
      boundedWait(
        browser.close().catch(() => {}),
        15_000,
      ),
  };
}

/**
 * Builds the driver for one run. Every path comes from the caller; the driver writes only into runDir.
 * @param {{ exe: string, unpackedDir: string, profile: string, runDir: string, port: number,
 *           defaultLibrary: string, installedFolder: string }} config
 */
export function createScenarioDriver(config) {
  const requireFromApp = createRequire(
    join(config.unpackedDir, 'resources', 'app', 'package.json'),
  );
  const { chromium } = requireFromApp('playwright-core');
  let keyReads = 0;

  return {
    now: () => new Date(),
    sleep,

    async joyKeySha256() {
      keyReads += 1;
      const file = join(config.runDir, `joy-key-${keyReads}.reg`);
      const result = spawnSync(systemTool('reg.exe'), ['export', JOY_KEY_PATH, file, '/y'], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      if (result.status !== 0 || !existsSync(file)) {
        throw new Error(
          `reg export of the joy:// key failed: ${tail(result.stderr || result.stdout)}`,
        );
      }
      return sha256(readFileSync(file));
    },

    async joyProcessCount() {
      const directory = config.unpackedDir.replace(/'/gu, "''");
      const script = [
        `$d = '${directory}'`,
        `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'joy-media.exe' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) }).Count`,
      ].join('; ');
      const result = spawnSync(
        systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      const count = Number.parseInt(String(result.stdout).trim(), 10);
      if (result.status !== 0 || !Number.isInteger(count)) {
        throw new Error(`the process count failed: ${tail(result.stderr || result.stdout)}`);
      }
      return count;
    },

    async downloadsSignature() {
      return folderSignature(config.downloadsFolder);
    },

    async ownerLibrarySignature() {
      return folderSignature(config.defaultLibrary);
    },

    async ownerLibraryFileCount() {
      return existsSync(config.defaultLibrary) ? countFiles(config.defaultLibrary) : 0;
    },

    async installedFolderSignature() {
      return folderSignature(config.installedFolder);
    },

    async launch(attempt) {
      const log = openSync(join(config.runDir, `app-${attempt}.log`), 'a');
      const child = spawn(
        config.exe,
        [`--user-data-dir=${config.profile}`, `--remote-debugging-port=${config.port}`],
        {
          stdio: ['ignore', log, log],
          windowsHide: false,
        },
      );
      child.on('error', () => {});
      if (child.pid === undefined) throw new Error(`the app did not start (attempt ${attempt})`);
      return { pid: child.pid, attempt };
    },

    async attach(app) {
      const deadline = Date.now() + 90_000;
      let browser;
      while (browser === undefined && Date.now() < deadline) {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.port}`, {
            timeout: 5000,
          });
        } catch {
          await sleep(1000);
        }
      }
      if (browser === undefined) {
        throw new Error(
          `no debug port on ${config.port} within 90 seconds (attempt ${app.attempt})`,
        );
      }
      // A page that never shows up must not leave the harness connected: drop its connection, then fail.
      // That closes only this WebSocket; it does not close the app.
      const page = await findBridgePage(browser, deadline).catch(async (error) => {
        await boundedWait(
          browser.close().catch(() => {}),
          15_000,
        );
        throw error;
      });
      const base = editorPageOf(browser, page);
      // Both download layers are required, and are set before the scenario takes any step. The capture cancels the
      // default save of an editor download, and the browser is asked to refuse downloads for this page. If either
      // cannot be set, the attach fails and the harness drops its connection first. The layers do not cover other
      // pages, popups or the main process, and the browser's answer is not read back.
      try {
        await withinTime(page.evaluate(INSTALL_DOWNLOAD_CAPTURE), 'the download capture', 20_000);
        // The session is not closed here: the download setting is made on it, and it is meant to hold for the whole run.
        const session = await withinTime(
          page.context().newCDPSession(page),
          'the download session',
          5_000,
        );
        await withinTime(
          session.send('Page.setDownloadBehavior', { behavior: 'deny' }),
          'the download setting',
          5_000,
        );
      } catch (error) {
        await base.disconnect();
        throw error;
      }
      return base;
    },

    async isAlive(app) {
      return processAlive(app.pid);
    },

    async close(app, page) {
      try {
        if (page !== undefined) {
          // The bridge closes the window the way the title bar does. A reply may never come, because the
          // window goes away first, so the answer is not required.
          await withinTime(
            page.invoke('desktop.window-close', {}),
            'the window close',
            5_000,
          ).catch(() => {});
        }
        // The launcher is not the only JOY process: its children must be gone too, or the next launch
        // would meet them still holding the profile. So the close waits for the launcher and for a count
        // of zero JOY processes, and throws when that does not happen within 60 seconds.
        const deadline = Date.now() + 60_000;
        for (;;) {
          const launcherGone = !processAlive(app.pid);
          const remaining = launcherGone ? await this.joyProcessCount().catch(() => -1) : -1;
          if (launcherGone && remaining === 0) return;
          if (Date.now() > deadline) {
            const sent =
              page === undefined
                ? 'and no window close was sent, because the attach failed'
                : 'after the window close';
            throw new Error(
              `the app did not exit within 60 seconds ${sent} ` +
                `(pid ${app.pid}, launcher ${launcherGone ? 'gone' : 'still running'}, JOY processes ${remaining})`,
            );
          }
          await sleep(1000);
        }
      } finally {
        if (page !== undefined) await page.disconnect();
      }
    },

    async stageVideo(spec) {
      const path = join(config.runDir, spec.name);
      const args = [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${spec.width}x${spec.height}:rate=${spec.frameRate}`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-frames:v',
        String(spec.frameCount),
        '-t',
        (spec.frameCount / spec.frameRate).toFixed(6),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        path,
      ];
      const result = spawnSync(config.ffmpeg, args, { encoding: 'utf8', timeout: 300_000 });
      if (result.status !== 0)
        throw new Error(`ffmpeg could not stage the clip: ${tail(result.stderr)}`);
      return { bytes: readFileSync(path) };
    },

    async probeMedia(name) {
      const path = join(config.runDir, name);
      const result = spawnSync(
        config.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { encoding: 'utf8', timeout: 60_000 },
      );
      if (result.status !== 0) throw new Error(`ffprobe failed on ${name}: ${tail(result.stderr)}`);
      const parsed = JSON.parse(result.stdout);
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const videos = streams.filter((stream) => stream.codec_type === 'video');
      const audios = streams.filter((stream) => stream.codec_type === 'audio');
      const video = videos[0];
      const audio = audios[0];
      const frameRate =
        video === undefined ? undefined : parseRate(video.avg_frame_rate ?? video.r_frame_rate);
      const frames =
        video === undefined || video.nb_frames === undefined ? undefined : Number(video.nb_frames);
      return {
        formatName: parsed.format?.format_name ?? '',
        durationSeconds: Number(parsed.format?.duration),
        videoStreams: videos.length,
        audioStreams: audios.length,
        ...(video === undefined
          ? {}
          : { video: { codec: video.codec_name, width: video.width, height: video.height } }),
        ...(audio === undefined ? {} : { audioCodec: audio.codec_name }),
        ...(frameRate === undefined ? {} : { frameRate }),
        ...(Number.isInteger(frames) ? { frames } : {}),
      };
    },

    async writeRunFile(name, bytes) {
      writeFileSync(join(config.runDir, name), bytes);
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The fresh-process persistence scenario (tooling/release/src/attended-fresh-process.ts). Two processes
// run in two new profiles. Each profile's database is made by the candidate's own LocalDatabase module,
// with the scratch asset library already set, before its process starts. The owner's profile is never
// read. The owner's Downloads folder is only counted: the editor's downloads are captured in the page
// and the default save is cancelled. The browser is also asked to refuse downloads, and the attach fails if it
// cannot. The layers do not cover other pages, popups or the main process (README decision 6).
// ---------------------------------------------------------------------------------------------------

/** The candidate's database module, as a file URL. */
function localDatabaseUrlOf(unpackedDir) {
  return pathToFileURL(join(unpackedDir, 'resources', 'app', 'dist', 'store', 'local-database.js'))
    .href;
}

/**
 * Runs a Node helper that loads the candidate's own database module. A helper that does not finish within ms is
 * NOT stopped: the promise rejects and the helper is left running, for the owner to close.
 */
function runNodeHelper(args, ms) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      reject(
        new Error(
          `the helper did not finish within ${Math.round(ms / 1000)} seconds; it was left running and was not stopped`,
        ),
      );
    }, ms);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

/**
 * Null when the candidate's database module loads under this Node, otherwise the reason. Nothing is
 * written: the module is imported and no database is opened. The helper is never stopped (see runNodeHelper).
 */
export async function databaseModuleProblem(unpackedDir) {
  const url = localDatabaseUrlOf(unpackedDir);
  let result;
  try {
    result = await runNodeHelper(
      [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(url)}); process.stdout.write('loaded');`,
      ],
      60_000,
    );
  } catch (error) {
    return `the candidate's database module check did not finish: ${error.message}`;
  }
  if (result.status === 0 && result.stdout.includes('loaded')) return null;
  return `the candidate's database module did not load: ${tail(result.stderr || result.stdout)}`;
}

/**
 * Creates a new profile folder whose database names the scratch library. The candidate's own module
 * makes the database, in a child process that exits at once, so no handle stays open on the file.
 */
async function seedProfileDatabase(localDatabaseUrl, profile, library) {
  if (existsSync(profile)) throw new Error(`the profile folder ${profile} already exists`);
  mkdirSync(profile, { recursive: true });
  const script = [
    `const { LocalDatabase } = await import(${JSON.stringify(localDatabaseUrl)});`,
    `const db = new LocalDatabase({ filePath: ${JSON.stringify(join(profile, 'joy-media.sqlite3'))} });`,
    `db.setAssetLibraryDirectory(${JSON.stringify(library)});`,
    'const named = db.getAssetLibraryDirectory();',
    'db.close();',
    `if (named !== ${JSON.stringify(library)}) { process.stderr.write('the profile names ' + named); process.exit(3); }`,
  ].join('\n');
  const result = await runNodeHelper(['--input-type=module', '--eval', script], 60_000);
  if (result.status !== 0) {
    throw new Error(`the profile could not be seeded: ${tail(result.stderr || result.stdout)}`);
  }
}

/**
 * Runs in the editor page. It keeps each download the editor starts, and it cancels the default save,
 * so the file reaches the scenario through the page and not through the Downloads folder.
 */
const INSTALL_DOWNLOAD_CAPTURE = `(() => {
  if (window.__joyAttendedCapture !== undefined) return;
  window.__joyAttendedCapture = { items: [] };
  window.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[download]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const name = anchor.getAttribute('download') ?? '';
    fetch(anchor.href)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        window.__joyAttendedCapture.items.push({ name, base64: btoa(binary) });
      })
      .catch((error) => {
        window.__joyAttendedCapture.items.push({ name, error: String(error) });
      });
  }, true);
})()`;

/**
 * The title of the project the editor has open. The editor saves the open project's id and the catalog
 * to the browser storage it writes to, so the title is read from there, not from the page's text.
 */
const ACTIVE_PROJECT_TITLE = `(() => {
  try {
    const active = JSON.parse(window.localStorage.getItem('joy-media.active-project.v1') ?? 'null');
    const catalog = JSON.parse(window.localStorage.getItem('joy-media.project-catalog.v1') ?? 'null');
    const id = typeof active?.projectId === 'string' ? active.projectId : undefined;
    const title = id === undefined ? undefined : catalog?.projects?.[id]?.title;
    return typeof title === 'string' ? title : null;
  } catch {
    return null;
  }
})()`;

/** How many captured downloads the page holds. A download is read from the position after this. */
async function captureStart(page) {
  // Installed again before each download, in case the page was reloaded since the attach. A second
  // install is a no-op, so this is safe to repeat.
  await withinTime(page.evaluate(INSTALL_DOWNLOAD_CAPTURE), 'the download capture', 30_000);
  return withinTime(
    page.evaluate(() => window.__joyAttendedCapture?.items.length ?? 0),
    'the download count',
    30_000,
  );
}

/** Waits for the first captured download after `from` whose name matches, and returns its bytes. */
async function nextCapture(page, from, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await withinTime(
      page.evaluate(
        ([start, source]) => {
          const items = window.__joyAttendedCapture?.items.slice(start) ?? [];
          const failed = items.find((item) => item.error !== undefined);
          if (failed !== undefined) {
            return { error: `the download ${failed.name} could not be read: ${failed.error}` };
          }
          const match = items.find((item) => new RegExp(source, 'u').test(item.name));
          return match === undefined ? null : { name: match.name, base64: match.base64 };
        },
        [from, pattern.source],
      ),
      'the download read',
      30_000,
    );
    if (answer?.error !== undefined) throw new Error(answer.error);
    if (answer !== null && answer !== undefined) return Buffer.from(answer.base64, 'base64');
    if (Date.now() > deadline) {
      throw new Error(
        `no download matching ${pattern.source} arrived within ${Math.round(timeoutMs / 1000)} seconds`,
      );
    }
    await sleep(500);
  }
}

/**
 * The editor page as the scenario uses it. Each method is one step a person would take in the app: the
 * menus, the Projects library, the Media panel, and the import control. Every control is found by its
 * accessible name, as the editor labels it.
 */
function freshEditorPageOf(base) {
  const { page } = base;
  const button = (name) => page.getByRole('button', { name, exact: true });
  const menuItem = (name) => page.getByRole('menuitem', { name, exact: true });
  return {
    invoke: base.invoke,
    disconnect: base.disconnect,

    async libraryDirectory() {
      // The preload hands back the reply's data, so the answer is the library's info itself.
      return libraryDirectoryOf(await base.invoke('desktop.asset-library.get-settings', {}));
    },

    async waitForLibrary() {
      await button('New project').waitFor({ state: 'visible', timeout: 120_000 });
    },

    async createProject(title) {
      await button('New project').click();
      await page.getByPlaceholder('Project name').fill(title);
      await button('Create project').click();
      await button('File').waitFor({ state: 'visible', timeout: 120_000 });
    },

    async importClip(name, bytes) {
      const panelOpen = await withinTime(
        button('Import media').first().isVisible(),
        'the Media panel check',
        30_000,
      );
      if (!panelOpen) {
        await button('View').click();
        await menuItem('Media').click();
      }
      await button('Import media').first().click();
      const dialog = page.getByRole('dialog', { name: 'Import media', exact: true });
      // The file goes to the dialog's file input directly, so no native file chooser opens.
      await dialog.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
        name,
        mimeType: 'video/mp4',
        buffer: Buffer.from(bytes),
      });
      await dialog.getByText(name, { exact: true }).waitFor({ timeout: 60_000 });
      await dialog.getByRole('button', { name: 'Confirm import', exact: true }).click();
      const card = page.locator('.asset-card', { hasText: name }).first();
      await card.waitFor({ timeout: 120_000 });
      await card.getByRole('button', { name: `Add ${name} to timeline`, exact: true }).click();
      await page
        .locator(`.timeline-clip[aria-label^="${name},"]`)
        .first()
        .waitFor({ timeout: 60_000 });
    },

    async timelineClipCount(name) {
      return withinTime(
        page.locator(`.timeline-clip[aria-label^="${name},"]`).count(),
        'the timeline clip count',
        30_000,
      );
    },

    async exportEditablePackage() {
      const start = await captureStart(page);
      await button('File').click();
      await menuItem('Export Editable Project…').click();
      return nextCapture(page, start, /\.joyproject\.json$/u, 60_000);
    },

    async importEditablePackage(name, bytes) {
      const packageTitle = JSON.parse(Buffer.from(bytes).toString('utf8')).source.title;
      // The app's hidden file input for the import. Setting the file on it skips the native chooser.
      await page
        .locator('input[type="file"][accept*="joyproject"]')
        .first()
        .setInputFiles({
          name,
          mimeType: 'application/json',
          buffer: Buffer.from(bytes),
        });
      // The import ends with the imported project open, or with the app's failure notice on screen.
      await page.waitForFunction(
        `(() => (/Project import failed/u.test(document.body.innerText) || ((${ACTIVE_PROJECT_TITLE}) === ${JSON.stringify(packageTitle)})))()`,
        undefined,
        { timeout: 120_000 },
      );
      // The app's notice is a toast. It may already be gone, so an empty text is reported as such.
      return withinTime(
        page.evaluate(() => {
          const match = /(Imported [^\n]*|Project import failed[^\n]*)/u.exec(
            document.body.innerText,
          );
          return match === null ? '' : match[1];
        }),
        'the import notice',
        30_000,
      );
    },

    async activeProjectTitle() {
      return withinTime(page.evaluate(ACTIVE_PROJECT_TITLE), 'the project title', 30_000);
    },

    async readStorage(keys) {
      return withinTime(
        page.evaluate(
          (list) => Object.fromEntries(list.map((key) => [key, window.localStorage.getItem(key)])),
          keys,
        ),
        'the stored settings',
        30_000,
      );
    },

    async snapshot() {
      // The text the page shows and a screenshot, for reading a failure after the window has closed.
      const text = await withinTime(
        page.evaluate(() => (document.body?.innerText ?? '').slice(0, 20000)),
        'the page text',
        30_000,
      );
      const png = await page.screenshot({ timeout: 30_000 });
      return { text, png: new Uint8Array(png) };
    },

    async renderMp4() {
      const start = await captureStart(page);
      await button('Export MP4').click();
      const recent = button('Recent processes');
      const expanded = await withinTime(
        recent.getAttribute('aria-expanded'),
        'the process list state',
        30_000,
      );
      if (expanded !== 'true') await recent.click();
      const history = page.getByRole('region', { name: 'Recent processes', exact: true });
      await history
        .getByText(/Completed — final MP4 verified|Failed —/u)
        .first()
        .waitFor({ timeout: 900_000 });
      const status = await withinTime(history.innerText(), 'the render status', 30_000);
      if (!status.includes('Completed — final MP4 verified')) {
        throw new Error(`the render did not verify: ${tail(status)}`);
      }
      await history.locator('[aria-label^="Download "][aria-label$=" again"]').first().click();
      return nextCapture(page, start, /\.mp4$/u, 120_000);
    },
  };
}

/**
 * Builds the driver for the fresh-process scenario. It reuses the restart driver for the guards, the
 * probe, the writes and the window close, so those stay the code that the first live run exercised.
 * @param {{ exe: string, unpackedDir: string, runDir: string, port: number, defaultLibrary: string,
 *           installedFolder: string, downloadsFolder: string, clipFixture: string }} config
 */
export function createFreshProcessDriver(config) {
  const shared = createScenarioDriver({ ...config, profile: '' });
  const localDatabaseUrl = localDatabaseUrlOf(config.unpackedDir);
  return {
    now: () => shared.now(),
    sleep: (ms) => shared.sleep(ms),
    joyKeySha256: () => shared.joyKeySha256(),
    joyProcessCount: () => shared.joyProcessCount(),
    ownerLibraryFileCount: () => shared.ownerLibraryFileCount(),
    ownerLibrarySignature: () => shared.ownerLibrarySignature(),
    installedFolderSignature: () => shared.installedFolderSignature(),
    isAlive: (app) => shared.isAlive(app),
    close: (app, page) => shared.close(app, page),
    probeMedia: (name) => shared.probeMedia(name),
    writeRunFile: (name, bytes) => shared.writeRunFile(name, bytes),

    async downloadsSignature() {
      return folderSignature(config.downloadsFolder);
    },

    async readClipFixture() {
      return new Uint8Array(readFileSync(config.clipFixture));
    },

    async probeClip() {
      // The fixture is copied into the run folder, so it is probed by the same code as the render.
      const name = 'clip-fixture.mp4';
      copyFileSync(config.clipFixture, join(config.runDir, name));
      return shared.probeMedia(name);
    },

    async seedProfile(profile, library) {
      await seedProfileDatabase(localDatabaseUrl, profile, library);
    },

    async launch(attempt, profile) {
      const log = openSync(join(config.runDir, `app-${attempt}.log`), 'a');
      const child = spawn(
        config.exe,
        [`--user-data-dir=${profile}`, `--remote-debugging-port=${config.port}`],
        { stdio: ['ignore', log, log], windowsHide: false },
      );
      child.on('error', () => {});
      if (child.pid === undefined) throw new Error(`the app did not start (attempt ${attempt})`);
      return { pid: child.pid, attempt };
    },

    async attach(app) {
      // The shared attach sets both download layers, so both scenarios have them.
      return freshEditorPageOf(await shared.attach(app));
    },
  };
}
