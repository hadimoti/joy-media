/* global document */
/**
 * The 2-second export of the T-A07 rows: cut the timeline to 2 s, export, find the saved file, ffprobe it.
 *
 * NOT RUN: written without launching the app. Assumptions (the first live run must confirm each):
 *  - The driver was started in test mode (`--joy-media-test-mode` with `JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY`
 *    inside the scratch profile), so the Save dialog writes into `ctx.downloadDir` without a native window.
 *  - `.timeline-playhead` is the playhead element; Home and ArrowRight (1 s each) move it; S splits the
 *    selected clip at the playhead; Edit > Delete removes the selected clip.
 *  - The Export button is named `Export MP4` (it may carry a warning suffix) and is `aria-busy` while it runs.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockedRow } from './rows.mjs';
import { blurFocus, clickMenuItem, readTimelineBoxes } from './ui-steps.mjs';

export const EXPORT_SECONDS = 2;

export function ffprobeJson(file, { ffprobe, run = spawnSync } = {}) {
  const tool = ffprobe ?? process.env.JOY_MEDIA_FFPROBE ?? 'ffprobe';
  const result = run(
    tool,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `ffprobe failed on ${file}: ${String(result.error?.message ?? result.stderr ?? '').split('\n')[0]}`,
    );
  }
  return JSON.parse(result.stdout);
}

/** Pure: checks one ffprobe answer against the 2-second export rule. Returns a summary or throws. */
export function checkExportProbe(probe, { seconds = EXPORT_SECONDS, tolerance = 0.35, audio = 'any' } = {}) {
  const streams = probe?.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const sound = streams.find((stream) => stream.codec_type === 'audio');
  const problems = [];
  if (video === undefined) problems.push('no video stream');
  else {
    if (video.codec_name !== 'h264') problems.push(`video codec is ${video.codec_name}, not h264`);
    if (!(Number(video.width) > 0 && Number(video.height) > 0)) problems.push('video has no size');
  }
  if (audio === true && sound === undefined) problems.push('no audio stream');
  if (audio === false && sound !== undefined) problems.push('an audio stream is there but none was expected');
  const duration = Number(probe?.format?.duration ?? video?.duration);
  if (!Number.isFinite(duration)) problems.push('no duration');
  else if (Math.abs(duration - seconds) > tolerance) {
    problems.push(`duration is ${duration.toFixed(2)} s, expected ${seconds} s within ${tolerance} s`);
  }
  if (problems.length > 0) throw new Error(`ffprobe: ${problems.join('; ')}`);
  return `ffprobe: h264 ${video.width}x${video.height}, ${duration.toFixed(2)} s, ${
    sound === undefined ? 'no audio' : `${sound.codec_name} audio`
  }`;
}

/** Pure: the file names in `after` that are not in `before`. */
export function newFiles(before, after) {
  const known = new Set(before);
  return after.filter((name) => !known.has(name));
}

export function listMp4(dir) {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.mp4'));
  } catch {
    return [];
  }
}

/**
 * Cuts the timeline so nothing runs past `seconds`: the playhead goes to the time, every clip that crosses it
 * is split there with S, and every clip that starts at or after it is deleted through Edit > Delete.
 * Needs the playhead to be drawn; throws a clear message when it is not.
 */
export async function trimTimelineToSeconds(page, seconds, rowId) {
  await blurFocus(page);
  await page.keyboard.press('Home');
  for (let step = 0; step < seconds; step += 1) await page.keyboard.press('ArrowRight');
  const edge = 3;
  for (let round = 0; round < 12; round += 1) {
    const { clips, playheadX } = await page.evaluate(readTimelineBoxes);
    if (playheadX === null) {
      throw new Error(`${rowId}: the playhead (.timeline-playhead) is not drawn, so the timeline cannot be cut to ${seconds} s`);
    }
    const crossing = clips.find((clip) => clip.left < playheadX - edge && clip.right > playheadX + edge);
    if (crossing !== undefined) {
      await page.locator(`.timeline-clip[data-clip-id="${crossing.id}"]`).first().click();
      await page.keyboard.press('KeyS');
      await page.waitForTimeout(150);
      continue;
    }
    const tail = clips.find((clip) => clip.left >= playheadX - edge);
    if (tail !== undefined) {
      await page.locator(`.timeline-clip[data-clip-id="${tail.id}"]`).first().click();
      await clickMenuItem(page, 'Edit', 'Delete');
      await page.waitForTimeout(150);
      continue;
    }
    return `timeline cut to ${seconds} s in ${round} step(s); ${clips.length} clip(s) left`;
  }
  throw new Error(`${rowId}: the timeline still runs past ${seconds} s after 12 cutting steps`);
}

