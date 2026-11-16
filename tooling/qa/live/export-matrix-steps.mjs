import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareFrames, extractExportFrame, probeFrameDimensions } from '../compare.mjs';
import { EXPORT_PRESETS } from './export-preset-spec.mjs';
import { exportAndProbe } from './export-probe.mjs';

const FRAME_TOLERANCE = 1;
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
    area: 'export frame matches the Fit monitor at three times',
    title: 'Export frame matches Fit monitor at three times',
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
  await ctx.editDocument(page);
}

async function runPresetRow(page, ctx, presetId) {
  const row = EXPORT_MATRIX_ROWS.find((item) => item.area === `export preset ${presetId}`);
  const rowId = row.id;
  await prepareSixSecondProject(page, ctx, rowId);
  await selectPreset(page, presetId);
  const started = Date.now();
  const exported = await exportAndProbe(page, ctx, rowId, { seconds: 6, audio: true });
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

async function captureMonitorFrame(page, seconds, path) {
  await page.keyboard.press('Home');
  for (let index = 0; index < seconds; index += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+0');
  await page.locator('.monitor-canvas-wrap canvas').screenshot({ path });
}

async function runFrameCompareRow(page, ctx) {
  const rowId = 'D-A10-10';
  await prepareSixSecondProject(page, ctx, rowId);
  const exported = await exportAndProbe(page, ctx, rowId, { seconds: 6, audio: true });
  const dir = rowEvidenceDir(ctx, rowId);
  const results = [];
  for (const seconds of [1, 3, 5]) {
    const preview = join(dir, `monitor-${seconds}s.png`);
    const frame = join(dir, `export-${seconds}s.png`);
    await captureMonitorFrame(page, seconds, preview);
    await extractExportFrame(exported.path, seconds, frame, await probeFrameDimensions(preview));
    const result = await compareFrames(
      preview,
      frame,
      join(dir, `compare-${seconds}s`),
      FRAME_TOLERANCE,
    );
    results.push({ seconds, ...result });
  }
  writeFileSync(
    join(dir, 'frame-compare.json'),
    `${JSON.stringify({ toleranceMeanAbsolutePerChannel: FRAME_TOLERANCE, results }, null, 2)}\n`,
    'utf8',
  );
  const failed = results.filter((result) => result.status !== 'pass');
  if (failed.length)
    throw new Error(
      `frame compare failed at ${failed.map((item) => `${item.seconds}s MAE ${item.meanAbsoluteChannelDelta}`).join(', ')}`,
    );
  return `three monitor/export frames passed; mean absolute per-channel tolerance ${FRAME_TOLERANCE}`;
}

export function processTreeWorkingSet(rootPid, { run = spawnSync } = {}) {
  if (!Number.isInteger(Number(rootPid)) || Number(rootPid) <= 0)
    throw new Error('a launched app pid is required');
  const script = `$root=${Number(rootPid)}; $all=Get-CimInstance Win32_Process; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ $parent=$ids[$i]; $ids+=@($all | Where-Object { $_.ParentProcessId -eq $parent } | ForEach-Object { [int]$_.ProcessId }) }; Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`;
  const result = run('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(`process memory sample failed: ${String(result.stderr ?? '').trim()}`);
  const parsed = JSON.parse(result.stdout || '[]');
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const rows = processes.map((item) => ({
    pid: Number(item.Id),
    workingSetBytes: Number(item.WorkingSet64),
  }));
  if (!rows.some((item) => item.pid === Number(rootPid)))
    throw new Error(`launched app process ${rootPid} was not present in the memory sample`);
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
    `Peak process-tree working set: ${peakBytes} bytes\n`,
    'utf8',
  );
  return `sampled ${samples.length} process-tree points during six-second export; peak ${(peakBytes / 1024 / 1024).toFixed(1)} MiB; ${exported.message}`;
}
