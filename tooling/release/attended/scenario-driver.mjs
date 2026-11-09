// The machine side of the attended scenario. It implements the ScenarioDriver interface from
// tooling/release/src/attended-scenario.ts with real processes, files, the registry and the editor
// bridge. Nothing in this file runs until the CLI is given --launch, which the owner approves per run.
//
// The bridge is reached the way the discovery run reached it: the app starts with a Chromium debug
// port, playwright-core (from the candidate's own node_modules) attaches over CDP, and the calls go
// through window.joyDesktop.invoke in the page's main world.

/* global window, atob, btoa -- used only inside page.evaluate callbacks, which run in the editor page */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const JOY_KEY_PATH = 'HKCU\\Software\\Classes\\joy';

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

/** Files under a folder, counted without following links. Missing folders count as zero. */
function countFiles(folder) {
  if (!existsSync(folder)) return 0;
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) total += countFiles(path);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/** A signature that changes when any file under the folder is added, removed, resized or rewritten. */
function folderSignature(folder) {
  if (!existsSync(folder)) return 'missing';
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        const info = statSync(path);
        files += 1;
        bytes += info.size;
        newest = Math.max(newest, info.mtimeMs);
      }
    }
  };
  walk(folder);
  return `${files}:${bytes}:${Math.trunc(newest)}`;
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
        const ready = await page
          .evaluate(() => typeof window.joyDesktop?.invoke === 'function')
          .catch(() => false);
        if (ready) return page;
      }
    }
    await sleep(1000);
  }
  throw new Error('no page exposed window.joyDesktop before the timeout');
}

function editorPageOf(browser, page) {
  return {
    invoke: (channel, payload) =>
      page.evaluate(([name, body]) => window.joyDesktop.invoke(name, body), [channel, payload]),
    // Bytes cross the debug session as base64 and are rebuilt in the page as a Uint8Array.
    uploadOriginal: async (assetId, bytes) => {
      await page.evaluate(
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
      );
    },
    fetchDerivative: async (jobId) => {
      const answer = await page.evaluate(
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
      );
      return {
        mimeType: answer.mimeType,
        sha256: answer.sha256,
        bytes: Buffer.from(answer.base64, 'base64'),
      };
    },
    disconnect: () => browser.close().catch(() => {}),
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
      const result = spawnSync('reg.exe', ['export', JOY_KEY_PATH, file, '/y'], {
        encoding: 'utf8',
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
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
        },
      );
      const count = Number.parseInt(String(result.stdout).trim(), 10);
      if (result.status !== 0 || !Number.isInteger(count)) {
        throw new Error(`the process count failed: ${tail(result.stderr || result.stdout)}`);
      }
      return count;
    },

    async ownerLibraryFileCount() {
      return countFiles(config.defaultLibrary);
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
      const page = await findBridgePage(browser, deadline);
      return editorPageOf(browser, page);
    },

    async isAlive(app) {
      return processAlive(app.pid);
    },

    async close(app, page) {
      try {
        if (page !== undefined) {
          // The bridge closes the window the way the title bar does. A reply may never come, because the
          // window goes away first, so the answer is not required.
          await page.invoke('desktop.window-close', {}).catch(() => {});
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
            throw new Error(
              `the app did not exit within 60 seconds after the window close ` +
                `(launcher ${launcherGone ? 'gone' : 'still running'}, JOY processes ${remaining})`,
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
      const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
      if (result.status !== 0)
        throw new Error(`ffmpeg could not stage the clip: ${tail(result.stderr)}`);
      return { bytes: readFileSync(path) };
    },

    async probeMedia(name) {
      const path = join(config.runDir, name);
      const result = spawnSync(
        'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { encoding: 'utf8' },
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
