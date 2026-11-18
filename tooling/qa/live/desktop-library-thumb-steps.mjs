/* global document, HTMLImageElement, HTMLVideoElement */
/** D-A11-01 Asset Library thumbnails: a library-only image and video show a decoded picture on their cards. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { labRoots } from './lab-roots.mjs';
import { rowsById } from './matrix-core.mjs';
import { newProject, openMenu } from './steps.mjs';

const ROW_ID = 'D-A11-01';
const LIBRARY_SRC_PREFIX = 'joy-asset://library/';
const CARD_TIMEOUT_MS = 20_000;
// The fixtures seeded into the scratch library. The kind picks the folder; size and SHA-256 are read from the file.
const SEEDS = [
  { file: 'picture-tiny.png', kind: 'image', folder: 'images', mimeType: 'image/png' },
  { file: 'h264-16x9-audio.mp4', kind: 'video', folder: 'video', mimeType: 'video/mp4' },
];

function fixturePath(fixturesDir, file) {
  const path = join(fixturesDir, file);
  try {
    statSync(path);
  } catch {
    throw new Error(`BLOCKED ${ROW_ID}: the fixture ${file} is not in ${fixturesDir}`);
  }
  return path;
}

function fingerprint(path) {
  const bytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { bytes, sha256 };
}

// The row writes files, so it only runs on a library folder under the scratch root, never the owner's library.
function assertScratchLibrary(libraryDir) {
  const rel = relative(resolve(labRoots().scratch), resolve(libraryDir));
  const inside = rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
  if (!inside) {
    throw new Error(
      `BLOCKED ${ROW_ID}: the library folder ${libraryDir} is outside the scratch root; the row will not write there`,
    );
  }
}

async function assertAppUsesScratchLibrary(ctx) {
  const settings = await ctx.bridge.invoke('desktop.asset-library.get-settings', {});
  const wanted = resolve(ctx.libraryDir).toLowerCase();
  const serialized = JSON.stringify(settings ?? '').toLowerCase();
  // JSON escapes backslashes, so the escaped form is checked as well.
  if (!serialized.includes(wanted) && !serialized.includes(wanted.replaceAll('\\', '\\\\'))) {
    throw new Error(
      `BLOCKED ${ROW_ID}: get-settings does not name the scratch library ${ctx.libraryDir}`,
    );
  }
}

async function readCatalog(catalogPath) {
  let text;
  try {
    text = await readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, assets: [] };
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.assets)) {
    throw new Error('the scratch library catalog.json has no assets array');
  }
  return parsed;
}

/**
 * Copies the fixtures into the scratch library and adds them to its catalog, keeping any entries already there.
 * The entries follow the shape the app writes on import: a joylib- id, no extension on the file, the MIME type in
 * the descriptor (the cards draw an img or a video only for an image/ or video/ MIME type).
 */
async function seedLibrary(libraryDir, fixturesDir) {
  const catalogPath = join(libraryDir, 'catalog.json');
  const catalog = await readCatalog(catalogPath);
  const seeded = [];
  for (const seed of SEEDS) {
    const source = fixturePath(fixturesDir, seed.file);
    const { bytes, sha256 } = fingerprint(source);
    const id = `joylib-${sha256}`;
    const relativePath = `${seed.folder}/${id}`;
    await mkdir(join(libraryDir, seed.folder), { recursive: true });
    await copyFile(source, join(libraryDir, relativePath));
    seeded.push({ ...seed, id, sha256, bytes, relativePath });
  }
  const seededIds = new Set(seeded.map((item) => item.id));
  const assets = [
    ...catalog.assets.filter((asset) => !seededIds.has(asset?.id)),
    ...seeded.map((item) => ({
      id: item.id,
      projectId: '',
      kind: item.kind,
      sha256: item.sha256,
      bytes: item.bytes,
      descriptor: { mimeType: item.mimeType },
      tags: [],
      createdAt: Date.now(),
      cloudBacked: false,
      relativePath: item.relativePath,
      displayName: item.file,
      sortName: item.file.toLowerCase(),
    })),
  ];
  const visible = assets.filter((asset) => asset?.internal !== true);
  const counts = {
    total: visible.length,
    audio: visible.filter((asset) => asset.kind === 'audio').length,
    image: visible.filter((asset) => asset.kind === 'image').length,
    video: visible.filter((asset) => asset.kind === 'video').length,
  };
  await writeFile(
    catalogPath,
    `${JSON.stringify({ ...catalog, version: 1, counts, assets }, null, 2)}\n`,
    'utf8',
  );
  return seeded;
}

async function openMediaPanel(page) {
  const mediaTab = page.locator('[role="tab"][data-feature-tool="media"]').first();
  const selected =
    (await mediaTab.isVisible().catch(() => false)) &&
    (await mediaTab.getAttribute('aria-selected').catch(() => null)) === 'true';
  if (!selected) {
    await openMenu(page, 'View');
    await page.getByRole('menuitem', { name: 'Create', exact: true }).click();
    await mediaTab.waitFor({ state: 'visible', timeout: 5_000 });
    await mediaTab.click();
  }
}

async function readCard(page, label) {
  return page.evaluate((wanted) => {
    const button = [...document.querySelectorAll('.asset-card-media')].find(
      (el) => el.getAttribute('aria-label') === wanted,
    );
    if (!button) return { found: false };
    const media = button.querySelector('img, video');
    const isImage = media instanceof HTMLImageElement;
    const isVideo = media instanceof HTMLVideoElement;
    return {
      found: true,
      dataSource: button.getAttribute('data-source'),
      element: isImage ? 'img' : isVideo ? 'video' : null,
      src: media?.getAttribute('src') ?? null,
      complete: isImage ? media.complete : null,
      naturalWidth: isImage ? media.naturalWidth : null,
      videoWidth: isVideo ? media.videoWidth : null,
      readyState: isVideo ? media.readyState : null,
      errorCode: media?.error?.code ?? null,
    };
  }, label);
}

