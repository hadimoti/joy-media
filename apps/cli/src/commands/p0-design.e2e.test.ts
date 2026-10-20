import { createHash } from 'node:crypto';
import { fork, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { templateSha256 } from '@joy-media/motion-core';

const BUNDLE = resolve('apps/cli/dist/joy-media-bundle.mjs');
const ROI = Object.freeze({ x: 40, y: 250, width: 1120, height: 300 });
const MP4_CODEC_BLOCK_ROI = Object.freeze({ x: 32, y: 240, width: 1136, height: 320 });
const TITLE_PIXEL_TOLERANCE = 0;
const MP4_OUTSIDE_CHANNEL_TOLERANCE = 16;
const MP4_OUTSIDE_CHANGED_PIXEL_TOLERANCE = 1024;
// Step 7 limit, recalibrated by explicit owner decision (2026-10-20). With the pinned source fixture and
// the pinned H.264 and filter settings, step 7 measured 4070 outside-ROI pixels (max channel difference
// 56) on both 2 and 32 logical processors, with identical numbers. The limit keeps 26 pixels of headroom.
// Step 8 keeps MP4_OUTSIDE_CHANGED_PIXEL_TOLERANCE: it passes within that limit with the same settings.
const MP4_STEP7_OUTSIDE_CHANGED_PIXEL_TOLERANCE = 4096;
const AUDIO_GAIN_TOLERANCE = 0.06;
const AUDIO_STEREO_MIX_FACTOR = 1 / Math.sqrt(2);
const AUDIO_FADE_ENVELOPE_MAX_RATIO = 0.3;
const MUTED_RMS_MAX = 0;
const CAPTION_BAND = Object.freeze({ x: 120, y: 560, width: 1040, height: 100 });
const CAPTION_PIXEL_THRESHOLD = 12;
const CAPTION_OUTSIDE_PIXEL_COUNT_TOLERANCE = 128;
const RENDER_LIMIT_MS = 60_000;
const FRAME_RATE = 30;
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 720;
const RGBA_BYTES_PER_PIXEL = 4;
const RENDER_RETAINED_RGBA_LIMIT_BYTES = 256 * 1024 * 1024;

type JsonRecord = Record<string, any>;
type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  events: JsonRecord[];
  stdout: string;
  stderr: string;
};

const temporaryRoots: string[] = [];
let root = '';
let baseEnv: NodeJS.ProcessEnv;
let ffmpeg = 'ffmpeg';
let ffprobe = 'ffprobe';
let chromium = '';
let sourceVideo = '';
let audioWav = '';
let primary: ProjectFixture | undefined;
let noTitle: ProjectFixture | undefined;
let noCaption: ProjectFixture | undefined;
const titleId = 'speaker';
let titleClipId = 'clip-speaker';
let titleTrackId = 'track-v3';
const titleStartUs = 1_000_000;
const titleDurationUs = 3_000_000;
let previewTitle = '';
let previewNoTitle = '';
let previewUpdated = '';
let renderOutput: JsonRecord | undefined;
let renderManifest: JsonRecord | undefined;
let renderPath = '';
const failures: string[] = [];
const cancellationCaseResults: string[] = [];

interface ProjectFixture {
  id: string;
  db: string;
  file: string;
  videoClipId: string;
  captionTrackId: string;
  audioTrackId: string;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function binaryWorks(binary: string, args: string[]): boolean {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return result.status === 0 && !result.error;
}

function playwrightChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : undefined,
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
  ].filter((path): path is string => Boolean(path));
  for (const directory of roots) {
    let revisions: string[];
    try {
      revisions = readdirSync(directory)
        .filter((name) => /^chromium-\d+$/u.test(name))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const revision of revisions) {
      const candidates =
        process.platform === 'win32'
          ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
          : process.platform === 'darwin'
            ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium']
            : ['chrome-linux/chrome', 'chrome-linux64/chrome'];
      for (const relative of candidates) {
        const candidate = join(directory, revision, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function parseJsonLines(stdout: string, context: string): JsonRecord[] {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error(`${context}: expected JSON output, received no stdout.`);
  return lines.map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON value is not an object');
      }
      return parsed as JsonRecord;
    } catch (error) {
      throw new Error(
        `${context}: stdout line ${index + 1} was not a JSON object: ${String(error)}; ${line.slice(0, 240)}`,
      );
    }
  });
}

