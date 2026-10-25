import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AssetRecordV1,
  JoyProjectV1,
  SpikeProject,
  VideoClip,
} from '../../packages/project-schema/src/index.js';
import { READINESS_TOLERANCES as tolerance } from '../../packages/test-fixtures/src/readiness/tolerances.js';
import { authenticate, E2E_TOKEN } from '../e2e/wp29-r5-harness.js';

const fixtureDirectory = resolve('packages/test-fixtures/media');
const unpackedPackage = resolve('apps/desktop/dist/joy-media-unpacked');
const desktopRequire = createRequire(resolve('apps/desktop/package.json'));
const installedExecutable = process.env.JOY_MEDIA_TEST_EXECUTABLE;
// Extra arguments for the packaged app, such as the GPU fallback relaunch argument. Empty unless set.
const extraAppArguments = (process.env.JOY_MEDIA_TEST_APP_ARGS ?? '').split(' ').filter(Boolean);
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const width = 320;
const height = 180;
const fps = 30;
const durationSeconds = 6;
const sampleRate = 48_000;
// Same normalized RGB MAE bound as editor-acceptance.spec.ts. Local pixel
// expectations below are tighter so a missing small overlay cannot hide in MAE.
const previewExportTolerance = 0.2;
const colorTolerance = 12;
const captionText = readFileSync(join(fixtureDirectory, 'captions-fa.vtt'), 'utf8')
  .trim()
  .split(/\r?\n/u)
  .at(-1)!;
// Caption nodes omit fontFamily; Pixi's shipped TextStyle default is Arial.
const captionFont = 'Arial';
const captionFontSize = height * 0.045 * 2.5;
const sampleTimes = [0.5, 0.9, 1, 1.5, 2.9, 3, 3.1, 4, 4.5, 5.1, 5.5] as const;
type Rgb = readonly [number, number, number];
type Probe = {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    channels?: number;
    sample_rate?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    nb_read_frames?: string;
    duration?: string;
  }[];
  format: { duration: string };
};
type FontResult = {
  available: boolean;
  reason?: string;
  referencePng?: string;
  wrongOrderReferencePng?: string;
};

