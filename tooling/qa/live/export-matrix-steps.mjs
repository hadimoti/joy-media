import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  compareFrames,
  extractExportFrame,
  extractFrameRegion,
  probeFrameDimensions,
} from '../compare.mjs';
import { EXPORT_PRESETS } from './export-preset-spec.mjs';
import { exportAndProbe, listMp4, readExportState } from './export-probe.mjs';
import { blurFocus, ensureTimelineClip, selectClipById, waitForSnapshot } from './ui-steps.mjs';

const FRAME_TOLERANCE = 3;
const BURN_IN_TOLERANCE = 6; // text edges are resampled; live 17 Nov: a one-pixel shift of the burned digits gave 4.3 at 1 s and 2 s
export const FRAME_COMPARE_SAMPLES = Object.freeze([
  { seconds: 1, sourceSeconds: 1 },
  { seconds: 2, sourceSeconds: 2 },
  { seconds: 4, sourceSeconds: 1 },
  { seconds: 5, sourceSeconds: 2 },
]);
const PRESET_ORDER = [
  'youtube-1080',
  'landscape-4k',
  'high-bitrate',
  'reels-1080',
  'shorts-1080',
  'tiktok-1080',
  'instagram-feed-4x5',
  'square-1080',
  'custom',
];

export const EXPORT_MATRIX_ROWS = Object.freeze([
  ...PRESET_ORDER.map((presetId, index) => ({
    id: `D-A10-${String(index + 1).padStart(2, '0')}`,
    area: `export preset ${presetId}`,
    title: `Export preset ${presetId}`,
    severity: 'major',
    run: (page, ctx) => runPresetRow(page, ctx, presetId),
  })),
  {
    id: 'D-A10-10',
    area: 'export frame matches the Fit monitor at four times',
    title: 'Export frame matches Fit monitor at four times',
    severity: 'major',
    run: runFrameCompareRow,
  },
  {
    id: 'D-A10-11',
    area: 'working set sampled during a six-second export',
    title: 'Process tree working set during export',
    severity: 'minor',
    run: runMemoryRow,
  },
  {
    id: 'D-A10-12',
    area: 'working set sampled during the ten-minute export',
    title: 'Process tree working set during the ten-minute export (T-F04 baseline)',
    severity: 'minor',
    run: runTenMinuteMemoryRow,
  },
  {
    id: 'D-A10-13',
    area: 'cancel an export of an H.264 source',
    title: 'Cancel an H.264 export: nothing is left running and no file is kept',
    severity: 'major',
    run: (page, ctx) => runCancelRow(page, ctx, 'D-A10-13', TEN_MINUTE_FIXTURE),
  },
  {
    id: 'D-A10-14',
    area: 'cancel an export of a WebM source',
    title: 'Cancel a WebM export: nothing is left running and no file is kept',
    severity: 'major',
    run: (page, ctx) => runCancelRow(page, ctx, 'D-A10-14', 'vp9-webm-audio.webm'),
  },
]);

export const EXPORT_MATRIX_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(EXPORT_MATRIX_ROWS.map((row) => [row.id, row])),
);
export const EXPORT_MATRIX_IDS = Object.freeze(Object.keys(EXPORT_MATRIX_ROWS_BY_ID));

function expectedSize(presetId) {
  const preset = EXPORT_PRESETS[presetId];
  return preset.size ?? { width: 1920, height: 1080 };
}

async function selectPreset(page, presetId) {
  await page.getByRole('button', { name: /^Format:/u }).click();
  await page
    .getByRole('menuitemradio', { name: EXPORT_PRESETS[presetId].label, exact: true })
    .click();
  const reframe = page.getByRole('dialog', { name: 'Reframe clips for the new canvas?' });
  if (await reframe.isVisible().catch(() => false)) {
    await reframe.locator('input[name="canvas-reframe-mode"][value="fit"]').check();
    await reframe.getByRole('button', { name: 'Apply', exact: true }).click();
  }
}

