import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import {
  authenticate,
  importMediaFixture,
  openPanel,
  openReferenceWorkspace,
} from './wp29-r5-harness.js';

type ExportPreset = {
  readonly id: 'reels-1080' | 'youtube-1080';
  readonly label: string;
  readonly width: number;
  readonly height: number;
};

type LookPack = { readonly id: string; readonly title: string };

const PRESETS: readonly ExportPreset[] = [
  { id: 'reels-1080', label: 'Reels 1080×1920', width: 1080, height: 1920 },
  { id: 'youtube-1080', label: 'YouTube 1920×1080', width: 1920, height: 1080 },
];
const LOOK_PACKS: readonly LookPack[] = [
  { id: 'editorial-clean', title: 'Editorial Clean' },
  { id: 'product-precision', title: 'Product Precision' },
  { id: 'kinetic-type', title: 'Kinetic Type' },
  { id: 'quiet-documentary', title: 'Quiet Documentary' },
  { id: 'music-pulse', title: 'Music Pulse' },
];
// The browser stage is followed by real Worker verification/remux. The
// self-hosted real-service harness gives that bounded path a 35-minute window;
// keep the matrix aligned so a valid export is not reported as a browser
// download timeout while the Worker is still finishing.
const EXPORT_TIMEOUT_MS = 35 * 60_000;

const ACTIVE_PROJECT_KEY = 'joy-media.active-project.v1';

async function returnToProjectSelector(page: Page): Promise<void> {
  // The reference project is intentionally persisted. Clear only the active
  // selection before the next cold navigation so each matrix case exercises
  // the real selector/reopen path without inheriting the previous editor.
  // Playwright starts a fresh test page at about:blank; establish the app
  // origin before reading or writing localStorage so the reset itself cannot
  // fail with a document-security error.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, projectId: null }));
  }, ACTIVE_PROJECT_KEY);
  // The first navigation may already have mounted the editor using the
  // previously persisted id. Reload so App's initial state reads the cleared
  // selection and renders the Projects library before the next case.
  await page.reload({ waitUntil: 'domcontentloaded' });
}

function probeExport(path: string): {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frames: number;
  readonly audioCodec?: string;
  readonly audioSampleRate?: number;
  readonly audioDuration?: number;
  readonly avDriftSeconds?: number;
  readonly ptsMonotonic: boolean;
} {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name,width,height,nb_read_frames,sample_rate,duration',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as {
    readonly format?: { readonly format_name?: string; readonly duration?: string };
    readonly streams?: readonly {
      readonly codec_type?: string;
      readonly codec_name?: string;
      readonly width?: number;
      readonly height?: number;
      readonly nb_read_frames?: string;
      readonly sample_rate?: string;
      readonly duration?: string;
    }[];
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const pts = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  ) as { readonly frames?: readonly { readonly best_effort_timestamp_time?: string }[] };
  const timestamps = (pts.frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((value) => Number.isFinite(value));
  return {
    format: parsed.format?.format_name ?? '',
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number(parsed.format?.duration ?? 0),
    frames: Number(video?.nb_read_frames ?? timestamps.length),
    ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
    ...(audio?.sample_rate === undefined ? {} : { audioSampleRate: Number(audio.sample_rate) }),
    ...(audio?.duration === undefined
      ? {}
      : {
          audioDuration: Number(audio.duration),
          avDriftSeconds: Math.abs(Number(audio.duration) - Number(parsed.format?.duration ?? 0)),
        }),
    ptsMonotonic: timestamps.every(
      (value, index) => index === 0 || value >= timestamps[index - 1]!,
    ),
  };
}

async function downloadBytes(
  download: Download,
): Promise<{ readonly bytes: number; readonly path: string }> {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error('download stream unavailable');
  let bytes = 0;
  for await (const chunk of stream) bytes += Buffer.byteLength(chunk);
  const path = await download.path();
  if (path === null) throw new Error('download path unavailable');
  return { bytes, path };
}

async function choosePreset(page: Page, preset: ExportPreset): Promise<void> {
  await page.getByRole('button', { name: 'Export preset', exact: true }).click();
  await page.getByRole('button', { name: preset.label, exact: true }).click();
}