function run(tool: string, args: readonly string[], input?: Buffer): Buffer {
  return execFileSync(tool, [...args], { input, windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// Minimal launch/open/seek/download helpers copied from editor-acceptance.spec.ts.
// Importing that spec would register its unrelated acceptance tests as well.
async function launchPackagedEditor(profile: string): Promise<ElectronApplication> {
  if (!installedExecutable && !existsSync(join(unpackedPackage, 'package.json')))
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  for (const name of ['downloads', 'temp', 'appdata', 'localappdata'])
    mkdirSync(join(profile, name));
  return electron.launch({
    executablePath: installedExecutable ?? (desktopRequire('electron') as string),
    cwd: process.env.JOY_MEDIA_TEST_WORKING_DIRECTORY ?? unpackedPackage,
    args: [
      ...(installedExecutable ? [] : ['.']),
      '--joy-media-test-mode',
      `--user-data-dir=${profile}`,
      ...extraAppArguments,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JOY_MEDIA_TEST_API_BASE_URL: apiBaseUrl,
      JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: join(profile, 'downloads'),
      APPDATA: join(profile, 'appdata'),
      LOCALAPPDATA: join(profile, 'localappdata'),
      TEMP: join(profile, 'temp'),
      TMP: join(profile, 'temp'),
    },
  });
}

async function openEditorPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  expect(page.url()).toMatch(/^joy-media-app:\/\/renderer\//u);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__JOY_MEDIA_API_BASE__,
    ),
  ).toBe(apiBaseUrl);
  await authenticate(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  return page;
}

async function seekPackagedPlayhead(page: Page, seconds: number): Promise<void> {
  const playhead = page.getByRole('slider', { name: 'Playhead' });
  await playhead.focus();
  await playhead.press('Home');
  for (let step = 0; step < Math.round(seconds * 10); step++) await playhead.press('ArrowRight');
  await expect(playhead).toHaveAttribute('aria-valuenow', String(Math.round(seconds * 1_000_000)));
}

async function downloadPackagedExport(
  app: ElectronApplication,
  page: Page,
  profile: string,
): Promise<string> {
  const download = page.getByRole('link', { name: /^Download .* again$/u }).first();
  await expect(download).toBeVisible();
  const filename = await download.getAttribute('download');
  expect(filename).toMatch(/\.mp4$/iu);
  const finished = app.evaluate(
    ({ session }, expectedFilename) =>
      new Promise<void>((resolve, reject) => {
        const downloads = session.defaultSession;
        const timer = setTimeout(() => {
          downloads.removeListener('will-download', onDownload);
          reject(new Error(`Timed out waiting for packaged download ${expectedFilename}.`));
        }, 30_000);
        const onDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
          if (item.getFilename() !== expectedFilename) return;
          item.once('done', (_event, state) => {
            clearTimeout(timer);
            downloads.removeListener('will-download', onDownload);
            if (state === 'completed') resolve();
            else reject(new Error(`Packaged download ended in state ${state}.`));
          });
        };
        downloads.on('will-download', onDownload);
      }),
    filename!,
  );
  await download.click();
  await finished;
  const path = join(profile, 'downloads', filename!);
  await expect.poll(() => existsSync(path)).toBe(true);
  return path;
}

function createAcceptancePackage(directory: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(fixtureDirectory, 'manifest.json'), 'utf8')) as {
    files: Record<string, { sha256: string; provenance: unknown; expectedDecoded: unknown }>;
  };
  const sources = [
    'readiness-hard-cut.mkv',
    'readiness-flash-click.mkv',
    'readiness-stereo-tones.wav',
    'readiness-alpha.png',
    'captions-fa.vtt',
  ];
  for (const name of sources)
    expect(sha256(readFileSync(join(fixtureDirectory, name))), `fixture integrity: ${name}`).toBe(
      manifest.files[name]!.sha256,
    );
  // FFV1 is lossless but is not a Chromium playback codec. These disposable
  // derivatives preserve source timing; all provenance lives in the manifest.
  const conversions = [
    {
      source: sources[0]!,
      name: 'hard-cut.mp4',
      args: [
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c:v',
        'libx264',
        '-crf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
      ],
    },
    {
      source: sources[1]!,
      name: 'flash.mp4',
      args: [
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c:v',
        'libx264',
        '-crf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
      ],
    },
    { source: sources[1]!, name: 'click.wav', args: ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le'] },
  ];
  const derivatives = conversions.map(({ source, name, args }) => {
    const command = [
      '-v',
      'error',
      '-y',
      '-i',
      join(fixtureDirectory, source),
      ...args,
      join(directory, name),
    ];
    run('ffmpeg', command);
    return {
      name,
      sha256: sha256(readFileSync(join(directory, name))),
      source,
      sourceSha256: manifest.files[source]!.sha256,
      command,
      provenance: manifest.files[source]!.provenance,
    };
  });
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        generatedBy: 'tests/desktop/export-semantics.spec.ts',
        fixtureGenerator: 'tooling/generate-media-fixtures.mjs',
        sourceManifest: 'packages/test-fixtures/media/manifest.json',
        sources: Object.fromEntries(sources.map((name) => [name, manifest.files[name]])),
        derivatives,
        toolchain: {
          ffmpeg: run('ffmpeg', ['-version']).toString().split(/\r?\n/u)[0],
          ffprobe: run('ffprobe', ['-version']).toString().split(/\r?\n/u)[0],
        },
      },
      null,
      2,
    ),
  );
  const definitions = [
    {
      id: 'cut-asset',
      path: join(directory, 'hard-cut.mp4'),
      kind: 'video',
      mimeType: 'video/mp4',
      durationUs: 2_000_000,
      width,
      height,
    },
    {
      id: 'marker-asset',
      path: join(directory, 'flash.mp4'),
      kind: 'video',
      mimeType: 'video/mp4',
      durationUs: 2_000_000,
      width,
      height,
    },
    {
      id: 'click-asset',
      path: join(directory, 'click.wav'),
      kind: 'audio',
      mimeType: 'audio/wav',
      durationUs: 2_000_000,
    },
    {
      id: 'tones-asset',
      path: join(fixtureDirectory, 'readiness-stereo-tones.wav'),
      kind: 'audio',
      mimeType: 'audio/wav',
      durationUs: 2_000_000,
    },
    {
      id: 'alpha-asset',
      path: join(fixtureDirectory, 'readiness-alpha.png'),
      kind: 'image',
      mimeType: 'image/png',
      width: 64,
      height: 64,
    },
  ] as const;
  const media = definitions.map(({ id, path, kind, ...descriptor }) => {
    const bytes = readFileSync(path);
    const asset: AssetRecordV1 = {
      id,
      kind,
      displayName: id,
      sha256: sha256(bytes),
      bytes: bytes.length,
      descriptor,
    };
    return { asset, status: 'embedded', dataBase64: bytes.toString('base64') };
  });
  const clips: VideoClip[] = [
    {
      kind: 'video',
      id: 'hard-red',
      assetId: 'cut-asset',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    },
    {
      kind: 'video',
      id: 'hard-blue',
      assetId: 'cut-asset',
      startUs: 1_000_000,
      durationUs: 1_000_000,
      sourceInUs: 1_000_000,
    },
    {
      kind: 'video',
      id: 'flash-marker',
      assetId: 'marker-asset',
      startUs: 2_000_000,
      durationUs: 2_000_000,
      sourceInUs: 0,
    },
    {
      kind: 'video',
      id: 'dissolve-red',
      assetId: 'cut-asset',
      startUs: 4_000_000,
      durationUs: 1_000_000,
      sourceInUs: 200_000,
      playbackRate: 0,
    },
    {
      kind: 'video',
      id: 'dissolve-blue',
      assetId: 'cut-asset',
      startUs: 5_000_000,
      durationUs: 1_000_000,
      sourceInUs: 1_200_000,
      playbackRate: 0,
    },
  ];
  const audioClips: VideoClip[] = [
    {
      kind: 'video',
      id: 'audio-tones',
      assetId: 'tones-asset',
      startUs: 0,
      durationUs: 2_000_000,
      sourceInUs: 0,
    },
    {
      kind: 'video',
      id: 'audio-click',
      assetId: 'click-asset',
      startUs: 2_000_000,
      durationUs: 2_000_000,
      sourceInUs: 0,
    },
  ];
  const timeline: SpikeProject = {
    schemaVersion: 0,
    id: 'desktop-export-semantics',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Export semantics',
        width,
        height,
        frameRate: { num: fps, den: 1 },
        durationUs: 6_000_000,
        tracks: [
          {
            id: 'picture',
            kind: 'video',
            family: 'visual',
            name: 'Picture',
            order: 1,
            enabled: true,
            clips,
          },
          {
            id: 'sound',
            kind: 'video',
            family: 'audio',
            name: 'Sound',
            order: 0,
            enabled: true,
            clips: audioClips,
          },
        ],
      },
    },
  };
  const now = '2026-10-21T00:00:00.000Z';
  const visual: JoyProjectV1 = {
    schemaVersion: 1,
    id: timeline.id,
    title: 'Desktop export semantics',
    createdAt: now,
    updatedAt: now,
    rootCompositionId: 'root',
    settings: { defaultLocale: 'fa' },
    compositions: {
      root: {
        ...timeline.compositions.root!,
        pixelAspectRatio: { num: 1, den: 1 },
        background: '#000000',
        tracks: [
          {
            id: 'picture',
            kind: 'video',
            name: 'Picture',
            order: 1,
            enabled: true,
            locked: false,
            clips,
          },
          {
            id: 'sound',
            kind: 'audio',
            name: 'Sound',
            order: 0,
            enabled: true,
            locked: false,
            clips: audioClips,
          },
          {
            id: 'captions',
            kind: 'caption',
            name: 'Persian',
            order: 3,
            enabled: true,
            locked: false,
            clips: [
              {
                kind: 'caption',
                id: 'persian-caption',
                captionDocumentId: 'fa',
                startUs: 5_200_000,
                durationUs: 700_000,
                style: {
                  version: 2,
                  positionX: 0,
                  positionY: 0,
                  scale: 1,
                  opacity: 1,
                  fontSize: 2.5,
                  tracking: 0,
                  lineHeight: 1,
                  textColor: '#ffffff',
                  plateColor: '#000000',
                  plateOpacity: 0,
                  highlightColor: '#ffffff',
                  align: 'center',
                },
              },
            ],
          },
        ],
      },
    },
    assets: Object.fromEntries(media.map((entry) => [entry.asset.id, entry.asset])),
    variables: {},
    markers: [],
    pluginData: {
      'joy.captions.burnIn': true,
      'joy.timelineElementKinds': { 'audio-tones': 'audio', 'audio-click': 'audio' },
    },
    visualObjects: {
      alpha: {
        id: 'alpha',
        kind: 'image',
        assetId: 'alpha-asset',
        transform: {
          // Composition centre (160,90) is safely inside the fixture's opaque
          // left half. At 50% object opacity over blue it must be purple.
          x: 144,
          y: 58,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 0.5,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
    captionDocuments: {
      fa: {
        id: 'fa',
        language: 'fa-IR',
        direction: 'rtl',
        speakers: [],
        words: { sentence: { id: 'sentence', text: captionText, startUs: 0, endUs: 700_000 } },
        segments: [{ id: 'sentence', startUs: 0, endUs: 700_000, wordIds: ['sentence'] }],
        styleRef: 'joy-clean',
      },
    },
    transitions: [
      {
        id: 'red-blue-dissolve',
        trackId: 'picture',
        leftClipId: 'dissolve-red',
        rightClipId: 'dissolve-blue',
        type: 'dissolve',
        durationUs: 1_000_000,
      },
    ],
    audio: {
      clips: Object.fromEntries(
        [...clips, ...audioClips].map((clip) => [
          clip.id,
          { gain: 1, pan: 0, mute: clips.includes(clip), solo: false },
        ]),
      ),
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    },
  };
  return {
    format: 'joy-media-project',
    schemaVersion: 1,
    app: 'JOY Studio',
    exportedAt: now,
    source: { id: timeline.id, title: visual.title, createdAt: now, updatedAt: now },
    documents: { timeline, visual },
    media,
  };
}

function rgbFrame(png: Buffer): Buffer {
  return run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-vf',
      `scale=${width}:${height},format=rgb24`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    png,
  );
}

function pixel(frame: Buffer, x = 64, y = 40): Rgb {
  const offset = (y * width + x) * 3;
  return [frame[offset]!, frame[offset + 1]!, frame[offset + 2]!];
}

function isColor(rgb: Rgb, color: keyof typeof tolerance.solidColors): boolean {
  const bounds = tolerance.solidColors[color] as Record<string, number>;
  return ['red', 'green', 'blue'].every(
    (channel, index) =>
      rgb[index]! >= (bounds[`${channel}Min`] ?? 0) &&
      rgb[index]! <= (bounds[`${channel}Max`] ?? 255),
  );
}

function normalizedDifference(left: Buffer, right: Buffer): number {
  expect(left.length).toBe(width * height * 3);
  expect(right.length).toBe(left.length);
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += Math.abs(left[index]! - right[index]!);
  return sum / (left.length * 255);
}

function audioWindow(pcm: Buffer, channel: number, start: number, seconds: number): number[] {
  const first = Math.round(start * sampleRate);
  const count = Math.round(seconds * sampleRate);
  expect(pcm.length).toBeGreaterThanOrEqual((first + count) * 2 * 4);
  return Array.from({ length: count }, (_, index) =>
    pcm.readFloatLE(((first + index) * 2 + channel) * 4),
  );
}

const rms = (samples: readonly number[]): number =>
  Math.sqrt(samples.reduce((sum, value) => sum + value ** 2, 0) / samples.length);

function frequency(samples: readonly number[]): number {
  let crossings = 0;
  for (let index = 1; index < samples.length; index++)
    if (samples[index - 1]! <= 0 && samples[index]! > 0) crossings++;
  return (crossings * sampleRate) / samples.length;
}

async function captionReference(page: Page): Promise<FontResult> {
  return page.evaluate(
    async ({ text, family, size }) => {
      try {
        // FontFace local() rejects absent fonts; document.fonts.check alone can
        // incorrectly succeed via fallback when the named family is missing.
        await new FontFace('JOY caption availability probe', `local("${family}")`).load();
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 80;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#000';
        context.fillRect(0, 0, 320, 80);
        context.font = `${size}px "${family}"`;
        context.direction = 'rtl';
        context.textAlign = 'center';
        context.fillStyle = '#fff';
        context.fillText(text, 160, 45);
        const referencePng = canvas.toDataURL('image/png').split(',')[1];
        context.fillStyle = '#000';
        context.fillRect(0, 0, 320, 80);
        context.fillStyle = '#fff';
        context.fillText(text.split(/\s+/u).reverse().join(' '), 160, 45);
        return {
          available: true,
          referencePng,
          wrongOrderReferencePng: canvas.toDataURL('image/png').split(',')[1],
        };
      } catch (error) {
        return {
          available: false,
          reason: `Caption font "${family}" is unavailable: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        };
      }
    },
    { text: captionText, family: captionFont, size: captionFontSize },
  );
}

function inkMask(
  rgb: Buffer,
  imageWidth: number,
  imageHeight: number,
  minimumY = 0,
): { width: number; height: number; pixels: number[] } {
  const points: [number, number][] = [];
  for (let y = minimumY; y < imageHeight; y++)
    for (let x = 0; x < imageWidth; x++) {
      const offset = (y * imageWidth + x) * 3;
      // Average luminance, not a per-channel cut: the per-channel cut moved by
      // 2-3 px in glyph height when the BT.709 export conversion changed chroma
      // on anti-aliased edges. Luminance agrees with the reference within 1 px.
      const luminance = (rgb[offset]! + rgb[offset + 1]! + rgb[offset + 2]!) / 3;
      if (luminance > 170) points.push([x, y]);
    }
  expect(points.length, 'caption must contain visible shaped glyphs').toBeGreaterThan(50);
  const minX = Math.min(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const w = Math.max(...points.map((point) => point[0])) - minX + 1;
  const h = Math.max(...points.map((point) => point[1])) - minY + 1;
  const pixels = Array<number>(w * h).fill(0);
  for (const [x, y] of points) pixels[(y - minY) * w + x - minX] = 1;
  return { width: w, height: h, pixels };
}

function glyphMismatch(
  actual: ReturnType<typeof inkMask>,
  expected: ReturnType<typeof inkMask>,
): number {
  // Canvas2D and the encoded Pixi texture have different subpixel coverage.
  // Permit a one-pixel neighbourhood for each ink pixel, in both directions;
  // glyph bounds and the reversed-word negative control still constrain shape.
  const unmatched = (from: typeof actual, to: typeof actual, dx: number, dy: number): number => {
    let count = 0;
    for (let y = 0; y < from.height; y++)
      for (let x = 0; x < from.width; x++) {
        if (!from.pixels[y * from.width + x]) continue;
        let matches = false;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const tx = x + dx + ox;
            const ty = y + dy + oy;
            if (
              tx >= 0 &&
              ty >= 0 &&
              tx < to.width &&
              ty < to.height &&
              to.pixels[ty * to.width + tx]
            )
              matches = true;
          }
        if (!matches) count++;
      }
    return count;
  };
  const totalInk = [...actual.pixels, ...expected.pixels].reduce((sum, value) => sum + value, 0);
  let best = 1;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      best = Math.min(
        best,
        (unmatched(actual, expected, dx, dy) + unmatched(expected, actual, -dx, -dy)) /
          Math.max(1, totalInk),
      );
  return best;
}

test.describe('desktop.export-media-semantics', () => {
  let evidence: string;
  let probe: Probe;
  let pts: number[];
  let video: Buffer;
  let pcm: Buffer;
  let font: FontResult;
  const previews = new Map<number, Buffer>();
  const results: Record<string, unknown> = {};
  const frameAt = (seconds: number): Buffer => {
    const index = pts.findIndex((time) => Math.abs(time - seconds) < 0.00001);
    expect(index, `decoded output must have a frame at ${seconds}s`).toBeGreaterThanOrEqual(0);
    return video.subarray(index * width * height * 3, (index + 1) * width * height * 3);
  };

  test.beforeAll(async ({ playwright: _playwright }, info) => {
    info.setTimeout(360_000);
    evidence = info.outputPath('evidence');
    mkdirSync(evidence, { recursive: true });
    const profilePrefix = join(tmpdir(), 'joy-media-export-semantics-');
    const profile = mkdtempSync(profilePrefix);
    if (!resolve(profile).startsWith(resolve(profilePrefix)))
      throw new Error('Refusing to use an unexpected test profile path');
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let sourceCapture = Promise.resolve();
    try {
      const pkg = createAcceptancePackage(evidence);
      writeFileSync(join(evidence, 'timeline.joyproject.json'), JSON.stringify(pkg));
      app = await launchPackagedEditor(profile);
      page = await openEditorPage(app);
      page.on('response', (response) => {
        const request = response.request();
        if (
          request.method() === 'POST' &&
          /\/assets\/export-source-[^/]+\/original$/u.test(request.url())
        ) {
          // Chromium omits Blob upload bodies from CDP postData. Read back the
          // real staged object while the Worker is processing it instead.
          sourceCapture = (async () => {
            const original = await page!.request.get(request.url(), {
              headers: { authorization: `Bearer ${E2E_TOKEN}` },
            });
            if (!original.ok())
              throw new Error(`Staged source readback: HTTP ${original.status()}`);
            writeFileSync(join(evidence, 'browser-source.mp4'), await original.body());
          })().catch((error) => {
            writeFileSync(join(evidence, 'source-capture-error.txt'), String(error));
          });
        }
      });
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByPlaceholder('Project name').fill('Semantics import host');
      await page.getByRole('button', { name: 'Create project' }).click();
      await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
      await page
        .locator('input[type="file"][accept*=".joyproject.json"]')
        .setInputFiles(join(evidence, 'timeline.joyproject.json'));
      await expect(page.locator('.timeline-clip[data-clip-id="hard-red"]')).toBeVisible();
      await expect(page.locator('.timeline-clip[data-clip-id="hard-blue"]')).toBeVisible();
      await expect(page.locator('.timeline-transition-junction')).toHaveCount(1);
      await page.getByLabel('Monitor preview renderer').selectOption('local');
      await expect(page.locator('.monitor-preview-status')).toHaveText('Local');
      font = await captionReference(page);
      if (!font.available && process.env.JOY_MEDIA_REQUIRE_CAPTION_FONT === '1')
        throw new Error(
          `Persian caption acceptance requires its font on this runner: ${font.reason}`,
        );
      writeFileSync(
        join(evidence, 'caption-font.json'),
        JSON.stringify(
          { ...font, referencePng: undefined, wrongOrderReferencePng: undefined },
          null,
          2,
        ),
      );
      if (font.referencePng)
        writeFileSync(
          join(evidence, 'caption-reference.png'),
          Buffer.from(font.referencePng, 'base64'),
        );
      if (font.wrongOrderReferencePng)
        writeFileSync(
          join(evidence, 'caption-wrong-order.png'),
          Buffer.from(font.wrongOrderReferencePng, 'base64'),
        );
      const canvas = page.locator('.monitor-canvas canvas').first();
      for (const seconds of sampleTimes) {
        await seekPackagedPlayhead(page, seconds);
        // Regression: the first dissolve used to pass Pixi's null child lookup
        // to updateTransitionLayer and unmount the entire packaged editor.
        await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
        // Wait for decoding and paint to settle, independently of the export
        // or expected colours. Never select a preview because it matches output.
        let previous = '';
        let stable = 0;
        let png: Buffer = Buffer.alloc(0);
        await expect
          .poll(
            async () => {
              png = await canvas.screenshot({ animations: 'disabled' });
              const hash = sha256(png);
              stable = hash === previous ? stable + 1 : 0;
              previous = hash;
              return stable;
            },
            { timeout: 15_000, intervals: [250] },
          )
          .toBeGreaterThanOrEqual(3);
        previews.set(seconds, rgbFrame(png));
        writeFileSync(join(evidence, `preview-${seconds.toFixed(1)}.png`), png);
      }
      // Social H.264 keeps the authored 320x180 canvas. The default Reels
      // preset deliberately changes it to portrait and is a different contract.
      const preset = page.getByRole('button', { name: 'Export preset' });
      await preset.click();
      await page
        .getByRole('region', { name: 'Export preset' })
        .getByRole('button', { name: 'Social H.264', exact: true })
        .click();
      await expect(preset).toContainText('Social H.264');
      await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
      const processes = page.getByRole('button', { name: 'Recent processes' });
      if ((await processes.getAttribute('aria-expanded')) !== 'true') await processes.click();
      const history = page.getByRole('region', { name: 'Recent processes' });
      await expect
        .poll(
          async () =>
            /Completed — final MP4 verified|Failed —|Cancelled/u.test(await history.innerText()),
          { timeout: 240_000 },
        )
        .toBe(true);
      const exportStatus = await history.innerText();
      writeFileSync(join(evidence, 'export-status.txt'), exportStatus);
      expect(exportStatus).toContain('Completed — final MP4 verified');
      const exported = await downloadPackagedExport(app, page, profile);
      await sourceCapture;
      const path = join(evidence, 'export.mp4');
      copyFileSync(exported, path);
      probe = JSON.parse(
        run('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          path,
        ]).toString(),
      ) as Probe;
      writeFileSync(join(evidence, 'ffprobe.json'), JSON.stringify(probe, null, 2));
      expect(
        probe.streams.find((stream) => stream.codec_type === 'video'),
        'decode only the expected authored canvas',
      ).toMatchObject({ width, height });
      const frames = JSON.parse(
        run('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_frames',
          '-show_entries',
          'frame=best_effort_timestamp_time',
          '-of',
          'json',
          path,
        ]).toString(),
      ) as { frames: { best_effort_timestamp_time: string }[] };
      pts = frames.frames.map((frame) => Number(frame.best_effort_timestamp_time));
      writeFileSync(join(evidence, 'presentation-times.json'), JSON.stringify(pts));
      video = run('ffmpeg', [
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:v:0',
        '-fps_mode',
        'passthrough',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
      pcm = run('ffmpeg', [
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-ar',
        String(sampleRate),
        '-ac',
        '2',
        '-c:a',
        'pcm_f32le',
        '-f',
        'f32le',
        'pipe:1',
      ]);
      writeFileSync(join(evidence, 'decoded-stereo.f32le'), pcm);
      for (const seconds of sampleTimes)
        run(
          'ffmpeg',
          [
            '-v',
            'error',
            '-y',
            '-f',
            'rawvideo',
            '-pixel_format',
            'rgb24',
            '-video_size',
            `${width}x${height}`,
            '-i',
            'pipe:0',
            '-frames:v',
            '1',
            join(evidence, `export-${seconds.toFixed(1)}.png`),
          ],
          frameAt(seconds),
        );
    } catch (error) {
      if (page)
        await page.screenshot({ path: join(evidence, 'setup-failure.png') }).catch(() => undefined);
      writeFileSync(join(evidence, 'setup-failure.txt'), String(error));
      throw error;
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test.afterEach(async ({ playwright: _playwright }, info) => {
    results[info.title] = {
      status: info.status,
      annotations: info.annotations,
      errors: info.errors.map((error) => error.message),
    };
    writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
    await info.attach('export-semantics-evidence', {
      path: join(evidence, 'results.json'),
      contentType: 'application/json',
    });
  });

  test('exports expected picture, sound, timing and dissolve, with Monitor parity', async () => {
    const measurements: Record<string, unknown> = {};
    try {
      await test.step('duration, frame rate and exact decoded frame count', async () => {
        const stream = probe.streams.find((stream) => stream.codec_type === 'video')!;
        measurements.video = stream;
        measurements.duration = Number(probe.format.duration);
        expect.soft(stream).toMatchObject({
          codec_name: 'h264',
          width,
          height,
          avg_frame_rate: '30/1',
          r_frame_rate: '30/1',
          nb_read_frames: '180',
        });
        expect
          .soft(Math.abs(Number(probe.format.duration) - durationSeconds))
          .toBeLessThanOrEqual(tolerance.durationFrames / fps);
        expect
          .soft(Math.abs(Number(stream.duration) - durationSeconds))
          .toBeLessThanOrEqual(tolerance.durationFrames / fps);
        expect.soft(pts).toHaveLength(180);
        expect.soft(video.length).toBe(180 * width * height * 3);
        for (const [index, time] of pts.entries())
          expect.soft(Math.abs(time - index / fps), `PTS ${index}`).toBeLessThanOrEqual(0.000001);
      });
      await test.step('red-to-blue hard cut at one second', async () => {
        const samples = [0.5, 29 / fps, 1, 1.5].map((time) => ({
          time,
          rgb: pixel(frameAt(time)),
        }));
        measurements.hardCut = samples;
        for (const [index, { rgb }] of samples.entries())
          expect
            .soft(isColor(rgb, index < 2 ? 'red' : 'blue'), JSON.stringify(samples[index]))
            .toBe(true);
      });
      await test.step('flash and click onsets within one output frame of three seconds', async () => {
        const flashes = pts.flatMap((time, index) =>
          time >= 2 &&
          time < 4 &&
          isColor(
            pixel(video.subarray(index * width * height * 3, (index + 1) * width * height * 3)),
            'white',
          )
            ? [time]
            : [],
        );
        let clickOnset = Number.NaN;
        let quietBeforeClick = false;
        for (let time = 2; time < 4; time += 0.005) {
          const level = rms(audioWindow(pcm, 0, time, 0.005));
          // The preceding tone ends at 2s; AAC can ring across that boundary.
          // Arm after silence so its tail cannot masquerade as the marker.
          if (level < tolerance.normalizedPcmRmsAbsolute) quietBeforeClick = true;
          if (quietBeforeClick && level > 0.2) {
            clickOnset = time;
            break;
          }
        }
        measurements.sync = { flashes, clickOnset, quietRms: rms(audioWindow(pcm, 0, 2.8, 0.02)) };
        expect.soft(flashes.length).toBeGreaterThan(0);
        expect.soft(flashes.length).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(flashes[0]! - 3)).toBeLessThanOrEqual(tolerance.syncFrames / fps);
        expect.soft(Math.abs(clickOnset - 3)).toBeLessThanOrEqual(tolerance.syncFrames / fps);
        expect
          .soft(Math.abs(clickOnset - flashes[0]!))
          .toBeLessThanOrEqual(tolerance.syncFrames / fps);
        expect
          .soft(rms(audioWindow(pcm, 0, 2.8, 0.02)))
          .toBeLessThan(tolerance.normalizedPcmRmsAbsolute);
        for (const time of [2.9, 3.1])
          expect.soft(isColor(pixel(frameAt(time)), 'dark'), `${time}s`).toBe(true);
      });
      await test.step('stereo RMS and distinct left/right frequencies', async () => {
        expect
          .soft(probe.streams.find((stream) => stream.codec_type === 'audio'))
          .toMatchObject({ codec_name: 'aac', channels: 2, sample_rate: '48000' });
        const channels = [0, 1].map((channel) => {
          const samples = audioWindow(pcm, channel, 0.25, 0.5);
          return { rms: rms(samples), frequency: frequency(samples) };
        });
        measurements.stereo = channels;
        for (const [index, channel] of channels.entries()) {
          expect
            .soft(Math.abs(channel.rms - Math.SQRT1_2 * 0.5), `channel ${index} RMS`)
            .toBeLessThanOrEqual(tolerance.normalizedPcmRmsAbsolute);
          expect
            .soft(Math.abs(channel.frequency - [440, 880][index]!), `channel ${index} frequency`)
            .toBeLessThanOrEqual(tolerance.toneFrequencyHz);
        }
      });
      await test.step('alpha composite at the known composition centre and transparent half', async () => {
        const centre = pixel(frameAt(1.5), 160, 90);
        const transparent = pixel(frameAt(1.5), 192, 90);
        measurements.alpha = { centre, transparent, expectedCentre: [127, 0, 127] };
        for (const [channel, expected] of [127, 0, 127].entries())
          expect.soft(Math.abs(centre[channel]! - expected)).toBeLessThanOrEqual(colorTolerance);
        expect.soft(isColor(transparent, 'blue')).toBe(true);
      });
      await test.step('dissolve endpoints and midpoint colour mix', async () => {
        const midpoint = pixel(frameAt(4.5));
        measurements.dissolve = { midpoint, expected: [127, 0, 127] };
        expect.soft(isColor(pixel(frameAt(4)), 'red')).toBe(true);
        expect.soft(isColor(pixel(frameAt(5.1)), 'blue')).toBe(true);
        for (const [channel, expected] of [127, 0, 127].entries())
          expect.soft(Math.abs(midpoint[channel]! - expected)).toBeLessThanOrEqual(colorTolerance);
      });
      await test.step('sampled editor Monitor frames agree with decoded final MP4 frames', async () => {
        const differences = sampleTimes
          .filter((time) => font.available || time !== 5.5)
          .map((time) => ({
            time,
            normalizedRgbMae: normalizedDifference(previews.get(time)!, frameAt(time)),
          }));
        measurements.previewExport = { tolerance: previewExportTolerance, samples: differences };
        for (const sample of differences)
          expect
            .soft(sample.normalizedRgbMae, `Monitor/export parity at ${sample.time}s`)
            .toBeLessThan(previewExportTolerance);
      });
    } finally {
      writeFileSync(join(evidence, 'measurements.json'), JSON.stringify(measurements, null, 2));
      await test.info().attach('export-semantics-measurements', {
        path: join(evidence, 'measurements.json'),
        contentType: 'application/json',
      });
    }
  });

  test('burns in the expected shaped Persian caption when its font is available', async () => {
    if (!font.available) {
      if (process.env.JOY_MEDIA_REQUIRE_CAPTION_FONT === '1')
        throw new Error(
          `Persian caption acceptance requires its font on this runner: ${font.reason}`,
        );
      test.info().annotations.push({ type: 'SETUP_REQUIRED', description: font.reason! });
      test.skip(true, `SETUP_REQUIRED: ${font.reason}`);
    }
    // Independent Canvas2D reference, never the editor's caption layout/render
    // helper. Tight glyph bounds ignore baseline differences between rasterizers.
    const reference = run('ffmpeg', [
      '-v',
      'error',
      '-i',
      join(evidence, 'caption-reference.png'),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    const expected = inkMask(reference, width, 80);
    const actual = inkMask(frameAt(5.5), width, height, 120);
    expect(Math.abs(actual.width - expected.width), 'Persian glyph width').toBeLessThanOrEqual(2);
    expect(Math.abs(actual.height - expected.height), 'Persian glyph height').toBeLessThanOrEqual(
      2,
    );
    const best = glyphMismatch(actual, expected);
    const wrongOrder = inkMask(
      run('ffmpeg', [
        '-v',
        'error',
        '-i',
        join(evidence, 'caption-wrong-order.png'),
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]),
      width,
      80,
    );
    const wrongOrderMismatch = glyphMismatch(actual, wrongOrder);
    writeFileSync(
      join(evidence, 'caption-measurements.json'),
      JSON.stringify(
        {
          text: captionText,
          font: captionFont,
          expected: { width: expected.width, height: expected.height },
          actual: { width: actual.width, height: actual.height },
          glyphMismatch: best,
          wrongOrderMismatch,
          tolerance: previewExportTolerance,
        },
        null,
        2,
      ),
    );
    expect(
      best,
      'export must match the shaped Persian glyphs, including their RTL order',
    ).toBeLessThan(previewExportTolerance);
    expect(
      wrongOrderMismatch,
      'glyph oracle must reject reversed Persian word order',
    ).toBeGreaterThan(previewExportTolerance);
    expect(
      normalizedDifference(previews.get(5.5)!, frameAt(5.5)),
      'caption preview/export parity',
    ).toBeLessThan(previewExportTolerance);
  });
});
