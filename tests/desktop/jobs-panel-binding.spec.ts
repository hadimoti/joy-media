import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authenticate, importMediaFixture, openPanel } from '../e2e/wp29-r5-harness.js';

// Packaged app against the live e2e control plane. The control plane's only Worker advertises
// render.export, so the Jobs panel's thumbnail queue must stay disabled, with its capability reason,
// for a selected clip, before and after a reload. The reload is the session transition.
//
// The audit reads the API server's own request log (JOY_MEDIA_E2E_REQUEST_LOG), not the renderer's
// page events, so it sees every request the packaged app sends, whichever process sends it. The test
// reads only the lines written after its start offset. Every project path must name the one project
// the packaged renderer bound for the E2E owner, and no unbound or transitional id may appear.

const desktopRoot = resolve('apps/desktop');
const unpackedPackage = resolve(desktopRoot, 'dist/joy-media-unpacked');
const apiBaseUrl = `http://127.0.0.1:${process.env.JOY_MEDIA_E2E_API_PORT ?? '4174'}`;
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronExecutable = desktopRequire('electron') as string;
const requestLogPath =
  process.env.JOY_MEDIA_E2E_REQUEST_LOG ?? join(tmpdir(), 'joy-media-desktop-api-requests.jsonl');
const E2E_OWNER = 'e2e-owner@example.test';
const BINDINGS_KEY = 'joy-media.control-plane-project-bindings.v1';
const ENSURE_PATH = '/v1/projects/ensure';

const THUMBNAIL_BLOCKED = /No connected Worker advertises asset\.thumbnail/u;

interface ServedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** The desktop bridge's synchronous project-storage reader, which the editor consults before localStorage. */
type DesktopWindow = Window & {
  joyDesktop?: { projectStorage?: { getItem(key: string): string | null } };
};

async function launchPackagedEditor(profile: string): Promise<ElectronApplication> {
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
      APPDATA: join(profile, 'appdata'),
      LOCALAPPDATA: join(profile, 'localappdata'),
      TEMP: join(profile, 'temp'),
      TMP: join(profile, 'temp'),
    },
  });
}

function logOffset(): number {
  return existsSync(requestLogPath) ? statSync(requestLogPath).size : 0;
}

/** The requests the API server served after the offset, in order. */
function requestsSince(offset: number): ServedRequest[] {
  const text = existsSync(requestLogPath) ? readFileSync(requestLogPath, 'utf8') : '';
  return text
    .slice(offset)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ServedRequest);
}

/**
 * The project a request path names. The ensure route names none in its path, and its body is not in
 * the log, so the ensure check below relies on its status alone.
 */
function projectIdOf(path: string): string | undefined {
  if (path === ENSURE_PATH) return undefined;
  return /^\/v1\/projects\/([^/]+)/u.exec(path)?.[1];
}

/**
 * The project ids the packaged renderer has bound for the E2E owner. The desktop build keeps editor
 * documents, bindings included, in the desktop profile and falls back to localStorage, so this reads
 * in the same order as createEditorProjectStorageAdapter.
 */