async function applyLook(page: Page, pack: LookPack): Promise<void> {
  await openPanel(page, 'Joy Code');
  await page.getByRole('button', { name: 'Looks', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Living Looks' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(pack.title, { exact: true })).toBeVisible();
  const selectButton = panel.locator('.living-look-select').filter({ hasText: pack.title });
  await selectButton.click();
  const editor = panel.getByRole('form', { name: new RegExp(`${pack.title} controls`) });
  await expect(editor).toBeVisible();
  for (const slot of await editor.locator('.living-look-slot').all()) {
    const label = await slot.innerText();
    if (!label.includes('*')) continue;
    const select = slot.locator('select');
    if ((await select.locator('option').count()) < 2) {
      throw new Error(`${pack.id}: no bindable entity for ${await slot.innerText()}`);
    }
    await select.selectOption({ index: 1 });
  }
  const run = editor.getByRole('button', { name: `Run ${pack.title}` });
  await expect(run).toBeEnabled();
  await run.click();
  const preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
  await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 30_000 });
  await preview.getByRole('button', { name: /Approve & apply/ }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({
    timeout: 20_000,
  });
  await expect(
    page.getByRole('region', { name: 'Applied Looks' }).getByText(pack.title, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

test.describe('JOY R2 P3 shipping browser export matrix', () => {
  test('exports every shipping Look pack in portrait and landscape after reopen', async ({
    page,
  }, testInfo) => {
    test.setTimeout(3_600_000);
    if (process.env.JOY_P3_REAL_EXPORTS !== '1') {
      testInfo.annotations.push({
        type: 'NOT RUN',
        description:
          'Set JOY_P3_REAL_EXPORTS=1 on a self-hosted runner with real export assets to execute the ten-case matrix.',
      });
      return;
    }
    await authenticate(page);
    const matrix: Array<Record<string, unknown>> = [];
    const failures: string[] = [];

    for (const pack of LOOK_PACKS) {
      for (const preset of PRESETS) {
        const caseId = `${pack.id}/${preset.id}`;
        const evidence: Record<string, unknown> = { caseId, pack: pack.id, preset: preset.id };
        try {
          await returnToProjectSelector(page);
          await openReferenceWorkspace(page);
          const videoName = `p3-${pack.id}-${preset.id}.mp4`;
          await importMediaFixture(page, 'video.mp4', videoName);
          await page
            .locator('.asset-card', { hasText: videoName })
            .first()
            .getByRole('button', { name: `Add ${videoName} to timeline` })
            .click();
          if (pack.id === 'music-pulse') {
            const audioName = `p3-${pack.id}-${preset.id}.wav`;
            await importMediaFixture(page, 'audio.wav', audioName);
            await page
              .locator('.asset-card', { hasText: audioName })
              .first()
              .getByRole('button', { name: `Add ${audioName} to timeline` })
              .click();
          }
          await applyLook(page, pack);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await openPanel(page, 'Joy Code');
          await page.getByRole('button', { name: 'Looks', exact: true }).click();
          await expect(
            page
              .getByRole('region', { name: 'Applied Looks' })
              .getByText(pack.title, { exact: true }),
          ).toBeVisible();
          await choosePreset(page, preset);

          const downloadPromise = page.waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS });
          await page.getByRole('button', { name: 'Export MP4' }).click();
          const download = await downloadPromise;
          const downloaded = await downloadBytes(download);
          expect(downloaded.bytes).toBeGreaterThan(0);
          const probe = probeExport(downloaded.path);
          expect(probe.format.split(',')).toContain('mp4');
          expect(probe.width).toBe(preset.width);
          expect(probe.height).toBe(preset.height);
          expect(probe.duration).toBeGreaterThan(0);
          expect(probe.frames).toBeGreaterThan(0);
          expect(probe.ptsMonotonic).toBe(true);
          if (probe.avDriftSeconds !== undefined)
            expect(probe.avDriftSeconds).toBeLessThanOrEqual(0.05);
          if (pack.id === 'music-pulse') {
            expect(probe.audioCodec).toBe('aac');
            expect(probe.audioSampleRate).toBe(48_000);
            expect(probe.avDriftSeconds).toBeDefined();
          }
          await expect(page.getByRole('button', { name: 'Cancel export' })).toHaveCount(0);
          evidence.result = 'PASS';
          evidence.bytes = downloaded.bytes;
          evidence.ffprobe = probe;
        } catch (error) {
          evidence.result = 'FAIL';
          evidence.error = error instanceof Error ? error.message : String(error);
          failures.push(`${caseId}: ${String(evidence.error)}`);
        } finally {
          matrix.push(evidence);
          await testInfo.attach(`${caseId.replaceAll('/', '-')}.json`, {
            body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
            contentType: 'application/json',
          });
        }
      }
    }
    const matrixPath = 'test-output/browser/p3-export-matrix.json';
    await mkdir('test-output/browser', { recursive: true });
    await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
    await testInfo.attach('p3-export-matrix.json', {
      body: Buffer.from(`${JSON.stringify(matrix, null, 2)}\n`),
      contentType: 'application/json',
    });
    expect(failures, `P3 export failures:\n${failures.join('\n')}`).toEqual([]);
  });
});
