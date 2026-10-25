import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegBinary } from '../utils/media-probe.js';
import {
  captureProductionComposite,
  checkCaptionTiming,
  checkEncodedFidelity,
  FRAME_RATE,
  RENDER_HEIGHT,
  RENDER_WIDTH,
  type CueFrames,
  type ProductionComposite,
} from './caption-frame-evidence.js';

// The cue runs from 1.5 s to 2.5 s, so it is visible on frames 45 to 74 and absent from frame 75 on.
const CUE: CueFrames = { firstFrame: 1.5 * FRAME_RATE, endFrame: 2.5 * FRAME_RATE };
const CUE_TEXT = 'CAPTION WINDOW PROOF';
const FIXTURE_SECONDS = 5;
const BUNDLE = resolve('apps/cli/dist/joy-media-bundle.mjs');

type JsonRecord = Record<string, any>;

// Writes a measurement to JOY_CAPTION_EVIDENCE_DIR when that variable is set. The file is written before the assertion,
// so a failing run also leaves its numbers behind.
function recordEvidence(name: string, data: unknown): void {
  const directory = process.env.JOY_CAPTION_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(data, null, 2));
}

// The discovery order of the P0 design test: a Playwright-installed Chromium first. A user's own Chrome can refuse a
// second DevTools instance while it is open, so the Playwright build is preferred.
function playwrightChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : undefined,
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
  ].filter((path): path is string => Boolean(path));
  const relatives =
    process.platform === 'win32'
      ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
      : process.platform === 'darwin'
        ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium']
        : ['chrome-linux/chrome', 'chrome-linux64/chrome'];
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
      for (const relative of relatives) {
        const candidate = join(directory, revision, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

describe('caption timing and encoded-output fidelity', () => {
  let root = '';
  let env: NodeJS.ProcessEnv = {};
  let captionProject = '';
  let baselineProject = '';
  let captionMp4 = '';
  let caption: ProductionComposite;
  let baseline: ProductionComposite;

  function cli(args: string[]): { code: number | null; events: JsonRecord[]; stderr: string } {
    const result = spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw new Error(`bundled CLI did not start: ${result.error.message}`);
    const events = String(result.stdout ?? '')
      .split(/\r?\n/u)
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as JsonRecord);
    return { code: result.status, events, stderr: String(result.stderr ?? '') };
  }

  function cliChecked(args: string[], context: string): JsonRecord {
    const result = cli(args);
    const last = result.events.at(-1);
    if (result.code !== 0)
      throw new Error(
        `${context}: exit ${String(result.code)}${last?.code ? ` (${String(last.code)})` : ''}: ${String(last?.message ?? result.stderr.trim())}`,
      );
    if (!last) throw new Error(`${context}: no JSON event`);
    return last;
  }

  function createProject(title: string, directory: string, picture: string, withCaption: boolean) {
    mkdirSync(directory, { recursive: true });
    const database = join(directory, 'project.sqlite');
    const file = join(directory, 'project.json');
    const created = cliChecked(
      [
        'project',
        'create',
        title,
        '--width',
        String(RENDER_WIDTH),
        '--height',
        String(RENDER_HEIGHT),
        '--fps',
        String(FRAME_RATE),
        '--sqlite-path',
        database,
        '--json',
      ],
      `${title}: project create`,
    );
    cliChecked(
      [
        'project',
        'export',
        String(created['id']),
        '--sqlite-path',
        database,
        '--output',
        file,
        '--json',
      ],
      `${title}: project export`,
    );
    cliChecked(
      [
        'timeline',
        'add-clip',
        '--project',
        file,
        '--track',
        'track-v1',
        '--asset',
        picture,
        '--start',
        '0',
        '--duration',
        String(FIXTURE_SECONDS),
        '--json',
      ],
      `${title}: add the picture clip`,
    );
    if (withCaption) {
      const track = cliChecked(
        ['timeline', 'add-track', '--project', file, '--family', 'caption', '--json'],
        `${title}: add the caption track`,
      );
      cliChecked(
        [
          'timeline',
          'add-caption',
          '--project',
          file,
          '--track',
          String(track['trackId']),
          '--start',
          String(CUE.firstFrame / FRAME_RATE),
          '--duration',
          String((CUE.endFrame - CUE.firstFrame) / FRAME_RATE),
          '--text',
          CUE_TEXT,
          '--language',
          'en',
          '--direction',
          'ltr',
          '--json',
        ],
        `${title}: add the caption cue`,
      );
    }
    return file;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'joy-caption-frames-'));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const runtime = await import('@joy-media/html-scene-runtime');
    const chromium =
      process.env.JOY_CHROMIUM_PATH?.trim() ||
      playwrightChromium() ||
      runtime.findChromiumExecutable();
    if (!chromium)
      throw new Error(
        'Chromium is missing; set JOY_CHROMIUM_PATH to a Chromium or Chrome executable.',
      );
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      JOY_REQUIRE_CHROMIUM: '1',
      JOY_CHROMIUM_PATH: chromium,
    };

    const picture = join(root, 'picture.mp4');
    const backdrop = spawnSync(
      ffmpegBinary(),
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${RENDER_WIDTH}x${RENDER_HEIGHT}:rate=${FRAME_RATE}:duration=${FIXTURE_SECONDS}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        picture,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (backdrop.status !== 0)
      throw new Error(`backdrop generation failed: ${String(backdrop.stderr)}`);

    captionProject = createProject('caption frames', join(root, 'caption'), picture, true);
    baselineProject = createProject(
      'caption frames baseline',
      join(root, 'baseline'),
      picture,
      false,
    );

    const operations = join(root, 'operations.json');
    writeFileSync(operations, JSON.stringify({ schemaVersion: 1, operations: [] }));
    const plan = join(root, 'caption.plan.json');
    const prepared = cli([
      'plan',
      'prepare',
      operations,
      '--project',
      captionProject,
      '--output',
      plan,
      '--json',
    ]);
    if (prepared.code !== 0)
      throw new Error(
        `caption plan prepare failed: ${String(prepared.events.at(-1)?.message ?? prepared.stderr.trim())} :: ${prepared.stderr.slice(-1200)}`,
      );
    const revision = (JSON.parse(readFileSync(captionProject, 'utf8')) as JsonRecord)['revision'];
    cliChecked(
      [
        'plan',
        'apply',
        plan,
        '--project',
        captionProject,
        '--expected-revision',
        String(revision),
        '--idempotency-key',
        'caption-frame-evidence',
        '--json',
      ],
      'caption plan apply',
    );
    const rendered = cliChecked(
      [
        'render',
        '--project',
        captionProject,
        '--preset',
        'mp4',
        '--out',
        join(root, 'render'),
        '--json',
      ],
      'caption render',
    );
    expect(rendered['type']).toBe('complete');
    captionMp4 = String(rendered['mediaPath']);
    expect(statSync(captionMp4).size).toBeGreaterThan(0);

    caption = await captureProductionComposite({
      projectFile: captionProject,
      environment: env,
      workDir: join(root, 'composite-caption'),
    });
    baseline = await captureProductionComposite({
      projectFile: baselineProject,
      environment: env,
      workDir: join(root, 'composite-baseline'),
    });
  }, 900_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('places caption ink on frames 45 to 74 of the production composite, and nothing else changes', async () => {
    const timing = await checkCaptionTiming(caption, baseline, CUE);
    expect(timing.frameCount).toBe(FIXTURE_SECONDS * FRAME_RATE);
    recordEvidence('timing', { ...timing, filterGraphSha256: caption.filterGraphSha256 });
    expect(timing.violations, 'pre-encoding caption timing').toEqual([]);
  }, 600_000);

  it('encodes the same composite: decodable, every frame at least 40 dB luma PSNR, caption visible while active', async () => {
    const fidelity = await checkEncodedFidelity({
      mp4Path: captionMp4,
      workDir: join(root, 'fidelity-caption'),
      caption,
      baseline,
      cue: CUE,
    });
    expect(fidelity.frameCount).toBe(FIXTURE_SECONDS * FRAME_RATE);
    recordEvidence('fidelity', fidelity);
    expect(fidelity.violations, 'encoded output fidelity').toEqual([]);
  }, 600_000);

  it('rejects an encoded output with an intentional visual defect on caption-free frames', async () => {
    // A 200 x 80 light block on frames 100 to 109 of the composite, encoded with the same libx264 settings.
    const yuv = readFileSync(caption.yuvPath);
    const frameBytes = (RENDER_WIDTH * RENDER_HEIGHT * 3) / 2;
    for (let n = 100; n < 110; n++) {
      for (let y = 200; y < 280; y++) {
        for (let x = 400; x < 600; x++) yuv[n * frameBytes + y * RENDER_WIDTH + x] = 235;
      }
    }
    const defectiveYuv = join(root, 'defective.yuv');
    writeFileSync(defectiveYuv, yuv);
    const defectiveMp4 = join(root, 'defective.mp4');
    const encoded = spawnSync(
      ffmpegBinary(),
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        `${RENDER_WIDTH}x${RENDER_HEIGHT}`,
        '-r',
        String(FRAME_RATE),
        '-i',
        defectiveYuv,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        defectiveMp4,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(encoded.status, String(encoded.stderr)).toBe(0);
    const fidelity = await checkEncodedFidelity({
      mp4Path: defectiveMp4,
      workDir: join(root, 'fidelity-defect'),
      caption,
      baseline,
      cue: CUE,
    });
    const defectFrames = fidelity.violations.filter((violation) =>
      /^frame (10[0-9]):/u.test(violation),
    );
    recordEvidence('defect-control', { violations: fidelity.violations });
    expect(defectFrames.length, 'defective frames are reported').toBeGreaterThan(0);
    expect(fidelity.violations.some((violation) => violation.includes('luma PSNR'))).toBe(true);
  }, 600_000);

  it('rejects an encoded output whose bytes are corrupted', async () => {
    const corrupted = join(root, 'corrupted.mp4');
    copyFileSync(captionMp4, corrupted);
    const size = statSync(corrupted).size;
    const bytes = readFileSync(corrupted);
    // The output is faststart, so the middle of the file is media data, not the index.
    bytes.fill(0, Math.floor(size / 2), Math.floor(size / 2) + 8192);
    writeFileSync(corrupted, bytes);
    let violations: readonly string[];
    try {
      violations = (
        await checkEncodedFidelity({
          mp4Path: corrupted,
          workDir: join(root, 'fidelity-corrupted'),
          caption,
          baseline,
          cue: CUE,
        })
      ).violations;
    } catch (error) {
      // An index-level failure is also a refusal, as long as the corrupt file is not accepted.
      violations = [error instanceof Error ? error.message : String(error)];
    }
    recordEvidence('corruption-control', { violations });
    expect(violations.length, 'corruption is reported').toBeGreaterThan(0);
  }, 600_000);
});