export function inspectPreset(probe, presetId, timelineSeconds = 6) {
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const expected = expectedSize(presetId);
  const duration = Number(probe.format?.duration ?? video?.duration);
  const fpsText = video?.avg_frame_rate ?? video?.r_frame_rate;
  const fps = fpsText?.includes('/')
    ? Number(fpsText.split('/')[0]) / Number(fpsText.split('/')[1])
    : Number(fpsText);
  const frames = Number(video?.nb_frames);
  const frameTolerance = fps > 0 ? 1 / fps : 1 / 30;
  const problems = [];
  if (video?.codec_name !== 'h264')
    problems.push(`codec ${video?.codec_name ?? 'missing'} != h264`);
  if (Number(video?.width) !== expected.width || Number(video?.height) !== expected.height)
    problems.push(`size ${video?.width}x${video?.height} != ${expected.width}x${expected.height}`);
  if (!Number.isFinite(fps) || Math.abs(fps - 30) > 0.01)
    problems.push(`fps ${fpsText ?? 'missing'} != 30`);
  if (!Number.isFinite(duration) || Math.abs(duration - timelineSeconds) > frameTolerance)
    problems.push(`duration ${duration} outside one-frame tolerance`);
  if (!Number.isInteger(frames) || frames !== Math.round(timelineSeconds * fps))
    problems.push(
      `frame count ${video?.nb_frames ?? 'missing'} != ${Math.round(timelineSeconds * fps)}`,
    );
  if (audio === undefined) problems.push('audio stream missing');
  return { pass: problems.length === 0, problems, video, audio, duration, fps, frames, expected };
}

function rowEvidenceDir(ctx, rowId) {
  const dir = join(ctx.outDir, rowId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function prepareSixSecondProject(page, ctx, rowId) {
  if (!ctx.downloadDir)
    throw new Error(`BLOCKED ${rowId}: driver test-download folder is unavailable`);
  if (!ctx.media) throw new Error(`BLOCKED ${rowId}: run with --media <stereo video fixture>`);
  // A fresh project with the fixture on the timeline. The fixture is 3 s long, so one duplicate (Ctrl+D) makes
  // the 6-second timeline the rows check.
  const state = await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await selectClipById(page, state.clips[0].id);
  await blurFocus(page);
  await page.keyboard.press('Control+KeyD');
  await waitForSnapshot(
    page,
    (shown) => shown.clips.length >= 2,
    `${rowId}: Ctrl+D did not duplicate the clip`,
  );
}

async function runPresetRow(page, ctx, presetId) {
  const row = EXPORT_MATRIX_ROWS.find((item) => item.area === `export preset ${presetId}`);
  const rowId = row.id;
  await prepareSixSecondProject(page, ctx, rowId);
  await selectPreset(page, presetId);
  const started = Date.now();
  const exported = await exportAndProbe(page, ctx, rowId, { seconds: 6, audio: true });
  assertNoStagedLibraryEntries(ctx, rowId);
  const checked = inspectPreset(exported.probe, presetId);
  const decode = (ctx.run ?? spawnSync)(
    process.env.JOY_MEDIA_FFMPEG ?? 'C:\\ffmpeg\\files\\bin\\ffmpeg.exe',
    ['-v', 'error', '-i', exported.path, '-t', '2', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true },
  );
  const decodePass = decode.status === 0 && !String(decode.stderr ?? '').trim();
  const ms = Date.now() - started;
  const dir = rowEvidenceDir(ctx, rowId);
  const fields = [
    presetId,
    checked.pass && decodePass ? 'pass' : 'fail',
    `${checked.video?.width}x${checked.video?.height}`,
    checked.fps,
    checked.video?.codec_name,
    checked.duration,
    checked.frames,
    Boolean(checked.audio),
    ms,
  ];
  writeFileSync(
    join(dir, 'presets.csv'),
    `preset,pass/fail,size,fps,codec,duration,frames,audio,ms\n${fields.map(csv).join(',')}\n`,
    'utf8',
  );
  if (!checked.pass || !decodePass)
    throw new Error(
      `${presetId}: ${[...checked.problems, ...(decodePass ? [] : ['two-second ffmpeg decode failed'])].join('; ')}`,
    );
  return `preset ${presetId} passed; ${fields[2]} ${fields[3]} fps ${fields[4]}, ${fields[5]} s, ${fields[6]} frames, audio; decode 2 s; ${ms} ms`;
}

export function assertNoStagedLibraryEntries(ctx, rowId) {
  const catalogPath = join(ctx.libraryDir, 'catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`${rowId}: could not read the export library catalog: ${error.message}`);
  }
  if (!Array.isArray(catalog?.assets))
    throw new Error(`${rowId}: export library catalog has no assets array`);
  const staged = catalog.assets.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      (entry.internal === true ||
        (typeof entry.displayName === 'string' && entry.displayName.endsWith('.stage'))),
  );
  if (staged.length > 0)
    throw new Error(`${rowId}: export left ${staged.length} staged entry in the Media catalog`);
}

async function captureMonitorFrame(page, seconds, path, frameDimensions) {
  const timecode = page.getByLabel('Timecode', { exact: true }).first();
  const target = `00:00:${String(seconds).padStart(2, '0')}:00`;
  await timecode.fill(target);
  await timecode.press('Enter');
  const expectedFrames = seconds * 30;
  const state = await waitForSnapshot(
    page,
    (shown) => timecodeIsWithinFrame(shown.timecode, expectedFrames, 30),
    `D-A10-10: playhead did not seek to ${target}`,
  );
  if (!timecodeIsWithinFrame(state.timecode, expectedFrames, 30))
    throw new Error(`D-A10-10: playhead is ${state.timecode}, expected ${target}`);

  // The Fit chip lives in the zoom drawer: open it when it is closed.
  const fit = page.getByRole('button', { name: 'Zoom Fit', exact: true });
  if (!(await fit.isVisible().catch(() => false))) {
    await page.locator('[aria-controls="monitor-zoom-drawer"]').first().click();
    await fit.waitFor({ state: 'visible', timeout: 5_000 });
  }
  await fit.click();
  const wrap = page.locator('.monitor-canvas-wrap').first();
  const rect = await wrap.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      zoom: Number(element.getAttribute('data-monitor-zoom')),
    };
  });
  const picture = monitorPictureRect(rect, frameDimensions);
  const capture = async () => page.screenshot({ path, clip: picture, animations: 'disabled' });
  let previous = await capture();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(100);
    const current = await capture();
    if (current.equals(previous)) return { playheadTimecode: state.timecode, picture };
    previous = current;
  }
  throw new Error(`D-A10-10: Monitor did not settle on ${target} before capture`);
}

