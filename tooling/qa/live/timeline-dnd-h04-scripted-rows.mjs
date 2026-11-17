import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { clipsOf } from './matrix-core.mjs';
import { newProject } from './steps.mjs';
import { ensureTimelineClip } from './ui-steps.mjs';

const DROP_TYPES = ['dragEnter', 'dragOver', 'drop'];

function rowScratch(ctx, id) {
  const path = join(ctx.outDir, id, 'scratch');
  mkdirSync(path, { recursive: true });
  return path;
}

async function dropFiles(page, selector, filePaths, targetUs = 2_000_000) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: 'visible' });
  const rect = await target.boundingBox();
  if (!rect) throw new Error(`no visible file drop target: ${selector}`);
  const zoom = Number(await page.getByLabel('Timeline zoom').inputValue());
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('Timeline zoom is unavailable');
  const x = rect.x + Math.min((targetUs * zoom) / 1_000_000, Math.max(1, rect.width - 2));
  const y = rect.y + rect.height / 2;
  const session = await page.context().newCDPSession(page);
  try {
    for (const type of DROP_TYPES) {
      await session.send('Input.dispatchDragEvent', {
        type,
        x,
        y,
        data: { items: [], files: filePaths, dragOperationsMask: 1 },
      });
    }
  } finally {
    await session.detach();
  }
  return { x, y, requestedUs: targetUs, zoom };
}

async function readClips(ctx) {
  return clipsOf((await ctx.readDocument()).document).map(({ trackId, clip }) => ({
    id: clip.id,
    assetId: clip.assetId,
    trackId,
    startUs: clip.startUs,
  }));
}

async function waitForClips(ctx, predicate, description, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let clips = [];
  do {
    clips = await readClips(ctx);
    if (predicate(clips)) return clips;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${description}; clips: ${JSON.stringify(clips)}`);
}

async function fileDropRow(page, ctx, { filePaths, selector, targetUs, beforeCount = 0 }) {
  const point = await dropFiles(page, selector, filePaths, targetUs);
  const clips = await waitForClips(ctx, (rows) => rows.length > beforeCount, 'a dropped clip');
  const latest = clips.slice(beforeCount);
  return { point, clips: latest };
}

async function fresh(page, ctx, id) {
  await newProject(page, `${id} ${ctx.runTag ?? ''}`.trim());
}

function fixture(ctx) {
  const path = ctx.media;
  if (!path) throw new Error('BLOCKED D-H04: run with --media <video fixture>');
  return path;
}

function assertNear(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} was ${actual} us; expected ${expected} us within ${tolerance} us`);
  }
}