async function boundProjectIds(page: Page): Promise<Set<string>> {
  const raw = await page.evaluate(
    (key) =>
      (window as DesktopWindow).joyDesktop?.projectStorage?.getItem(key) ??
      window.localStorage.getItem(key),
    BINDINGS_KEY,
  );
  if (raw === null) throw new Error('the packaged renderer has no control-plane project bindings');
  const value = JSON.parse(raw) as { bindingsByOwner?: Record<string, Record<string, unknown>> };
  const owned = value.bindingsByOwner?.[E2E_OWNER] ?? {};
  const ids = Object.values(owned)
    .map((binding) => (binding as { controlPlaneProjectId?: unknown }).controlPlaneProjectId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return new Set(ids);
}

/** Selects the first timeline clip, which makes the Jobs panel's queue reason capability-specific. */
async function selectTimelineClip(page: Page): Promise<void> {
  const timeline = page.locator('.timeline-panel');
  if (!(await timeline.isVisible())) {
    await page.locator('.dv-tab[role="tab"][aria-label="Timeline"]').first().click();
    await expect(timeline).toBeVisible();
  }
  const clip = page.locator('.timeline-clip[data-clip-id]').first();
  await clip.click();
  await expect(clip).toHaveAttribute('aria-current', 'true');
}

/** The live Worker list says which capabilities are connected, and the queue names the missing one. */
async function expectThumbnailBlockedByWorker(page: Page): Promise<void> {
  await expect(page.locator('.jobs-workers li.worker-connected .jobs-caps').first()).toContainText(
    'render.export',
  );
  const queue = page.getByRole('button', { name: 'Queue thumbnail derivative' });
  await expect(queue).toBeDisabled();
  await expect(queue).toHaveAttribute('title', THUMBNAIL_BLOCKED);
}

test.describe('desktop.jobs-panel-binding', () => {
  test('the packaged Jobs panel follows the live Worker set through a reload and sends no unbound project request', async () => {
    test.setTimeout(300_000);
    const profile = mkdtempSync(join(tmpdir(), 'joy-media-jobs-binding-'));
    const offset = logOffset();
    let app: ElectronApplication | undefined;
    try {
      app = await launchPackagedEditor(profile);
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await authenticate(page);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

      // The packaged window cannot navigate to a web URL, so the project is created on the Projects
      // page directly, with the controls the web harness uses.
      const title = `Packaged Jobs ${Date.now()}`;
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByPlaceholder('Project name').fill(title);
      await page.getByRole('button', { name: 'Create project' }).click();
      await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();

      const imageName = `packaged-jobs-${Date.now()}.png`;
      await importMediaFixture(page, 'image.png', imageName);
      await page
        .locator('.asset-card', { hasText: imageName })
        .first()
        .dragTo(page.locator('.timeline-lane[data-track-id]').first(), {
          targetPosition: { x: 80, y: 20 },
        });
      await selectTimelineClip(page);
      await openPanel(page, 'Jobs');
      await expectThumbnailBlockedByWorker(page);

      // Session transition: a reload rebuilds the panel from the live session and the Worker list.
      const reloadOffset = logOffset();
      await page.reload();
      // The packaged window may reopen the last project or show the Projects list; accept either.
      const projectsHeading = page.getByRole('heading', { name: 'Projects', exact: true });
      const fileButton = page.getByRole('button', { name: 'File', exact: true });
      await expect(projectsHeading.or(fileButton)).toBeVisible();
      if (await projectsHeading.isVisible()) {
        await page
          .getByRole('button', { name: new RegExp(title) })
          .first()
          .click();
      }
      await expect(fileButton).toBeVisible();
      await selectTimelineClip(page);
      await openPanel(page, 'Jobs');
      await expectThumbnailBlockedByWorker(page);

      // The server logs each request when its response finishes, so give in-flight responses a moment.
      await page.waitForTimeout(1_000);

      // Server-side audit over the requests this test caused. The server keeps one E2E owner for the
      // whole run, so the packaged project list also reads that owner's projects from earlier tests.
      // Those reads are recorded as an annotation, not failed. Writes to a project this profile did
      // not bind, refusals to its own project, unbound or transitional ids and job requests fail.
      const served = requestsSince(offset);
      const projectRequests = served.filter((request) => request.path.startsWith('/v1/projects'));
      expect(projectRequests.length, 'the packaged session reached the API').toBeGreaterThan(0);

      expect(
        served.filter((request) => /unbound-|transitional/u.test(request.path)),
        'no unbound or transitional id was requested',
      ).toEqual([]);

      expect(
        served.filter((request) => request.method === 'POST' && /\/jobs(\/|$)/u.test(request.path)),
        'the blocked thumbnail queue enqueued no job',
      ).toEqual([]);

      const bound = await boundProjectIds(page);
      expect(bound.size, 'the session bound exactly the project it created').toBe(1);

      const ownRequests = projectRequests.filter((request) =>
        bound.has(projectIdOf(request.path) ?? ''),
      );
      expect(ownRequests.length, 'the session read its bound project').toBeGreaterThan(0);

      const foreignRequests = projectRequests.filter((request) => {
        const id = projectIdOf(request.path);
        return id !== undefined && !bound.has(id);
      });
      test.info().annotations.push({
        type: 'foreign-project-reads',
        description: `${foreignRequests.length} requests named projects this profile did not bind`,
      });
      expect(
        foreignRequests.filter((request) => !['GET', 'OPTIONS', 'HEAD'].includes(request.method)),
        'the session wrote to no project it did not bind',
      ).toEqual([]);

      const ensures = served.filter(
        (request) => request.method === 'POST' && request.path === ENSURE_PATH,
      );
      expect(
        ensures.length,
        'the session created or reused its project through ensure',
      ).toBeGreaterThan(0);
      expect(
        ensures.filter((request) => request.status >= 400),
        'every ensure request succeeded',
      ).toEqual([]);

      expect(
        ownRequests.filter((request) => request.status >= 400),
        'no request to the bound project was refused or failed',
      ).toEqual([]);

      const polledAfterReload = requestsSince(reloadOffset).filter(
        (request) => request.method === 'GET' && bound.has(projectIdOf(request.path) ?? ''),
      );
      expect(
        polledAfterReload.length,
        'the bound project was read again after the reload',
      ).toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