async function runFrameCompareRow(page, ctx) {
  const rowId = 'D-A10-10';
  await prepareSixSecondProject(page, ctx, rowId);
  const exported = await exportAndProbe(page, ctx, rowId, { seconds: 6, audio: true });
  const exportDimensions = await probeFrameDimensions(exported.path);
  const dir = rowEvidenceDir(ctx, rowId);
  const results = [];
  for (const sample of FRAME_COMPARE_SAMPLES) {
    const { seconds, sourceSeconds } = sample;
    const preview = join(dir, `monitor-${seconds}s.png`);
    const frame = join(dir, `export-${seconds}s.png`);
    const captured = await captureMonitorFrame(page, seconds, preview, exportDimensions);
    await extractExportFrame(exported.path, seconds, frame, await probeFrameDimensions(preview));
    const result = await compareFrames(
      preview,
      frame,
      join(dir, `compare-${seconds}s`),
      FRAME_TOLERANCE,
    );
    const burnIn = await compareBurnInRegion(
      preview,
      frame,
      join(dir, `burn-in-${seconds}s`),
      BURN_IN_TOLERANCE,
    );
    results.push({
      seconds,
      expectedSourceSeconds: sourceSeconds,
      playheadTimecode: captured.playheadTimecode,
      burnIn,
      ...result,
    });
  }
  writeFileSync(
    join(dir, 'frame-compare.json'),
    `${JSON.stringify(
      {
        toleranceMeanAbsolutePerChannel: FRAME_TOLERANCE,
        burnInToleranceMeanAbsolutePerChannel: BURN_IN_TOLERANCE,
        frameToleranceReason:
          '3 levels allow small per-channel differences from GPU preview scaling versus ffmpeg Lanczos resampling',
        burnInCheck:
          'top-left 25% width by 10% height image comparison; expected source times are recorded per sample',
        results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const failed = results.filter(
    (result) => result.status !== 'pass' || result.burnIn.status !== 'pass',
  );
  if (failed.length)
    throw new Error(
      `frame/burn-in compare failed at ${failed.map((item) => `${item.seconds}s frame MAE ${item.meanAbsoluteChannelDelta}, burn-in ${item.burnIn.status}`).join(', ')}`,
    );
  return `four monitor/export frames passed (1, 2, 4, 5 s); frame MAE tolerance ${FRAME_TOLERANCE}, burn-in check tolerance ${BURN_IN_TOLERANCE}`;
}

export function timecodeIsWithinFrame(timecode, expectedFrame, fps) {
  if (typeof timecode !== 'string' || !Number.isInteger(expectedFrame) || !(fps > 0)) return false;
  const match = timecode.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) return false;
  const [, hours, minutes, seconds, frames] = match.map(Number);
  if (minutes >= 60 || seconds >= 60 || frames >= fps) return false;
  const actualFrame = ((hours * 60 + minutes) * 60 + seconds) * fps + frames;
  return Math.abs(actualFrame - expectedFrame) <= 1;
}

export function monitorPictureRect(viewport, frame) {
  const { left, top, width, height, zoom } = viewport;
  if (![left, top, width, height, zoom, frame.width, frame.height].every(Number.isFinite))
    throw new Error('Monitor picture bounds are incomplete');
  if (zoom <= 0 || frame.width <= 0 || frame.height <= 0)
    throw new Error('Monitor picture dimensions must be positive');
  return {
    x: left + (width - frame.width * zoom) / 2,
    y: top + (height - frame.height * zoom) / 2,
    width: frame.width * zoom,
    height: frame.height * zoom,
  };
}

export function burnInRegionDimensions(dimensions) {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.floor(dimensions.width * 0.25)),
    height: Math.max(1, Math.floor(dimensions.height * 0.1)),
  };
}

async function compareBurnInRegion(preview, frame, outputDir, tolerance) {
  const dimensions = await probeFrameDimensions(preview);
  const region = burnInRegionDimensions(dimensions);
  mkdirSync(outputDir, { recursive: true });
  const previewRegion = join(outputDir, 'monitor-burn-in.png');
  const exportRegion = join(outputDir, 'export-burn-in.png');
  await extractFrameRegion(preview, previewRegion, region);
  await extractFrameRegion(frame, exportRegion, region);
  return compareFrames(previewRegion, exportRegion, join(outputDir, 'compare'), tolerance);
}

export function processTreeWorkingSet(rootPid, { run = spawnSync } = {}) {
  if (!Number.isInteger(Number(rootPid)) || Number(rootPid) <= 0)
    throw new Error('a launched app pid is required');
  const script = `$root=${Number(rootPid)}; $all=Get-CimInstance Win32_Process; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ $parent=$ids[$i]; $ids+=@($all | Where-Object { $_.ParentProcessId -eq $parent } | ForEach-Object { [int]$_.ProcessId }) }; $all | Where-Object { $ids -contains [int]$_.ProcessId } | Select-Object ProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = [
      result.error?.message,
      String(result.stderr ?? '').trim(),
      result.signal ? `terminated by ${result.signal}` : undefined,
      result.status !== null && result.status !== undefined
        ? `exit code ${result.status}`
        : undefined,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `process memory sample failed: ${detail || 'PowerShell returned no error details'}`,
    );
  }
  const parsed = parseProcessTreeWorkingSet(result.stdout);
  if (!parsed.some((item) => item.pid === Number(rootPid)))
    throw new Error(`launched app process ${rootPid} was not present in the memory sample`);
  return parsed;
}