/** Page-side: is the Export button busy, and what does the export toast say. */
export function readExportState() {
  const button = document.querySelector('.header-export-btn');
  const toast = document.querySelector('.export-toast');
  return {
    busy: button?.getAttribute('aria-busy') === 'true',
    toast: toast?.textContent?.trim() ?? '',
  };
}

/**
 * Cuts to 2 s, exports and probes. Writes `export.mp4` and `ffprobe.json` into the row's evidence folder.
 * `deps` lets a test replace the folder listing, the file size, the probe and the waiting.
 */
export async function exportAndProbe(page, ctx, rowId, options = {}, deps = {}) {
  if (!ctx.downloadDir) {
    throw blockedRow(
      rowId,
      'needs the driver in test mode (JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY inside the scratch profile) so the export is saved without a Save window',
    );
  }
  const list = deps.list ?? (() => listMp4(ctx.downloadDir));
  const size = deps.size ?? ((name) => statSync(join(ctx.downloadDir, name)).size);
  const probe = deps.probe ?? ((name) => ffprobeJson(join(ctx.downloadDir, name)));
  const attempts = deps.attempts ?? 600;
  const seconds = options.seconds ?? EXPORT_SECONDS;
  const cut = options.skipTrim === true ? 'timeline not cut' : await trimTimelineToSeconds(page, seconds, rowId);
  const before = list();
  await page.getByRole('button', { name: /^Export MP4/u }).click();
  let name;
  let lastSize = -1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await page.evaluate(readExportState);
    if (/Export failed/u.test(state.toast)) {
      throw new Error(`the export failed: ${state.toast.split('\n')[0]}`);
    }
    const fresh = newFiles(before, list());
    if (fresh.length > 0) {
      const current = size(fresh[0]);
      if (current === lastSize && !state.busy && current > 0) {
        name = fresh[0];
        break;
      }
      lastSize = current;
    }
    await page.waitForTimeout(1_000);
  }
  if (name === undefined) throw new Error('no exported MP4 appeared in the scratch download folder');
  const info = probe(name);
  const summary = checkExportProbe(info, { seconds, audio: options.audio ?? 'any' });
  const suffix = options.tag === undefined ? '' : `-${options.tag}`;
  if (ctx.outDir) {
    const dir = join(ctx.outDir, rowId);
    mkdirSync(dir, { recursive: true });
    if (deps.copy !== false) {
      copyFileSync(join(ctx.downloadDir, name), join(dir, `export${suffix}.mp4`));
    }
    writeFileSync(join(dir, `ffprobe${suffix}.json`), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  }
  return { message: `${cut}; ${summary}`, path: join(ctx.downloadDir, name), probe: info };
}

/** Pure: the mean volume in dB that ffmpeg's volumedetect prints, or undefined when it printed none. */
export function parseMeanVolumeDb(stderr) {
  const match = /mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/u.exec(String(stderr));
  if (match === null) return undefined;
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

/** The mean volume of the exported audio, through ffmpeg volumedetect (`JOY_MEDIA_FFMPEG` or `ffmpeg`). */
export function measureMeanVolumeDb(file, { run = spawnSync } = {}) {
  const tool = process.env.JOY_MEDIA_FFMPEG ?? 'ffmpeg';
  const result = run(tool, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw new Error(`ffmpeg failed on ${file}: ${result.error.message}`);
  const value = parseMeanVolumeDb(result.stderr);
  if (value === undefined) throw new Error(`ffmpeg volumedetect printed no mean_volume for ${file}`);
  return value;
}
