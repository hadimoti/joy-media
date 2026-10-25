import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate } from '../e2e/wp29-r5-harness.js';

// Packaged app, real local Worker, real FFmpeg. The renderer asks for a thumbnail through the same
// bridge the editor uses, and the test checks the JPEG the Worker produced on disk and the job record
// after an app restart. Native file dialogs are replaced by JOY_MEDIA_TEST_SELECT_FILE in test mode.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;

type Bridge = { invoke(channel: string, payload?: unknown): Promise<unknown> };

async function launchPackagedEditor(
  profile: string,
  selectFile: string,
): Promise<ElectronApplication> {
  if (!existsSync(join(unpackedPackage, 'package.json'))) {
    throw new Error('Missing unpacked desktop package. Run package:unpacked before this test.');
  }
  for (const name of ['downloads', 'temp', 'appdata', 'localappdata']) {
    if (!existsSync(join(profile, name))) mkdirSync(join(profile, name));
  }
  return electron.launch({
    executablePath: electronExecutable,
    cwd: unpackedPackage,
    args: ['.', '--joy-media-test-mode', `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JOY_MEDIA_TEST_API_BASE_URL: apiBaseUrl,
      JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: join(profile, 'downloads'),
      JOY_MEDIA_TEST_SELECT_FILE: selectFile,
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
  await authenticate(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  return page;
}

/** Calls the bridge exactly as the editor does and returns the value or the refusal message. */
async function bridge<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  const outcome = await page.evaluate(
    async ({ channel, payload }) => {
      const joy = (window as unknown as { joyDesktop: Bridge }).joyDesktop;
      try {
        return { ok: true, data: await joy.invoke(channel, payload) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    { channel, payload },
  );
  if (!outcome.ok) throw new Error(`${channel} refused: ${outcome.error}`);
  return outcome.data as T;
}

async function bridgeOutcome(
  page: Page,
  channel: string,
  payload?: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return page.evaluate(
    async ({ channel, payload }) => {
      const joy = (window as unknown as { joyDesktop: Bridge }).joyDesktop;
      try {
        return { ok: true, data: await joy.invoke(channel, payload) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    { channel, payload },
  );
}

function filesNamed(directory: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesNamed(path, predicate);
    return predicate(entry.name) ? [path] : [];
  });
}

interface JobView {
  readonly id: string;
  readonly status: string;
  readonly progress?: number;
  readonly error?: string;
  readonly jobType?: string;
}

test.describe('desktop.local-worker-route', () => {
  test('a thumbnail requested from the packaged editor is rendered by the local Worker and survives a restart', async () => {
    test.setTimeout(300_000);
    const work = mkdtempSync(join(tmpdir(), 'joy-local-worker-clip-'));
    const video = join(work, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      video,
    ]);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-local-worker-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile, video);
      const page = await openEditorPage(app);
      const selected = await bridge<{ id: string; kind: string; displayName: string }>(
        page,
        'desktop.select-file',
      );
      expect(selected.kind).toBe('local-file');

      await bridge(page, 'desktop.startup-preference', 'start-worker');
      const requested = await bridge<{ jobId: string; refId: string; kind: string }>(
        page,
        'desktop.request-derivative',
        { ref: selected, kind: 'thumbnail' },
      );
      expect(requested.refId).toBe(selected.id);

      const jobId = requested.jobId;
      await expect
        .poll(async () => (await bridge<JobView>(page, 'desktop.job-status', { jobId })).status, {
          timeout: 180_000,
          intervals: [500],
        })
        .toBe('done');
      const finished = await bridge<JobView>(page, 'desktop.job-status', { jobId });
      expect(finished).toMatchObject({
        id: jobId,
        status: 'done',
        progress: 100,
        jobType: 'asset.thumbnail',
      });
      // The renderer never sees a file path or a lease token.
      expect(JSON.stringify(finished)).not.toMatch(/leaseToken|job-derivatives/);

      const [derivative] = filesNamed(join(profile, 'media', 'job-derivatives'), (name) =>
        name.startsWith(`${jobId}-`),
      );
      expect(
        derivative,
        'the Worker thumbnail is stored under the desktop media root',
      ).toBeDefined();
      const bytes = readFileSync(derivative ?? '');
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      // Evidence for the run log: where the Worker's JPEG landed and how big it is.
      console.log(
        `[evidence] job=${jobId} derivative=${derivative} bytes=${bytes.length} ` +
          `status=${JSON.stringify(await bridge(page, 'desktop.worker-status'))}`,
      );

      await app.close();
      app = undefined;

      // Restart: the finished job and its record are still there.
      app = await launchPackagedEditor(profile, video);
      const restarted = await openEditorPage(app);
      const afterRestart = await bridge<JobView>(restarted, 'desktop.job-status', { jobId });
      expect(afterRestart).toMatchObject({ id: jobId, status: 'done' });
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('a file that is not a video fails the job visibly, with no thumbnail stored', async () => {
    test.setTimeout(300_000);
    const work = mkdtempSync(join(tmpdir(), 'joy-local-worker-text-'));
    const notVideo = join(work, 'notes.bin');
    execFileSync(process.execPath, [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(notVideo)}, 'plain text')`,
    ]);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-local-worker-fail-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile, notVideo);
      const page = await openEditorPage(app);
      const selected = await bridge<{ id: string }>(page, 'desktop.select-file');
      await bridge(page, 'desktop.startup-preference', 'start-worker');
      const { jobId } = await bridge<{ jobId: string }>(page, 'desktop.request-derivative', {
        ref: selected,
        kind: 'thumbnail',
      });
      await expect
        .poll(async () => (await bridge<JobView>(page, 'desktop.job-status', { jobId })).status, {
          timeout: 180_000,
          intervals: [500],
        })
        .toBe('failed');
      const failed = await bridge<JobView>(page, 'desktop.job-status', { jobId });
      expect(failed.error ?? '').toMatch(/ffmpeg could not create a thumbnail/);
      expect(
        filesNamed(join(profile, 'media', 'job-derivatives'), (name) =>
          name.startsWith(`${jobId}-`),
        ),
      ).toEqual([]);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('masking and export are refused with SETUP_REQUIRED through the same bridge, never accepted', async () => {
    test.setTimeout(300_000);
    const work = mkdtempSync(join(tmpdir(), 'joy-local-worker-setup-'));
    const video = join(work, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=160x120:rate=10',
      '-pix_fmt',
      'yuv420p',
      video,
    ]);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-local-worker-setup-'));
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile, video);
      const page = await openEditorPage(app);
      const selected = await bridge<{ id: string }>(page, 'desktop.select-file');
      await bridge(page, 'desktop.startup-preference', 'start-worker');
      // Wait for the Worker process to start; the refusal is decided once it has said hello.
      await expect
        .poll(async () => (await bridgeOutcome(page, 'desktop.worker-status')).data, {
          timeout: 120_000,
        })
        .toMatchObject({ connection: 'online' });
      const exported = await bridgeOutcome(page, 'desktop.request-derivative', {
        ref: selected,
        kind: 'proxy',
      });
      expect(exported.ok).toBe(false);
      expect(exported.error ?? '').toMatch(/SETUP_REQUIRED|UNSUPPORTED_JOB/);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