/** The processes of the peak sample, biggest first: where the memory is. */
export function describePeak(samples) {
  const peak = samples.reduce(
    (best, item) => (item.workingSetBytes > best.workingSetBytes ? item : best),
    samples[0],
  );
  return peak.processes
    .slice()
    .sort((a, b) => b.workingSetBytes - a.workingSetBytes)
    .map(
      (proc) =>
        `${proc.name || 'process'} (pid ${proc.pid}): ${(proc.workingSetBytes / 1024 / 1024).toFixed(0)} MiB`,
    )
    .join('\n');
}

export function parseProcessTreeWorkingSet(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim() || '[]');
  } catch (error) {
    throw new Error(`invalid process memory sample JSON: ${error.message}`);
  }
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const rows = processes.map((item) => ({
    pid: Number(item.ProcessId),
    ...(item.Name ? { name: String(item.Name) } : {}),
    workingSetBytes: Number(item.WorkingSetSize),
  }));
  if (
    rows.some(
      (item) =>
        !Number.isInteger(item.pid) || item.pid <= 0 || !Number.isFinite(item.workingSetBytes),
    )
  ) {
    throw new Error('process memory sample has an invalid PID or working set');
  }
  return rows;
}

async function runMemoryRow(page, ctx) {
  const rowId = 'D-A10-11';
  await prepareSixSecondProject(page, ctx, rowId);
  await selectPreset(page, 'youtube-1080');
  const samples = [];
  const started = Date.now();
  const sample = () => {
    const time = new Date().toISOString();
    const processes = processTreeWorkingSet(ctx.appPid);
    samples.push({
      time,
      processes,
      workingSetBytes: processes.reduce((sum, item) => sum + item.workingSetBytes, 0),
    });
  };
  sample();
  const exported = await exportAndProbe(page, ctx, rowId, {
    seconds: 6,
    audio: true,
    onPoll: () => {
      const now = Date.now();
      if (now - (samples.at(-1)?.atMs ?? started) >= 1_000) {
        sample();
        samples.at(-1).atMs = now;
      }
    },
  });
  sample();
  const peakBytes = Math.max(...samples.map((item) => item.workingSetBytes));
  const dir = rowEvidenceDir(ctx, rowId);
  writeFileSync(
    join(dir, 'memory.csv'),
    `time,working_set_bytes,process_count,pids\n${samples.map((item) => `${csv(item.time)},${item.workingSetBytes},${item.processes.length},${csv(item.processes.map((proc) => proc.pid).join(';'))}`).join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'memory-peak.txt'),
    `Peak process-tree working set: ${peakBytes} bytes\n${describePeak(samples)}\n`,
    'utf8',
  );
  return `sampled ${samples.length} process-tree points during six-second export; peak ${(peakBytes / 1024 / 1024).toFixed(1)} MiB; ${exported.message}`;
}

const TEN_MINUTE_FIXTURE = 'h264-1080p-10min.mp4';

/** The 10-minute 1080p fixture exported whole, with the app's process tree sampled every 2 s (the T-F04 baseline). */
async function runTenMinuteMemoryRow(page, ctx) {
  const rowId = 'D-A10-12';
  if (!ctx.downloadDir)
    throw new Error(`BLOCKED ${rowId}: driver test-download folder is unavailable`);
  if (!ctx.media) throw new Error(`BLOCKED ${rowId}: run with --media <fixture folder file>`);
  const fixture = join(dirname(resolve(ctx.media)), TEN_MINUTE_FIXTURE);
  const shortMedia = ctx.media;
  ctx.media = fixture;
  try {
    await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  } finally {
    ctx.media = shortMedia;
  }
  await selectPreset(page, 'youtube-1080');
  const samples = [];
  const take = () => {
    const processes = processTreeWorkingSet(ctx.appPid);
    samples.push({
      time: new Date().toISOString(),
      processes,
      workingSetBytes: processes.reduce((sum, item) => sum + item.workingSetBytes, 0),
      atMs: Date.now(),
    });
  };
  take();
  const started = Date.now();
  let exported;
  let failure;
  try {
    exported = await exportAndProbe(
      page,
      ctx,
      rowId,
      {
        seconds: 600,
        skipTrim: true,
        audio: 'any',
        onPoll: () => {
          if (Date.now() - (samples.at(-1)?.atMs ?? started) >= 2_000) take();
        },
      },
      { attempts: 3_000 },
    );
  } catch (error) {
    failure = error;
  }
  take();
  const peakBytes = Math.max(...samples.map((item) => item.workingSetBytes));
  const dir = rowEvidenceDir(ctx, rowId);
  const csvRows = samples.map(
    (item) =>
      `${csv(item.time)},${item.workingSetBytes},${item.processes.length},${csv(item.processes.map((proc) => proc.pid).join(';'))}`,
  );
  writeFileSync(
    join(dir, 'memory.csv'),
    ['time,working_set_bytes,process_count,pids', ...csvRows, ''].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'memory-peak.txt'),
    `Peak process-tree working set: ${peakBytes} bytes\n${describePeak(samples)}\n`,
    'utf8',
  );
  if (failure !== undefined) {
    throw new Error(
      `${failure instanceof Error ? failure.message : String(failure)} (after ${Math.round((Date.now() - started) / 1000)} s; peak ${(peakBytes / 1024 / 1024).toFixed(1)} MiB over ${samples.length} samples; memory.csv saved)`,
    );
  }
  return `ten-minute export took ${Math.round((Date.now() - started) / 1000)} s; sampled ${samples.length} points; peak ${(peakBytes / 1024 / 1024).toFixed(1)} MiB; ${exported.message}`;
}

/** Names of every process below the app (the app itself included), for the "nothing left running" check. */
export function processTreeNames(rootPid, { run = spawnSync } = {}) {
  const script = `$root=${Number(rootPid)}; $all=Get-CimInstance Win32_Process; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ $parent=$ids[$i]; $ids+=@($all | Where-Object { $_.ParentProcessId -eq $parent } | ForEach-Object { [int]$_.ProcessId }) }; $all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { $_.Name }`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`process name sample failed: ${result.error?.message ?? result.stderr}`);
  return String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * T-A10 item 6: start an export, cancel it while it runs, and check that the app says so, the Export button is free
 * again, no MP4 was kept in the download folder and no ffmpeg process is left below the app.
 */
async function runCancelRow(page, ctx, rowId, fixtureName) {
  if (!ctx.downloadDir)
    throw new Error(`BLOCKED ${rowId}: driver test-download folder is unavailable`);
  if (!ctx.media) throw new Error(`BLOCKED ${rowId}: run with --media <fixture folder file>`);
  const shortMedia = ctx.media;
  ctx.media = join(dirname(resolve(shortMedia)), fixtureName);
  try {
    await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  } finally {
    ctx.media = shortMedia;
  }
  await selectPreset(page, 'youtube-1080');
  const before = listMp4(ctx.downloadDir);
  await page.getByRole('button', { name: /^Export MP4/u }).click();
  // Wait until the export is really running, then give it a moment so there is something to cancel.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await page.evaluate(readExportState)).busy)
    await page.waitForTimeout(250);
  if (!(await page.evaluate(readExportState)).busy)
    throw new Error(`${rowId}: the export never started (the Export button was never busy)`);
  await page.waitForTimeout(4_000);
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  const settle = Date.now() + 60_000;
  let state = await page.evaluate(readExportState);
  while (Date.now() < settle && state.busy) {
    await page.waitForTimeout(500);
    state = await page.evaluate(readExportState);
  }
  if (state.busy) throw new Error(`${rowId}: the Export button stayed busy 60 s after Cancel`);
  await page.waitForTimeout(3_000);
  const kept = listMp4(ctx.downloadDir).filter((name) => !before.includes(name));
  if (kept.length > 0)
    throw new Error(`${rowId}: a file was kept after Cancel: ${kept.join(', ')}`);
  const names = processTreeNames(ctx.appPid);
  const leftovers = names.filter((name) => name.startsWith('ffmpeg') || name.startsWith('ffprobe'));
  if (leftovers.length > 0)
    throw new Error(`${rowId}: still running after Cancel: ${leftovers.join(', ')}`);
  return `export started, cancelled after 4 s; Export button free again; toast: ${state.toast.split('\n')[0] || '(none)'}; no new MP4; no ffmpeg below the app`;
}