// Runs the bundled CLI and returns its result, including a non-zero exit. Use runCli when a non-zero
// exit is a failure, and this when the exit itself is part of what the step checks.
function runCliAllowingExit(args: string[], context: string): CliResult {
  const result = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`${context}: bundled CLI did not start: ${result.error.message}`);
  return {
    code: result.status,
    signal: null,
    events: parseJsonLines(result.stdout ?? '', context),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runCli(args: string[], context: string): CliResult {
  const result = runCliAllowingExit(args, context);
  if (result.code !== 0) {
    const event = result.events.at(-1);
    throw new Error(
      `${context}: exit ${String(result.code)}${event?.code ? ` (${event.code})` : ''}: ${event?.message ?? result.stderr?.trim() ?? 'no error message'}`,
    );
  }
  return result;
}

// The refusal message when the CLI stopped because libass cannot load the canonical caption face.
function captionFaceRefusal(result: CliResult): string | undefined {
  const event = result.events.at(-1);
  if (result.code === 0 || event?.code !== 'SETUP_REQUIRED') return undefined;
  const message = String(event.message ?? '');
  return message.includes('canonical-caption-face-unavailable') ? message : undefined;
}

function lastEvent(result: CliResult, context: string): JsonRecord {
  const event = result.events.at(-1);
  if (!event) throw new Error(`${context}: command produced no parsed JSON event.`);
  return event;
}

function checkedCli(args: string[], context: string): JsonRecord {
  const result = runCli(args, context);
  expect(result.code, `${context} exit status`).toBe(0);
  return lastEvent(result, context);
}

function fileProject(path: string): JsonRecord {
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
  const body = envelope.project ?? envelope.source ?? envelope;
  if (!body || typeof body !== 'object')
    throw new Error(`Project loader contract: ${path} has no project/source body.`);
  return body as JsonRecord;
}

function setFixtureDuration(project: ProjectFixture, durationUs: number): void {
  const envelope = JSON.parse(readFileSync(project.file, 'utf8')) as JsonRecord;
  const body = envelope.project ?? envelope.source ?? envelope;
  body.compositions.root.durationUs = durationUs;
  writeFileSync(
    project.file,
    JSON.stringify(
      {
        format: 'joy-media-project',
        schemaVersion: 1,
        revision: envelope.revision ?? 1,
        id: body.id,
        title: body.title,
        project: body,
      },
      null,
      2,
    ),
  );
}

function createProject(title: string, directory: string, includeCaption = true): ProjectFixture {
  mkdirSync(directory, { recursive: true });
  const db = join(directory, 'project.sqlite');
  const file = join(directory, 'project.json');
  const created = checkedCli(
    [
      'project',
      'create',
      title,
      '--width',
      '1280',
      '--height',
      '720',
      '--fps',
      '30',
      '--sqlite-path',
      db,
      '--json',
    ],
    `${title}: project create`,
  );
  expect(created.title).toBe(title);
  expect(created.id).toEqual(expect.any(String));
  const exported = checkedCli(
    ['project', 'export', created.id, '--sqlite-path', db, '--output', file, '--json'],
    `${title}: project export`,
  );
  expect(exported.path).toBe(file);
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as JsonRecord;
  expect(envelope).toMatchObject({ format: 'joy-media-project', schemaVersion: 1 });
  expect(envelope.source).toMatchObject({ id: created.id, title });
  const video = checkedCli(
    [
      'timeline',
      'add-clip',
      '--project',
      file,
      '--track',
      'track-v1',
      '--asset',
      sourceVideo,
      '--start',
      '0',
      '--duration',
      '5',
      '--json',
    ],
    `${title}: timeline add video`,
  );
  expect(video.trackId).toBe('track-v1');
  const videoClipId = video.clip.id as string;
  checkedCli(
    ['timeline', 'set-audio', '--project', file, '--clip', videoClipId, '--mute', '--json'],
    `${title}: mute muxed source audio`,
  );
  const audioTrack = checkedCli(
    ['timeline', 'add-track', '--project', file, '--family', 'audio', '--json'],
    `${title}: add audio track`,
  );
  const audioTrackId = audioTrack.trackId as string;
  const segment1 = checkedCli(
    [
      'timeline',
      'add-clip',
      '--project',
      file,
      '--track',
      audioTrackId,
      '--asset',
      audioWav,
      '--start',
      '0',
      '--duration',
      '2',
      '--json',
    ],
    `${title}: add first audio segment`,
  );
  const muted = checkedCli(
    [
      'timeline',
      'add-clip',
      '--project',
      file,
      '--track',
      audioTrackId,
      '--asset',
      audioWav,
      '--start',
      '2',
      '--duration',
      '0.5',
      '--json',
    ],
    `${title}: add muted audio segment`,
  );
  const segment3 = checkedCli(
    [
      'timeline',
      'add-clip',
      '--project',
      file,
      '--track',
      audioTrackId,
      '--asset',
      audioWav,
      '--start',
      '2.5',
      '--duration',
      '2.5',
      '--json',
    ],
    `${title}: add final audio segment`,
  );
  checkedCli(
    [
      'timeline',
      'set-audio',
      '--project',
      file,
      '--clip',
      segment1.clip.id,
      '--gain',
      '0.5',
      '--fade-in',
      '0.5',
      '--json',
    ],
    `${title}: set first segment gain and fade-in`,
  );
  checkedCli(
    ['timeline', 'set-audio', '--project', file, '--clip', muted.clip.id, '--mute', '--json'],
    `${title}: mute the middle audio range`,
  );
  checkedCli(
    [
      'timeline',
      'set-audio',
      '--project',
      file,
      '--clip',
      segment3.clip.id,
      '--gain',
      '0.5',
      '--fade-out',
      '0.5',
      '--json',
    ],
    `${title}: set final segment gain and fade-out`,
  );
  let captionTrackId = '';
  if (includeCaption) {
    const captionTrack = checkedCli(
      ['timeline', 'add-track', '--project', file, '--family', 'caption', '--json'],
      `${title}: add caption track`,
    );
    captionTrackId = captionTrack.trackId as string;
    checkedCli(
      [
        'timeline',
        'add-caption',
        '--project',
        file,
        '--track',
        captionTrackId,
        '--start',
        '1.5',
        '--duration',
        '1',
        '--text',
        'CAPTION WINDOW PROOF',
        '--language',
        'en',
        '--direction',
        'ltr',
        '--json',
      ],
      `${title}: add ASS caption cue`,
    );
  }
  return { id: created.id as string, db, file, videoClipId, audioTrackId, captionTrackId };
}

function titleOperation(lines: { primary: string; secondary: string }) {
  return {
    id: 'p0-title',
    op: 'instantiateTemplate',
    instanceId: titleId,
    templateId: 'joy.p0.lower-third',
    trackId: titleTrackId,
    lines,
    font: { family: 'Noto Sans Arabic', weight: 700 },
    direction: 'ltr',
    startUs: titleStartUs,
    durationUs: titleDurationUs,
    placement: { xPx: 64, yPx: 250, maxWidthPx: 1000, safeInsetPx: 36 },
    motion: { presetId: 'hold', inUs: 0, outUs: 0 },
  };
}

function preparePlan(
  project: ProjectFixture,
  operations: unknown[],
  suffix: string,
  expectedRevision: number,
  key: string,
): JsonRecord {
  const directory = join(root, 'plans');
  const operationsPath = join(directory, `${suffix}.operations.json`);
  const planPath = join(directory, `${suffix}.plan.json`);
  writeFileSync(operationsPath, JSON.stringify({ schemaVersion: 1, operations }, null, 2));
  const prepared = checkedCli(
    ['plan', 'prepare', operationsPath, '--project', project.file, '--output', planPath, '--json'],
    `${suffix}: plan prepare`,
  );
  expect(prepared.schemaVersion).toBe(1);
  expect(prepared.path).toBe(planPath);
  const inspected = checkedCli(['plan', 'inspect', planPath, '--json'], `${suffix}: plan inspect`);
  expect(inspected.planId).toBe(prepared.planId);
  const applied = checkedCli(
    [
      'plan',
      'apply',
      planPath,
      '--project',
      project.file,
      '--expected-revision',
      String(expectedRevision),
      '--idempotency-key',
      key,
      '--json',
    ],
    `${suffix}: plan apply`,
  );
  expect(applied.replayed).toBe(false);
  expect(applied.revision).toBe(expectedRevision + 1);
  return applied;
}

function renderPreview(
  project: ProjectFixture,
  atUs: number,
  filename: string,
  context: string,
): string {
  const out = join(root, `preview-${filename}`);
  const event = checkedCli(
    [
      'render',
      '--project',
      project.file,
      '--preset',
      'mp4',
      '--out',
      out,
      '--frame-us',
      String(atUs),
      '--json',
    ],
    context,
  );
  expect(event.type).toBe('preview-complete');
  expect(event.timeUs).toBe(atUs);
  expect(event.artifactPath).toEqual(expect.any(String));
  expect(existsSync(event.artifactPath)).toBe(true);
  expect(statSync(event.artifactPath).size).toBeGreaterThan(0);
  return event.artifactPath as string;
}

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.length).toBeGreaterThan(33);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function decodeRgb(
  path: string,
  width: number,
  height: number,
  context: string,
  timeSeconds?: number,
): Buffer {
  const seek = timeSeconds === undefined ? [] : ['-ss', String(timeSeconds)];
  const result = spawnSync(
    ffmpeg,
    [
      '-v',
      'error',
      ...seek,
      '-i',
      path,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    {
      encoding: 'buffer',
      maxBuffer: width * height * 3 + 1024,
      timeout: 20_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `${context}: ffmpeg raw RGB decode failed: ${result.error?.message ?? result.stderr?.toString()}`,
    );
  const data = Buffer.from(result.stdout);
  if (data.length !== width * height * 3)
    throw new Error(
      `${context}: decoded ${data.length} RGB bytes, expected ${width * height * 3}.`,
    );
  return data;
}

function decodeRgbaFrame(path: string, frameIndex: number, context: string): Buffer {
  const result = spawnSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${frameIndex})`,
      '-vsync',
      '0',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    {
      encoding: 'buffer',
      maxBuffer: RENDER_WIDTH * RENDER_HEIGHT * RGBA_BYTES_PER_PIXEL + 1024,
      timeout: 20_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `${context}: ffmpeg raw RGBA decode failed: ${result.error?.message ?? result.stderr?.toString()}`,
    );
  const data = Buffer.from(result.stdout);
  const expectedBytes = RENDER_WIDTH * RENDER_HEIGHT * RGBA_BYTES_PER_PIXEL;
  if (data.length !== expectedBytes)
    throw new Error(`${context}: decoded ${data.length} RGBA bytes, expected ${expectedBytes}.`);
  return data;
}

function changedPixels(
  a: Buffer,
  b: Buffer,
  width: number,
  region: { x: number; y: number; width: number; height: number },
  threshold = 0,
  channels = 3,
): number {
  let changed = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * width + x) * channels;
      if (
        Math.max(
          Math.abs(a[i]! - b[i]!),
          Math.abs(a[i + 1]! - b[i + 1]!),
          Math.abs(a[i + 2]! - b[i + 2]!),
        ) > threshold
      )
        changed++;
    }
  }
  return changed;
}

function expectEqualOutsideRoi(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  context: string,
): void {
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= ROI.x && x < ROI.x + ROI.width && y >= ROI.y && y < ROI.y + ROI.height) continue;
      const i = (y * width + x) * 3;
      if (
        Math.max(
          Math.abs(a[i]! - b[i]!),
          Math.abs(a[i + 1]! - b[i + 1]!),
          Math.abs(a[i + 2]! - b[i + 2]!),
        ) > TITLE_PIXEL_TOLERANCE
      )
        changed++;
    }
  }
  expect(
    changed,
    `${context}: pixels changed outside fixed title ROI with tolerance ${TITLE_PIXEL_TOLERANCE}`,
  ).toBe(0);
}

function compareOutsideCodecBlockRoi(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  context: string,
  maxChangedPixels = MP4_OUTSIDE_CHANGED_PIXEL_TOLERANCE,
): { changedPixels: number; maxChannelDifference: number } {
  let changedPixels = 0;
  let maxChannelDifference = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        x >= MP4_CODEC_BLOCK_ROI.x &&
        x < MP4_CODEC_BLOCK_ROI.x + MP4_CODEC_BLOCK_ROI.width &&
        y >= MP4_CODEC_BLOCK_ROI.y &&
        y < MP4_CODEC_BLOCK_ROI.y + MP4_CODEC_BLOCK_ROI.height
      )
        continue;
      const i = (y * width + x) * RGBA_BYTES_PER_PIXEL;
      const difference = Math.max(
        Math.abs(a[i]! - b[i]!),
        Math.abs(a[i + 1]! - b[i + 1]!),
        Math.abs(a[i + 2]! - b[i + 2]!),
      );
      maxChannelDifference = Math.max(maxChannelDifference, difference);
      if (difference > MP4_OUTSIDE_CHANNEL_TOLERANCE) changedPixels++;
    }
  }
  expect(
    changedPixels,
    `${context}: ${changedPixels} outside-ROI pixels exceeded ${MP4_OUTSIDE_CHANNEL_TOLERANCE}/255 channel tolerance (max channel difference ${maxChannelDifference}); at most ${maxChangedPixels} may exceed it to allow bounded H.264 chroma/quantization spill beyond the aligned 16x16 codec blocks`,
  ).toBeLessThanOrEqual(maxChangedPixels);
  return { changedPixels, maxChannelDifference };
}

function decodeAudio(path: string, context: string): Int16Array {
  const result = spawnSync(
    ffmpeg,
    ['-v', 'error', '-i', path, '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'],
    {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `${context}: ffmpeg s16le decode failed: ${result.error?.message ?? result.stderr?.toString()}`,
    );
  const bytes = Buffer.from(result.stdout);
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function audioRms(
  data: Int16Array,
  startSeconds: number,
  endSeconds: number,
  channels = 1,
): number {
  const from = Math.max(0, Math.floor(startSeconds * 48_000));
  const to = Math.min(data.length, Math.floor(endSeconds * 48_000));
  if (to <= from)
    throw new Error(`Audio interval [${startSeconds}, ${endSeconds}] has no samples.`);
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i * channels]! * data[i * channels]!;
  return Math.sqrt(sum / (to - from));
}

function ffprobeJson(path: string): JsonRecord {
  const result = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`ffprobe failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout) as JsonRecord;
}