function judge(item, state) {
  if (!state.found) return ['there is no preview button on the card'];
  const problems = [];
  if (state.dataSource !== 'library') problems.push('data-source is not "library"');
  if (!state.src?.startsWith(LIBRARY_SRC_PREFIX)) {
    problems.push(`src does not start with ${LIBRARY_SRC_PREFIX}`);
  }
  if (item.kind === 'image') {
    if (state.element !== 'img') problems.push('no img element (a placeholder is shown)');
    else if (!(state.complete && state.naturalWidth > 0)) problems.push('the image did not decode');
  } else if (state.element !== 'video') {
    problems.push('no video element (a placeholder is shown)');
  } else if (!(state.videoWidth > 0 || state.readyState >= 2)) {
    problems.push('the video did not decode');
  }
  return problems;
}

function describeCard(item, state, problems) {
  const head = `${item.kind} ${item.file}`;
  if (problems.length === 0) {
    const detail =
      item.kind === 'image'
        ? `naturalWidth ${state.naturalWidth}`
        : `videoWidth ${state.videoWidth}, readyState ${state.readyState}`;
    return `${head} passed (data-source "library", ${detail})`;
  }
  const source = state.found ? state.dataSource : 'no card';
  const code = state.errorCode ?? 'none';
  return `${head} FAILED: ${problems.join('; ')} [data-source "${source}", media error code ${code}]`;
}

async function checkCard(page, item) {
  const label = `Preview ${item.file}`;
  const card = page.locator('.asset-card', { hasText: item.file }).first();
  const deadline = Date.now() + CARD_TIMEOUT_MS;
  let state = { found: false };
  let problems = ['there is no preview button on the card'];
  while (Date.now() < deadline) {
    await card.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    state = await readCard(page, label);
    problems = judge(item, state);
    if (problems.length === 0) break;
    await page.waitForTimeout(250);
  }
  return { item, state, problems };
}

/** Clicks the card, waits for the large preview of the file, reads its element, and closes it again. */
async function checkLargePreview(page, item) {
  await page
    .getByRole('button', { name: `Preview ${item.file}`, exact: true })
    .first()
    .click();
  const section = page.locator(`section.asset-preview[aria-label="Preview: ${item.file}"]`);
  let state = { found: false };
  const deadline = Date.now() + CARD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    state = await section
      .evaluate((el, kind) => {
        const media = el.querySelector(kind === 'video' ? 'video' : 'img');
        const isVideo = media instanceof HTMLVideoElement;
        return {
          found: true,
          src: media?.getAttribute('src') ?? null,
          ready: isVideo
            ? media.videoWidth > 0 || media.readyState >= 2
            : media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0,
          errorCode: media?.error?.code ?? null,
        };
      }, item.kind)
      .catch(() => ({ found: false }));
    if (state.found && state.src?.startsWith(LIBRARY_SRC_PREFIX) && state.ready) break;
    await page.waitForTimeout(250);
  }
  const ok = state.found && state.src?.startsWith(LIBRARY_SRC_PREFIX) && state.ready;
  const line = ok
    ? `large ${item.kind} preview of ${item.file} passed`
    : `large ${item.kind} preview of ${item.file} FAILED [found ${state.found}, src ${state.src ?? 'none'}, ready ${state.ready ?? 'no'}, media error code ${state.errorCode ?? 'none'}]`;
  await page
    .getByRole('button', { name: 'Close preview', exact: true })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
  return { line, problem: ok ? undefined : line };
}

const rows = [
  {
    id: ROW_ID,
    area: 'Asset Library thumbnails',
    title: 'Library-only image and video show a decoded picture on their cards',
    severity: 'major',
    expected:
      'each card shows a decoded image or video with data-source="library" and a joy-asset://library/ src',
    async run(page, ctx) {
      assertScratchLibrary(ctx.libraryDir);
      await assertAppUsesScratchLibrary(ctx);
      // Seed first, then open a new project: the Media panel reads the catalog on mount and on a project change.
      const seeded = await seedLibrary(ctx.libraryDir, ctx.fixtures);
      await newProject(page, `${ROW_ID} thumbs ${Date.now().toString(36)}`);
      await openMediaPanel(page);

      const cards = [];
      for (const item of seeded) cards.push(await checkCard(page, item));

      const dir = join(ctx.outDir, ROW_ID);
      await mkdir(dir, { recursive: true });
      const cardsPath = join(dir, 'cards.json');
      const details = cards.map(({ item, state, problems }) => ({
        file: item.file,
        kind: item.kind,
        problems,
        state,
      }));
      await writeFile(cardsPath, `${JSON.stringify(details, null, 2)}\n`, 'utf8');

      // Image and video are reported on their own, so a video-only failure stays visible.
      const lines = cards.map(({ item, state, problems }) => describeCard(item, state, problems));
      const failed = cards.some(({ problems }) => problems.length > 0);
      if (failed) throw new Error(lines.join('; '));
      const shot = await ctx.shot(ROW_ID, 'cards');

      // A click on a card opens the large preview from the same library file.
      for (const item of seeded) {
        const preview = await checkLargePreview(page, item);
        lines.push(preview.line);
        if (preview.problem !== undefined) throw new Error(lines.join('; '));
      }
      return {
        message: lines.join('; '),
        evidence: [cardsPath, shot].filter((path) => typeof path === 'string'),
      };
    },
  },
];

export const LIBRARY_THUMB_ROWS = Object.freeze(rows);
export const LIBRARY_THUMB_ROWS_BY_ID = Object.freeze(rowsById(rows));