export const TIMELINE_DND_H04_ROWS = [
  {
    id: 'D-H01',
    area: 'timeline file drops',
    title: 'A file drop is rejected by a locked track',
    severity: 'major',
    async run(page, ctx) {
      await fresh(page, ctx, 'D-H01');
      const seeded = await ensureTimelineClip(page, ctx, 'D-H01');
      const track = page
        .locator(`.timeline-track[data-track-id="${seeded.clips[0].trackId}"]`)
        .first();
      const lock = track.locator('button[aria-label^="Lock "]').first();
      if ((await lock.getAttribute('aria-pressed')) !== 'true') await lock.click();
      if ((await lock.getAttribute('aria-pressed')) !== 'true')
        throw new Error('track did not lock');
      const before = await readClips(ctx);
      const added = join(rowScratch(ctx, 'D-H01'), basename(fixture(ctx)));
      copyFileSync(fixture(ctx), added);
      await dropFiles(page, `.timeline-track[data-track-id="${seeded.clips[0].trackId}"]`, [added]);
      const toast = page
        .locator('.toast-message')
        .filter({ hasText: /track is locked/iu })
        .first();
      await toast.waitFor({ state: 'visible', timeout: 8_000 });
      await page.waitForTimeout(500);
      const after = await readClips(ctx);
      if (after.length !== before.length)
        throw new Error(`locked drop added a clip (${before.length} -> ${after.length})`);
      return `locked track ${seeded.clips[0].trackId} refused the file; no clip was added`;
    },
  },
  {
    id: 'D-H02',
    area: 'timeline file drops',
    title: 'A file dropped on the empty timeline lands at the requested time',
    severity: 'major',
    async run(page, ctx) {
      await fresh(page, ctx, 'D-H02');
      const path = fixture(ctx);
      const targetUs = 2_000_000;
      const result = await fileDropRow(page, ctx, {
        filePaths: [path],
        selector: '.timeline-empty-state',
        targetUs,
      });
      const clip = result.clips[0];
      assertNear(clip.startUs, targetUs, 100_000, 'dropped clip start');
      return `clip ${clip.id} started at ${clip.startUs} us (requested ${targetUs} us)`;
    },
  },
  {
    id: 'D-H06',
    area: 'timeline file drops',
    title: 'A read-only source imports without changing the file',
    severity: 'major',
    async run(page, ctx) {
      await fresh(page, ctx, 'D-H06');
      const source = join(rowScratch(ctx, 'D-H06'), basename(fixture(ctx)));
      copyFileSync(fixture(ctx), source);
      try {
        chmodSync(source, 0o444);
        const before = statSync(source);
        const result = await fileDropRow(page, ctx, {
          filePaths: [source],
          selector: '.timeline-empty-state',
          targetUs: 2_000_000,
        });
        const after = statSync(source);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error(
            `read-only source changed: size ${before.size}->${after.size}, mtime ${before.mtimeMs}->${after.mtimeMs}`,
          );
        }
        return `read-only ${basename(source)} imported as clip ${result.clips[0].id}; source size and mtime stayed unchanged`;
      } finally {
        chmodSync(source, 0o644);
      }
    },
  },
  {
    id: 'D-H07',
    area: 'timeline file drops',
    title: 'A non-video file named .mp4 is rejected by content',
    severity: 'major',
    async run(page, ctx) {
      await fresh(page, ctx, 'D-H07');
      const before = await readClips(ctx);
      const path = join(rowScratch(ctx, 'D-H07'), 'not-a-video.mp4');
      writeFileSync(path, 'plain text, not an MP4 video');
      await dropFiles(page, '.timeline-empty-state', [path]);
      const message = page
        .locator('.toast-message')
        .filter({ hasText: /failed|unsupported|invalid|could not|must be/iu })
        .first();
      await message.waitFor({ state: 'visible', timeout: 10_000 });
      const after = await readClips(ctx);
      if (after.length !== before.length)
        throw new Error(`invalid MP4 added ${after.length - before.length} clip(s)`);
      return `rejected ${basename(path)} by content with message: ${(await message.innerText()).trim()}`;
    },
  },
  {
    id: 'D-H08',
    area: 'timeline file drops',
    title: 'Persian and Arabic filenames remain intact in Media',
    severity: 'major',
    async run(page, ctx) {
      await fresh(page, ctx, 'D-H08');
      const dir = rowScratch(ctx, 'D-H08');
      const sources = [fixture(ctx), join(ctx.fixtures, 'picture-1080.jpg')];
      const names = ['ویدیو-تست.mp4', 'فيديو-اختبار.jpg'];
      const files = names.map((name, index) => {
        const path = join(dir, name);
        copyFileSync(sources[index], path);
        return path;
      });
      await dropFiles(page, '.timeline-empty-state', files, 2_000_000);
      await waitForClips(ctx, (clips) => clips.length >= names.length, 'two Unicode-named clips');
      for (const name of names) {
        await page
          .locator('.asset-card-name')
          .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
      }
      return `Media preserved both filenames exactly: ${names.join(', ')}`;
    },
  },
  {
    id: 'D-H10',
    area: 'timeline file drops',
    title: 'Dropping the same file twice creates distinct timeline clips',
    severity: 'major',
    async run(page, ctx) {
      await fresh(page, ctx, 'D-H10');
      const path = fixture(ctx);
      const first = await fileDropRow(page, ctx, {
        filePaths: [path],
        selector: '.timeline-empty-state',
        targetUs: 1_000_000,
      });
      await dropFiles(page, '.timeline-track', [path], 4_000_000);
      const clips = await waitForClips(
        ctx,
        (rows) => rows.length >= first.clips.length + 1,
        'second clip from the repeated file',
      );
      const pair = clips.slice(-2);
      if (pair[0].id === pair[1].id) throw new Error('the repeated file reused a timeline clip id');
      const catalog = await ctx.bridge.invoke('desktop.asset-library.get-catalog', {});
      const assets = catalog?.assets ?? catalog?.data?.assets ?? [];
      const names = assets
        .map((asset) => asset.displayName)
        .filter((name) => name === basename(path));
      if (names.length !== 1) {
        throw new Error(
          `identical dropped bytes should keep one catalog entry named ${basename(path)}; found ${names.length}`,
        );
      }
      return `created clips ${pair[0].id} and ${pair[1].id}; content-addressed catalog keeps one media record for identical bytes${names.length ? ` (${names.length} named record)` : ''}`;
    },
  },
];

for (const row of TIMELINE_DND_H04_ROWS) {
  const run = row.run;
  row.run = async (page, ctx) => {
    try {
      return await run(page, ctx);
    } finally {
      rmSync(join(ctx.outDir, row.id, 'scratch'), { recursive: true, force: true });
    }
  };
}

export const TIMELINE_DND_H04_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(TIMELINE_DND_H04_ROWS.map((row) => [row.id, row])),
);