/** Whether a process exists right now. Much faster than a full process snapshot. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function processSnapshot(): Promise<Array<{ pid: number; ppid: number; name: string }>> {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `Cannot inspect child process ownership: ${result.error?.message ?? result.stderr}`,
      );
    const parsed = JSON.parse(result.stdout) as
      | Array<{ ProcessId: number; ParentProcessId: number; Name: string }>
      | { ProcessId: number; ParentProcessId: number; Name: string };
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name.toLowerCase(),
    }));
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Cannot inspect child process ownership with ps: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), name: match[3]!.toLowerCase() }]
      : [];
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runStep(
  number: number,
  name: string,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(
      `Step ${number} ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

describe('JOY Media P0-4 cold-process end-to-end acceptance', () => {
  it('runs the P0 slice with independently checked font bytes and FFmpeg version plus reported Chromium', async () => {
    expect(
      existsSync(BUNDLE),
      `Bundled CLI is missing at ${BUNDLE}; run tsc and apps/cli/scripts/bundle.mjs first.`,
    ).toBe(true);
    root = temporaryDirectory('joy-p0-4-');
    const home = join(root, 'home');
    const planDir = join(root, 'plans');
    const mediaDir = join(root, 'media');
    const outputDir = join(root, 'renders');
    for (const directory of [home, planDir, mediaDir, outputDir])
      mkdirSync(directory, { recursive: true });
    baseEnv = { ...process.env, HOME: home, USERPROFILE: home, JOY_REQUIRE_CHROMIUM: '1' };
    const ffmpegOverride = process.env.JOY_MEDIA_FFMPEG?.trim();
    const ffprobeOverride = process.env.JOY_MEDIA_FFPROBE?.trim();
    ffmpeg = ffmpegOverride || 'ffmpeg';
    ffprobe = ffprobeOverride || 'ffprobe';
    if (ffmpegOverride) baseEnv.JOY_MEDIA_FFMPEG = ffmpegOverride;
    if (ffprobeOverride) baseEnv.JOY_MEDIA_FFPROBE = ffprobeOverride;

    await runStep(1, 'tool discovery', async () => {
      expect(
        binaryWorks(ffmpeg, ['-version']),
        `ffmpeg missing; put it on PATH or set JOY_MEDIA_FFMPEG to its executable path (currently ${ffmpeg}).`,
      ).toBe(true);
      expect(
        binaryWorks(ffprobe, ['-version']),
        `ffprobe missing; put it on PATH or set JOY_MEDIA_FFPROBE to its executable path (currently ${ffprobe}).`,
      ).toBe(true);
      const runtime = await import('@joy-media/html-scene-runtime');
      const found =
        process.env.JOY_CHROMIUM_PATH?.trim() ||
        playwrightChromium() ||
        runtime.findChromiumExecutable();
      expect(
        found,
        'Chromium is missing; set JOY_CHROMIUM_PATH to a Chromium or Chrome executable.',
      ).toBeTruthy();
      chromium = found!;
      baseEnv.JOY_CHROMIUM_PATH = chromium;
      expect(
        existsSync(chromium),
        `Chromium executable was not found at ${chromium}; set JOY_CHROMIUM_PATH to its path.`,
      ).toBe(true);
    });

    await runStep(2, 'static video fixture', () => {
      sourceVideo = join(mediaDir, 'static-testsrc-sine.mkv');
      audioWav = join(mediaDir, 'sine.wav');
      const generated = spawnSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=1280x720:rate=30',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000:duration=5',
          '-t',
          '5',
          '-c:v',
          'libx264',
          // The source must be identical on every host: x264 output depends on the processor count.
          '-threads',
          '1',
          '-x264-params',
          'threads=1:lookahead-threads=1:sync-lookahead=0:sliced-threads=0:cpu-independent=1',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'pcm_s16le',
          '-shortest',
          sourceVideo,
        ],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      );
      if (generated.error || generated.status !== 0)
        throw new Error(
          `ffmpeg failed to create the 5-second 1280x720 30 fps testsrc+sine media: ${generated.error?.message ?? generated.stderr}`,
        );
      const wav = spawnSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000:duration=5',
          '-c:a',
          'pcm_s16le',
          audioWav,
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      if (wav.error || wav.status !== 0)
        throw new Error(
          `ffmpeg failed to create the segmented sine fixture: ${wav.error?.message ?? wav.stderr}`,
        );
      const probe = ffprobeJson(sourceVideo);
      expect(
        probe.streams.filter((stream: JsonRecord) => stream.codec_type === 'video'),
      ).toHaveLength(1);
      expect(
        probe.streams.filter((stream: JsonRecord) => stream.codec_type === 'audio'),
      ).toHaveLength(1);
      expect(statSync(sourceVideo).size).toBeGreaterThan(0);
    });

    await runStep(3, 'create, export and populate project', () => {
      primary = createProject('P0 cold process title render', join(root, 'primary'), false);
      setFixtureDuration(primary, 5_000_000);
      const track = checkedCli(
        ['timeline', 'add-track', '--project', primary.file, '--family', 'visual', '--json'],
        'title track setup',
      );
      titleTrackId = track.trackId as string;
      noTitle = createProject('P0 no-title baseline', join(root, 'baseline-title'), false);
      setFixtureDuration(noTitle, 5_000_000);
      noCaption = createProject('P0 no-caption baseline', join(root, 'baseline-caption'), false);
      setFixtureDuration(noCaption, 5_000_000);
      for (const project of [noTitle, noCaption]) {
        checkedCli(
          [
            'timeline',
            'set-audio',
            '--project',
            project.file,
            '--clip',
            project.videoClipId,
            '--mute',
            '--json',
          ],
          `${project.id}: ensure source video muted`,
        );
      }
      const body = fileProject(primary.file);
      expect(Object.keys(body.assets).some((id) => /^asset-/u.test(id))).toBe(true);
      expect(
        body.compositions.root.tracks.find(
          (trackRow: JsonRecord) => trackRow.id === primary!.audioTrackId,
        ).clips,
      ).toHaveLength(3);
      expect(Object.values(body.captionDocuments)).toHaveLength(0);
      expect(basename(sourceVideo)).toBe('static-testsrc-sine.mkv');
    });

    await runStep(4, 'prepare and apply first title plan', () => {
      if (!primary) throw new Error('Project setup from step 3 did not complete.');
      const projectRevision = (JSON.parse(readFileSync(primary.file, 'utf8')) as JsonRecord)
        .revision as number;
      const summary = preparePlan(
        primary,
        [titleOperation({ primary: 'Mina Farzan', secondary: 'Field Producer' })],
        'first-title',
        projectRevision,
        'p0-title-first',
      );
      titleClipId = 'clip-speaker';
      const persisted = JSON.parse(readFileSync(primary.file, 'utf8')) as JsonRecord;
      expect(persisted.project.pluginData['joy.contentTemplates'].instances[titleId]).toMatchObject(
        {
          templateId: 'joy.p0.lower-third',
          lines: { primary: 'Mina Farzan', secondary: 'Field Producer' },
        },
      );
      expect(
        persisted.project.compositions.root.tracks
          .flatMap((track: JsonRecord) => track.clips)
          .find((clip: JsonRecord) => clip.id === titleClipId),
      ).toMatchObject({ startUs: titleStartUs, durationUs: titleDurationUs });
      expect(persisted.project).toBeDefined();
      expect(summary.projectId).toBe(primary.id);
      const ordinaryExport = join(root, 'ordinary-export.json');
      const exported = checkedCli(
        ['project', 'export', primary.file, '--output', ordinaryExport, '--json'],
        'verify ordinary project export body contract',
      );
      expect(exported.path).toBe(ordinaryExport);
      expect(JSON.parse(readFileSync(ordinaryExport, 'utf8'))).toHaveProperty(
        'source.schemaVersion',
        3,
      );
    });

    await runStep(5, 'exact-frame PNG preview', () => {
      if (!primary) throw new Error('Project setup from step 3 did not complete.');
      previewTitle = renderPreview(
        primary,
        2_000_000,
        'title.png',
        'title preview render --frame-us',
      );
      expect(pngDimensions(previewTitle)).toEqual({ width: 1280, height: 720 });
    });

    await runStep(6, 'MP4 render, manifest and ffprobe validation', () => {
      if (!primary) throw new Error('Project setup from step 3 did not complete.');
      const started = Date.now();
      const out = join(outputDir, 'primary');
      const result = runCli(
        ['render', '--project', primary.file, '--preset', 'mp4', '--out', out, '--json'],
        '5-second title MP4 render',
      );
      const elapsed = Date.now() - started;
      expect(result.code, 'MP4 render exit status').toBe(0);
      expect(
        elapsed,
        `5-second 720p 30 fps render took ${elapsed}ms; limit is ${RENDER_LIMIT_MS}ms`,
      ).toBeLessThanOrEqual(RENDER_LIMIT_MS);
      const computedSingleSurfaceRgbaBytes = RENDER_WIDTH * RENDER_HEIGHT * RGBA_BYTES_PER_PIXEL;
      expect(
        computedSingleSurfaceRgbaBytes,
        `computed size of one ${RENDER_WIDTH}x${RENDER_HEIGHT} RGBA surface is ${computedSingleSurfaceRgbaBytes} bytes (${(computedSingleSurfaceRgbaBytes / 1024 / 1024).toFixed(2)} MiB); this is not a measured process peak; limit is ${RENDER_RETAINED_RGBA_LIMIT_BYTES} bytes (256 MiB)`,
      ).toBeLessThanOrEqual(RENDER_RETAINED_RGBA_LIMIT_BYTES);
      console.info(
        `P0-4 title render: ${elapsed}ms; computed single-surface RGBA size ${computedSingleSurfaceRgbaBytes} bytes (${(computedSingleSurfaceRgbaBytes / 1024 / 1024).toFixed(2)} MiB); process peak memory was not measured.`,
      );
      renderOutput = lastEvent(result, 'MP4 render');
      expect(renderOutput.type).toBe('complete');
      expect(renderOutput.mediaProduced).toBe(true);
      renderPath = renderOutput.mediaPath as string;
      expect(existsSync(renderPath)).toBe(true);
      expect(statSync(renderPath).size).toBeGreaterThan(0);
      expect(renderOutput.manifestPath).toEqual(expect.any(String));
      renderManifest = JSON.parse(readFileSync(renderOutput.manifestPath, 'utf8')) as JsonRecord;
      expect(renderManifest).toMatchObject({
        schemaVersion: 2,
        format: 'joy-media-render-manifest',
      });
      expect(renderManifest.renderer).toMatchObject({
        id: 'ffmpeg+chromium-scene-surface',
        version: 1,
      });
      expect(renderManifest.renderer.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(renderManifest.design.instances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instanceId: titleId,
            clipId: titleClipId,
            templateId: 'joy.p0.lower-third',
            startUs: titleStartUs,
            durationUs: titleDurationUs,
            layoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        ]),
      );
      expect(renderManifest.rendererFacts).toMatchObject({
        chromiumVersion: expect.any(String),
        fontManifestHashes: expect.any(Array),
        ffmpegVersionLine: expect.stringMatching(/^ffmpeg version /iu),
      });

      // fontManifestHashes are independently verified against bundled font bytes; FFmpeg's
      // version line is independently queried below. chromiumVersion is self-reported by the
      // render and then included in the fingerprint, so that fingerprint does not independently
      // verify Chromium.
      // (a) fontManifestHashes: each hash must equal the sha256 of one of the four bundled
      // Noto Sans Arabic font files named in packages/html-scene-runtime/assets/fonts/noto-sans-arabic/manifest.json.
      const fontManifestPath = existsSync(
        resolve('packages/html-scene-runtime/assets/fonts/noto-sans-arabic/manifest.json'),
      )
        ? resolve('packages/html-scene-runtime/assets/fonts/noto-sans-arabic/manifest.json')
        : resolve(
            fileURLToPath(new URL('.', import.meta.url)),
            '../../../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/manifest.json',
          );
      const fontManifestDir = dirname(fontManifestPath);
      const fontManifest = JSON.parse(readFileSync(fontManifestPath, 'utf8')) as {
        files: readonly { file: string }[];
      };
      const expectedFontHashes = fontManifest.files
        .map((entry) => {
          const fontBytes = readFileSync(join(fontManifestDir, entry.file));
          return `sha256:${createHash('sha256').update(fontBytes).digest('hex')}`;
        })
        .sort();
      const reportedFontHashes = [...renderManifest.rendererFacts.fontManifestHashes].sort();
      expect(reportedFontHashes).toEqual(expectedFontHashes);

      // (b) ffmpegVersionLine: must equal the first line printed by running the same ffmpeg
      // binary the render uses, with -version.
      const ffmpegBinaryPath = process.env.JOY_MEDIA_FFMPEG?.trim() || ffmpeg || 'ffmpeg';
      const ffmpegProbe = spawnSync(ffmpegBinaryPath, ['-version'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      if (ffmpegProbe.error || ffmpegProbe.status !== 0) {
        throw new Error(
          `Cannot probe ffmpeg version: ${ffmpegProbe.error?.message ?? ffmpegProbe.stderr}`,
        );
      }
      const expectedFfmpegVersionLine = ffmpegProbe.stdout.split(/\r?\n/, 1)[0] ?? '';
      expect(renderManifest.rendererFacts.ffmpegVersionLine).toBe(expectedFfmpegVersionLine);

      // chromiumVersion is only self-reported; a second browser launch would add cost and risk.
      expect(renderManifest.rendererFacts.chromiumVersion.trim()).not.toBe('');
      expect(renderManifest.rendererFacts.fontManifestHashes.length).toBeGreaterThan(0);
      expect(
        renderManifest.rendererFacts.fontManifestHashes.every((value: unknown) =>
          /^(?:sha256:)?[a-f0-9]{64}$/u.test(String(value)),
        ),
      ).toBe(true);
      const expectedRendererFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            ffmpegVersion: renderManifest.rendererFacts.ffmpegVersionLine,
            chromiumVersion: renderManifest.rendererFacts.chromiumVersion,
            templateSha256: renderManifest.design.instances.map((instance: JsonRecord) =>
              templateSha256(instance.templateId),
            ),
            fontManifestHashes: renderManifest.rendererFacts.fontManifestHashes,
          }),
        )
        .digest('hex');
      expect(renderManifest.renderer.fingerprint).toBe(expectedRendererFingerprint);
      const probed = ffprobeJson(renderPath);
      const video = probed.streams.filter((stream: JsonRecord) => stream.codec_type === 'video');
      const audio = probed.streams.filter((stream: JsonRecord) => stream.codec_type === 'audio');
      expect(video).toHaveLength(1);
      expect(audio).toHaveLength(1);
      expect(video[0]).toMatchObject({ width: 1280, height: 720, r_frame_rate: '30/1' });
      expect(Number(probed.format.duration)).toBeCloseTo(5, 3);
      expect(Math.abs(Number(probed.format.duration) - 5)).toBeLessThanOrEqual(1 / FRAME_RATE);
      expect(Number(renderManifest.media.durationUs)).toBe(5_000_000);
    });

    await runStep(7, 'title region and no-title baseline comparison', () => {
      if (!primary || !noTitle)
        throw new Error('Title or baseline project setup did not complete.');
      previewNoTitle = renderPreview(
        noTitle,
        2_000_000,
        'no-title.png',
        'no-title baseline preview',
      );
      const baselineRender = runCli(
        [
          'render',
          '--project',
          noTitle.file,
          '--preset',
          'mp4',
          '--out',
          join(outputDir, 'no-title-baseline'),
          '--json',
        ],
        'no-title baseline MP4 render',
      );
      expect(baselineRender.code, 'no-title baseline MP4 render exit status').toBe(0);
      const baselineEvent = lastEvent(baselineRender, 'no-title baseline MP4 render');
      expect(baselineEvent.type).toBe('complete');
      const baselineMp4Path = baselineEvent.mediaPath as string;
      expect(existsSync(baselineMp4Path)).toBe(true);
      const titled = decodeRgb(previewTitle, 1280, 720, 'decode title preview');
      const baseline = decodeRgb(previewNoTitle, 1280, 720, 'decode no-title preview');
      expect(
        changedPixels(titled, baseline, 1280, ROI),
        'title ROI must contain visible title pixels',
      ).toBeGreaterThan(0);
      expectEqualOutsideRoi(titled, baseline, 1280, 720, 'same-time title/no-title frame');
      const titleMp4Frame = decodeRgbaFrame(renderPath, 60, 'decode title MP4 frame 60 at 60/30s');
      const baselineMp4Frame = decodeRgbaFrame(
        baselineMp4Path,
        60,
        'decode static MP4 frame 60 at 60/30s',
      );
      const outsideRoi = compareOutsideCodecBlockRoi(
        titleMp4Frame,
        baselineMp4Frame,
        RENDER_WIDTH,
        RENDER_HEIGHT,
        'decoded MP4 static/title frame 60 outside 16x16-aligned expanded title ROI',
        MP4_STEP7_OUTSIDE_CHANGED_PIXEL_TOLERANCE,
      );
      console.info(
        `P0-4 decoded MP4 outside-ROI measurement: ${outsideRoi.changedPixels} pixels exceeded ${MP4_OUTSIDE_CHANNEL_TOLERANCE}/255 per-channel tolerance; maximum difference ${outsideRoi.maxChannelDifference}/255.`,
      );
      expect(
        changedPixels(titleMp4Frame, baselineMp4Frame, RENDER_WIDTH, ROI, 0, RGBA_BYTES_PER_PIXEL),
        'decoded MP4 title region must change between the static frame and the title frame',
      ).toBeGreaterThan(0);
      const outsideWindow = decodeRgb(
        renderPreview(
          primary,
          500_000,
          'title-outside.png',
          'title frame outside its active window',
        ),
        1280,
        720,
        'decode title-outside frame',
      );
      const baselineOutsideWindow = decodeRgb(
        renderPreview(
          noTitle,
          500_000,
          'baseline-outside.png',
          'baseline frame outside title window',
        ),
        1280,
        720,
        'decode baseline outside frame',
      );
      expect(outsideWindow).toEqual(baselineOutsideWindow);
    });

    await runStep(8, 'second title plan and pixel stability', () => {
      if (!primary) throw new Error('Project setup from step 3 did not complete.');
      const prior = fileProject(primary.file);
      const priorInstance = prior.pluginData['joy.contentTemplates'].instances[titleId];
      const priorClip = prior.compositions.root.tracks
        .flatMap((track: JsonRecord) => track.clips)
        .find((clip: JsonRecord) => clip.id === titleClipId);
      const update = {
        id: 'update-title',
        op: 'updateTemplateText',
        instanceId: titleId,
        lines: { primary: 'Roya Naderi', secondary: 'Live Correspondent' },
      };
      const current = JSON.parse(readFileSync(primary.file, 'utf8')) as JsonRecord;
      preparePlan(primary, [update], 'second-title', current.revision, 'p0-title-update');
      const after = fileProject(primary.file);
      const afterInstance = after.pluginData['joy.contentTemplates'].instances[titleId];
      const afterClip = after.compositions.root.tracks
        .flatMap((track: JsonRecord) => track.clips)
        .find((clip: JsonRecord) => clip.id === titleClipId);
      expect(afterInstance.clipId).toBe(priorInstance.clipId);
      expect(afterInstance.clipId).toBe(afterClip.id);
      expect(priorInstance.clipId).toBe(priorClip.id);
      expect(afterClip.id).toBe(priorClip.id);
      expect(afterClip).toMatchObject({
        startUs: priorClip.startUs,
        durationUs: priorClip.durationUs,
      });
      previewUpdated = renderPreview(
        primary,
        2_000_000,
        'updated-title.png',
        'updated title preview',
      );
      const oldPixels = decodeRgb(previewTitle, 1280, 720, 'decode first title frame');
      const newPixels = decodeRgb(previewUpdated, 1280, 720, 'decode updated title frame');
      expect(
        changedPixels(oldPixels, newPixels, 1280, ROI),
        'second title text must change pixels in title ROI',
      ).toBeGreaterThan(0);
      expectEqualOutsideRoi(oldPixels, newPixels, 1280, 720, 'first/second title text frames');

      const secondRender = runCli(
        [
          'render',
          '--project',
          primary.file,
          '--preset',
          'mp4',
          '--out',
          join(outputDir, 'primary-second-title'),
          '--json',
        ],
        'second title MP4 render',
      );
      expect(secondRender.code, 'second title MP4 render exit status').toBe(0);
      const secondRenderEvent = lastEvent(secondRender, 'second title MP4 render');
      expect(secondRenderEvent).toMatchObject({ type: 'complete', mediaProduced: true });
      const secondRenderPath = String(secondRenderEvent.mediaPath);
      expect(existsSync(secondRenderPath)).toBe(true);
      const firstMp4Frame = decodeRgbaFrame(renderPath, 60, 'decode first title MP4 frame 60');
      const secondMp4Frame = decodeRgbaFrame(
        secondRenderPath,
        60,
        'decode second title MP4 frame 60',
      );
      expect(
        changedPixels(firstMp4Frame, secondMp4Frame, RENDER_WIDTH, ROI, 0, RGBA_BYTES_PER_PIXEL),
        'second MP4 title must differ from the first render in the title ROI',
      ).toBeGreaterThan(0);
      compareOutsideCodecBlockRoi(
        firstMp4Frame,
        secondMp4Frame,
        RENDER_WIDTH,
        RENDER_HEIGHT,
        'decoded first/second title MP4 frames outside the title region',
      );
    });

    await runStep(9, 'decoded audio gain, fade and mute envelope', () => {
      if (!renderPath) throw new Error('MP4 output from step 6 is unavailable.');
      const audio = decodeAudio(renderPath, 'decode AAC output to s16le');
      const source = spawnSync(
        ffmpeg,
        ['-v', 'error', '-i', audioWav, '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 20_000, windowsHide: true },
      );
      if (source.error || source.status !== 0)
        throw new Error(
          `Cannot decode source sine audio: ${source.error?.message ?? source.stderr}`,
        );
      const sourceSamples = new Int16Array(
        Buffer.from(source.stdout).buffer.slice(
          Buffer.from(source.stdout).byteOffset,
          Buffer.from(source.stdout).byteOffset + Buffer.from(source.stdout).byteLength,
        ),
      );
      const gainRatio = audioRms(audio, 0.8, 1.5, 2) / audioRms(sourceSamples, 0.8, 1.5);
      expect(
        Math.abs(gainRatio - 0.5 * AUDIO_STEREO_MIX_FACTOR),
        `steady audio gain ratio ${gainRatio} for configured 0.5 gain after stereo mix factor ${AUDIO_STEREO_MIX_FACTOR}`,
      ).toBeLessThanOrEqual(AUDIO_GAIN_TOLERANCE);
      expect(audioRms(audio, 0.05, 0.15, 2) / audioRms(audio, 0.8, 1.5, 2)).toBeLessThan(
        AUDIO_FADE_ENVELOPE_MAX_RATIO,
      );
      expect(audioRms(audio, 4.85, 4.95, 2) / audioRms(audio, 3.2, 3.3, 2)).toBeLessThan(
        AUDIO_FADE_ENVELOPE_MAX_RATIO,
      );
      expect(
        audioRms(audio, 2.1, 2.4, 2),
        'middle 2.0-2.5 second audio clip is muted',
      ).toBeLessThanOrEqual(MUTED_RMS_MAX);
    });

    await runStep(10, 'caption boundary and ASS renderer evidence', () => {
      if (!primary || !noCaption) throw new Error('Caption test project setup did not complete.');
      const captionProject = createProject(
        'P0 English caption boundary proof',
        join(root, 'caption-boundary'),
        true,
      );
      const baseline = runCli(
        [
          'render',
          '--project',
          noCaption.file,
          '--preset',
          'mp4',
          '--out',
          join(root, 'no-caption-render'),
          '--json',
        ],
        'no-caption ASS boundary baseline render',
      );
      expect(baseline.code, 'no-caption baseline render exit status').toBe(0);
      const baselineEvent = lastEvent(baseline, 'no-caption baseline render');
      expect(baselineEvent.type).toBe('complete');
      const noCaptionPath = baselineEvent.mediaPath as string;
      expect(existsSync(noCaptionPath)).toBe(true);
      const operationsPath = join(root, 'caption-plan.operations.json');
      const planPath = join(root, 'caption-plan.json');
      writeFileSync(operationsPath, JSON.stringify({ schemaVersion: 1, operations: [] }, null, 2));
      const prepared = runCliAllowingExit(
        [
          'plan',
          'prepare',
          operationsPath,
          '--project',
          captionProject.file,
          '--output',
          planPath,
          '--json',
        ],
        'caption ASS preparation',
      );
      const refusal = captionFaceRefusal(prepared);
      if (refusal !== undefined) {
        // Accepted on this host (owner decision, 2026-10-20). Its libass cannot load the canonical WOFF2
        // caption face, so the CLI refuses captions before any caption pixel exists. The caption render
        // and boundary checks below run only on a host where that face loads.
        console.info(`P0-4 caption step: captions refused on this host: ${refusal}`);
        return;
      }
      if (prepared.code !== 0) {
        const event = prepared.events.at(-1);
        throw new Error(
          `caption ASS preparation: exit ${String(prepared.code)}: ${event?.message ?? prepared.stderr.trim()}`,
        );
      }
      checkedCli(
        [
          'plan',
          'apply',
          planPath,
          '--project',
          captionProject.file,
          '--expected-revision',
          String((JSON.parse(readFileSync(captionProject.file, 'utf8')) as JsonRecord).revision),
          '--idempotency-key',
          'p0-caption-plan',
          '--json',
        ],
        'caption ASS plan apply',
      );
      const captionRender = runCli(
        [
          'render',
          '--project',
          captionProject.file,
          '--preset',
          'mp4',
          '--out',
          join(root, 'caption-render'),
          '--json',
        ],
        'English ASS caption render',
      );
      expect(captionRender.code, 'English ASS caption render exit status').toBe(0);
      const captionRenderEvent = lastEvent(captionRender, 'English ASS caption render');
      expect(captionRenderEvent.type).toBe('complete');
      const captionRenderPath = captionRenderEvent.mediaPath as string;
      expect(existsSync(captionRenderPath)).toBe(true);
      const firstVisibleFrame = FRAME_RATE * 1.5;
      const lastVisibleFrame = FRAME_RATE * 2.5 - 1;
      const firstAfterEndFrame = FRAME_RATE * 2.5;
      const firstVisible = decodeRgbaFrame(
        captionRenderPath,
        firstVisibleFrame,
        'decode first visible caption frame 45 at 45/30s',
      );
      const firstVisibleBaseline = decodeRgbaFrame(
        noCaptionPath,
        firstVisibleFrame,
        'decode first visible caption baseline frame 45 at 45/30s',
      );
      const visibleCaptionPixels = changedPixels(
        firstVisible,
        firstVisibleBaseline,
        RENDER_WIDTH,
        CAPTION_BAND,
        CAPTION_PIXEL_THRESHOLD,
        RGBA_BYTES_PER_PIXEL,
      );
      expect(
        visibleCaptionPixels,
        'caption must first appear on frame 45 at 45/30s',
      ).toBeGreaterThan(0);
      const lastVisible = decodeRgbaFrame(
        captionRenderPath,
        lastVisibleFrame,
        'decode last visible caption frame 74 at 74/30s',
      );
      const lastVisibleBaseline = decodeRgbaFrame(
        noCaptionPath,
        lastVisibleFrame,
        'decode last visible caption baseline frame 74 at 74/30s',
      );
      const lastVisibleCaptionPixels = changedPixels(
        lastVisible,
        lastVisibleBaseline,
        RENDER_WIDTH,
        CAPTION_BAND,
        CAPTION_PIXEL_THRESHOLD,
        RGBA_BYTES_PER_PIXEL,
      );
      expect(
        lastVisibleCaptionPixels,
        'caption must remain visible on frame 74 at 74/30s',
      ).toBeGreaterThan(0);
      const outside = decodeRgbaFrame(
        captionRenderPath,
        firstAfterEndFrame,
        'decode first frame after caption end, frame 75 at 75/30s',
      );
      const noCaptionOutside = decodeRgbaFrame(
        noCaptionPath,
        firstAfterEndFrame,
        'decode baseline first frame after caption end, frame 75 at 75/30s',
      );
      const outsideCaptionPixels = changedPixels(
        outside,
        noCaptionOutside,
        RENDER_WIDTH,
        CAPTION_BAND,
        CAPTION_PIXEL_THRESHOLD,
        RGBA_BYTES_PER_PIXEL,
      );
      expect(
        outsideCaptionPixels,
        `Step 10 first frame after caption end is 75/30s; ${outsideCaptionPixels} caption-band pixels differed from the no-caption baseline, bound ${CAPTION_OUTSIDE_PIXEL_COUNT_TOLERANCE}`,
      ).toBeLessThanOrEqual(CAPTION_OUTSIDE_PIXEL_COUNT_TOLERANCE);
      expect(captionRenderEvent.message).toContain('Captions: ass.');
      const captionManifest = JSON.parse(
        readFileSync(captionRenderEvent.manifestPath as string, 'utf8'),
      ) as JsonRecord;
      expect(captionManifest.captions).toEqual({ mode: 'ass' });
    });

    await runStep(11, 'portable desktop export and artifact refusal', () => {
      if (!primary) throw new Error('Project setup from step 3 did not complete.');
      const desktopPath = join(root, 'desktop-project.json');
      try {
        const exported = checkedCli(
          ['project', 'export', primary.file, '--desktop', '--output', desktopPath, '--json'],
          'portable desktop project export',
        );
        expect(exported.path).toBe(desktopPath);
        const desktop = JSON.parse(readFileSync(desktopPath, 'utf8')) as JsonRecord;
        expect(desktop).toMatchObject({
          format: 'joy-media-project',
          schemaVersion: 1,
          app: 'JOY Studio',
        });
        expect(desktop.documents).toEqual(
          expect.objectContaining({
            timeline: expect.any(Object),
            visual: expect.any(Object),
            lookInstances: expect.any(Object),
          }),
        );
        const embedded = desktop.media.find(
          (item: JsonRecord) =>
            item.asset?.displayName === basename(sourceVideo) ||
            item.asset?.descriptor?.mimeType === 'video/x-matroska',
        );
        expect(embedded).toMatchObject({
          status: 'embedded',
          sha256: createHash('sha256').update(readFileSync(sourceVideo)).digest('hex'),
          byteLength: readFileSync(sourceVideo).byteLength,
        });
        expect(Buffer.from(embedded.dataBase64, 'base64')).toEqual(readFileSync(sourceVideo));
        const title =
          desktop.documents.visual.pluginData['joy.contentTemplates'].instances[titleId];
        expect(title.font).toMatchObject({
          family: 'Noto Sans Arabic',
          weight: 700,
          sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        });
      } catch (error) {
        failures.push(
          `Step 11 portable desktop export: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const originalProject = readFileSync(primary.file);
      const body = JSON.parse(originalProject.toString('utf8')) as JsonRecord;
      body.project.artifacts = {
        'unmapped-artifact': {
          id: 'unmapped-artifact',
          kind: 'script',
          schemaVersion: 1,
          revision: 0,
          label: 'Unmapped artifact',
          contentRef: { type: 'inline', value: 'P0 refusal fixture' },
          binding: { type: 'range', startUs: 0, durationUs: 1_000_000 },
          provenance: {
            sourceArtifactIds: [],
            inputHashes: [],
            createdBy: { type: 'human', id: 'p0-test' },
          },
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
      };
      writeFileSync(primary.file, JSON.stringify(body));
      const refusalPath = join(root, 'artifact-refusal.json');
      try {
        const refusal = spawnSync(
          process.execPath,
          [
            BUNDLE,
            'project',
            'export',
            primary.file,
            '--desktop',
            '--output',
            refusalPath,
            '--json',
          ],
          { env: baseEnv, encoding: 'utf8', timeout: 60_000, windowsHide: true },
        );
        expect(refusal.error).toBeUndefined();
        const refusalEvents = parseJsonLines(refusal.stdout ?? '', 'artifact export refusal');
        expect(refusal.status).not.toBe(0);
        expect(
          refusalEvents.at(-1),
          `artifact refusal output was ${JSON.stringify(refusalEvents.at(-1))}`,
        ).toMatchObject({
          type: 'error',
          code: 'DESKTOP_PROJECTION_UNMAPPED_ARTIFACTS',
        });
        expect(existsSync(refusalPath), 'failed desktop export must not write an output file').toBe(
          false,
        );
      } finally {
        writeFileSync(primary.file, originalProject);
      }
    });

    await runStep(12, 'browser-active and encoder-active cancellation cleanup', async () => {
      if (!primary) throw new Error('Project setup from step 3 did not complete.');
      const fixtureEnvelope = JSON.parse(readFileSync(primary.file, 'utf8')) as JsonRecord;
      const cancellationBody = fixtureEnvelope.project as JsonRecord;
      const rootComposition = cancellationBody.compositions.root as JsonRecord;
      const cancellationInstances = cancellationBody.pluginData['joy.contentTemplates']
        .instances as Record<string, JsonRecord>;
      const previousTitle = cancellationInstances[titleId];
      if (!previousTitle)
        throw new Error('The cancellation fixture expected the title applied in step 4.');
      delete cancellationInstances[titleId];
      delete (cancellationBody.visualObjects as JsonRecord)[previousTitle.objectId as string];
      const clipObjects = cancellationBody.pluginData['joy.clipObjects'] as JsonRecord;
      delete clipObjects[previousTitle.clipId as string];
      for (const track of rootComposition.tracks as JsonRecord[])
        track.clips = (track.clips as JsonRecord[]).filter(
          (clip) => clip.id !== previousTitle.clipId,
        );
      delete cancellationBody.pluginData['joy.renderPreparation'];
      rootComposition.tracks = (rootComposition.tracks as JsonRecord[]).filter(
        (track) => track.id !== primary!.captionTrackId && track.kind !== 'caption',
      );
      cancellationBody.captionDocuments = {};
      const cancellationProject = join(root, 'cancellation-no-captions.json');
      writeFileSync(
        cancellationProject,
        JSON.stringify({ ...fixtureEnvelope, project: cancellationBody }),
      );
      const cancellationFixture: ProjectFixture = { ...primary, file: cancellationProject };
      // Keep FFmpeg active long enough for the parent to observe its progress PID. 60 s is the
      // longest composition a title operation accepts.
      setFixtureDuration(cancellationFixture, 60_000_000);
      preparePlan(
        cancellationFixture,
        [titleOperation({ primary: 'Cancel fixture', secondary: 'No captions' })],
        'cancel-no-captions',
        13,
        'p0-cancel-title',
      );

      const cancelCase = async (phase: 'browser-active' | 'encoder-active'): Promise<void> => {
        const caseName = `${phase} title render cancellation`;
        const cancellationOut = join(root, `cancel-${phase}`);
        const ownedPids: number[] = [];
        const ownedPaths = new Set<string>();
        let profilePath: string | undefined;
        let child: ReturnType<typeof fork> | undefined;
        let cancelledAt: number | undefined;
        let processExitMs: number | undefined;
        let cancelledResult = false;
        let stdout = '';
        let stderr = '';
        let pending = '';
        try {
          child = fork(
            BUNDLE,
            [
              'render',
              '--project',
              cancellationProject,
              '--preset',
              'mp4',
              '--out',
              cancellationOut,
              '--json',
            ],
            {
              cwd: process.cwd(),
              env: baseEnv,
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
              detached: true,
            },
          );
          child.stdout?.setEncoding('utf8');
          child.stderr?.setEncoding('utf8');
          const ready = new Promise<JsonRecord>((resolvePromise, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `${caseName}: active readiness was not emitted. ${stdout.trim()} ${stderr.trim()}`,
                  ),
                ),
              30_000,
            );
            child!.once('close', () => {
              clearTimeout(timer);
              reject(new Error(`${caseName}: process exited before readiness.`));
            });
            child!.stdout?.on('data', (chunk: string) => {
              stdout += chunk;
              pending += chunk;
              const lines = pending.split(/\r?\n/u);
              pending = lines.pop() ?? '';
              for (const line of lines) {
                try {
                  const event = JSON.parse(line) as JsonRecord;
                  if (event.type === 'cancel-ready' && event.phase === phase) {
                    clearTimeout(timer);
                    resolvePromise(event);
                  }
                } catch {
                  /* wait for complete JSON lines */
                }
              }
            });
            child!.stderr?.on('data', (chunk: string) => {
              stderr += chunk;
            });
          });
          const exitPromise = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>((resolvePromise) => {
            child!.once('exit', (code, signal) => {
              processExitMs = cancelledAt === undefined ? undefined : Date.now() - cancelledAt;
              resolvePromise({ code, signal });
            });
          });
          const readyEvent = await ready;
          const reportedPids = readyEvent.ownedPids as number[];
          expect(reportedPids.length, `${caseName}: owned process ids reported`).toBeGreaterThan(0);
          ownedPids.push(...reportedPids);
          profilePath = readyEvent.profilePath as string;
          ownedPaths.add(profilePath);
          for (const path of (readyEvent.ownedDirectories as string[] | undefined) ?? [])
            ownedPaths.add(path);
          expect(existsSync(profilePath), `${caseName}: browser profile exists at readiness`).toBe(
            true,
          );
          const activePid = readyEvent.activePid as number;
          expect(ownedPids).toContain(activePid);
          // Probe the active PID at once. A full process snapshot takes long enough on a loaded
          // machine for a short encode to finish first, and this check needs only one PID.
          expect(
            processIsAlive(activePid),
            `${caseName}: active PID ${activePid} is alive before interrupt`,
          ).toBe(true);
          cancelledAt = Date.now();
          if (process.platform === 'win32') {
            child.send({ type: 'joy-media-cancel' });
          } else {
            process.kill(-child.pid!, 'SIGINT');
          }
          const exit = await Promise.race([
            exitPromise,
            delay(5_000).then(() => {
              throw new Error(`${caseName}: process did not exit within 5 seconds after cancel.`);
            }),
          ]);
          const parsed = parseJsonLines(stdout, `${caseName} output`);
          cancelledResult = parsed.some(
            (event) => event.type === 'error' && event.code === 'cancelled',
          );
          expect(cancelledResult, `${caseName}: render result is cancelled`).toBe(true);
          expect(
            parsed.some(
              (event) =>
                event.type === 'cancel-signal' &&
                event.signal === (process.platform === 'win32' ? 'IPC_CANCEL' : 'SIGINT'),
            ),
            `${caseName}: render cancellation handler observed cancel`,
          ).toBe(true);
          expect(exit.code !== null || exit.signal !== null, `${caseName}: bundle exited`).toBe(
            true,
          );
          const cleanupStart = cancelledAt ?? Date.now();
          const after = await processSnapshot();
          const surviving = ownedPids.filter((pid) => after.some((process) => process.pid === pid));
          expect(surviving, `${caseName}: product cleanup leaves no owned process`).toEqual([]);
          for (const path of ownedPaths)
            expect(existsSync(path), `${caseName}: product cleanup removes ${path}`).toBe(false);
          expect(
            existsSync(cancellationOut),
            `${caseName}: product cleanup removes its output directory`,
          ).toBe(false);
          const outputFiles = existsSync(cancellationOut) ? readdirSync(cancellationOut) : [];
          const unexpectedOutput = outputFiles.filter((name) =>
            /\.partial$|\.(?:mp4|webm|prores)$|\.manifest\.json$/u.test(name),
          );
          const elapsedMs = Date.now() - cleanupStart;
          expect(
            unexpectedOutput,
            `${caseName}: partial/published output remained: ${JSON.stringify(unexpectedOutput)}`,
          ).toEqual([]);
          expect(
            elapsedMs,
            `${caseName}: cancellation and product cleanup <= 5 seconds (process exit ${processExitMs ?? 'unknown'} ms; stdout tail=${stdout.slice(-1200)}; stderr tail=${stderr.slice(-1200)})`,
          ).toBeLessThanOrEqual(5_000);
          cancellationCaseResults.push(
            JSON.stringify({
              type: 'cancel-case-result',
              caseName,
              result: 'PASS',
              cleanupMs: elapsedMs,
              processExitMs,
              ownedPids,
              ownedProcessesAliveAfter: surviving.length > 0,
              unexpectedOutput,
            }),
          );
          process.stderr.write(
            `${JSON.stringify({
              type: 'cancel-case-result',
              caseName,
              result: 'PRODUCT_CLEANUP_COMPLETE',
              cleanupMs: elapsedMs,
              ownedPids,
              ownedProcessesAliveAfter: surviving.length > 0,
              interruptMethod:
                process.platform === 'win32' ? 'fork IPC' : 'POSIX process-group SIGINT',
            })}\n`,
          );
        } finally {
          // Assertions above observe product cleanup. Emergency cleanup below only protects the
          // test host after those assertions have had a chance to fail honestly.
          const forceCleanupDeadline = Date.now() + 2_000;
          if (child?.pid && child.exitCode === null) {
            if (process.platform === 'win32') {
              spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], {
                encoding: 'utf8',
                timeout: Math.max(1, forceCleanupDeadline - Date.now()),
                windowsHide: true,
              });
            } else {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                /* process group already exited */
              }
            }
          }
          let current = await processSnapshot();
          for (const pid of ownedPids) {
            if (!current.some((process) => process.pid === pid)) continue;
            if (process.platform === 'win32') {
              spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], {
                encoding: 'utf8',
                timeout: Math.max(1, forceCleanupDeadline - Date.now()),
                windowsHide: true,
              });
            } else {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                /* process already exited */
              }
            }
            current = await processSnapshot();
          }
          if (profilePath) ownedPaths.add(profilePath);
          for (const path of ownedPaths) rmSync(path, { recursive: true, force: true });
          rmSync(cancellationOut, { recursive: true, force: true });
          for (let attempt = 0; attempt < 100; attempt++) {
            const current = await processSnapshot();
            if (ownedPids.every((pid) => !current.some((process) => process.pid === pid))) break;
            await delay(25);
          }
        }
      };
      const caseFailures: string[] = [];
      for (const phase of ['browser-active', 'encoder-active'] as const) {
        try {
          await cancelCase(phase);
        } catch (error) {
          caseFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (caseFailures.length) throw new Error(caseFailures.join('\n'));
    });

    if (failures.length) throw new Error([...failures, ...cancellationCaseResults].join('\n'));
  }, 300_000);

  afterAll(() => {
    for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
  });
});
