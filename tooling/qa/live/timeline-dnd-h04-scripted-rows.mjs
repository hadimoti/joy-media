import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { clipsOf } from './matrix-core.mjs';
import { blockedRow, firstLine } from './rows.mjs';
import { importThroughLeftPanel, newProject } from './steps.mjs';
import { ensureTimelineClip } from './ui-steps.mjs';

const DROP_TYPES = ['dragEnter', 'dragOver', 'drop'];

/**
 * Why a simulated drop cannot prove a drop row. The preload gives import tickets only to the files of the most recent
 * trusted drop (apps/desktop/src/preload/preload.cjs:62 and 93-102; preload.test.ts:85-126). Whether a drop made with
 * Input.dispatchDragEvent counts as trusted is not verified in the repo (see REPORT-h04.md).
 */
const UNTRUSTED_DROP_REASON =
  'the preload mints import tickets only for the files of the most recent trusted drop (preload.cjs:62, 93-102), and this simulated drop was not shown to be trusted';

/**
 * Verdict rule for the drop rows. `blocked` only when the drop provably never reached the app (the wait for a clip timed
 * out and no new Media card appeared). A new card, a wrong position or a wrong name after the app saw the file is a defect.
 */
class ClipWaitTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClipWaitTimeout';
  }
}

const isClipWaitTimeout = (error) => error instanceof ClipWaitTimeout;
// A Playwright wait that ran out of time (not an IPC or harness failure, which must stay a failure).
const isUiTimeout = (error) => error?.name === 'TimeoutError';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

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

/** Clips that were not in the baseline: the clips this row's drop created. */
function clipsAddedSince(before, clips) {
  const known = new Set(before.map((clip) => clip.id));
  return clips.filter((clip) => !known.has(clip.id));
}

/** The Media cards with exactly this name (a card can be left over from an earlier import). */
function mediaCards(page, name) {
  return page
    .locator('.asset-card-name')
    .filter({ hasText: new RegExp(`^${escapeRegExp(name)}$`, 'u') });
}

async function waitForClips(ctx, predicate, description, timeoutMs = ctx.clipWaitMs ?? 12_000) {
  const deadline = Date.now() + timeoutMs;
  let clips = [];
  do {
    clips = await readClips(ctx);
    if (predicate(clips)) return clips;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new ClipWaitTimeout(
    `timed out waiting for ${description}; clips: ${JSON.stringify(clips)}`,
  );
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
      const lock = page.getByRole('button', { name: /^Lock /u }).first();
      await lock
        .locator('xpath=ancestor::*[contains(@class,"timeline-track-header")][1]')
        .hover({ timeout: 8_000 });
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
      // The preload mints import tickets only for a trusted drop (see D-H02). A simulated drop that never shows the
      // refusal toast did not reach the app as a drop: that is a simulation limit, not a locked-track defect.
      const refused = await toast
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      const afterDrop = await readClips(ctx);
      if (!refused && afterDrop.length === before.length) {
        throw blockedRow(
          'D-H01',
          'needs a real mouse drag from Explorer (attended): the simulated drop was not shown to be trusted, so neither the refusal message nor a new clip appeared',
        );
      }
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
      const name = basename(path);
      const targetUs = 2_000_000;
      const before = await readClips(ctx);
      const cardsBefore = await mediaCards(page, name).count();
      await dropFiles(page, '.timeline-empty-state', [path], targetUs);
      let clips;
      try {
        clips = await waitForClips(ctx, (rows) => rows.length > before.length, 'a dropped clip');
      } catch (error) {
        if (!isClipWaitTimeout(error)) throw error;
        if ((await mediaCards(page, name).count()) > cardsBefore) {
          throw new Error(
            `the simulated drop reached Media (a new ${name} card) but made no clip on the timeline`,
          );
        }
        throw blockedRow(
          'D-H02',
          `needs a real mouse drag from Explorer (attended): ${UNTRUSTED_DROP_REASON}, so no clip or Media card appeared`,
        );
      }
      const [clip] = clipsAddedSince(before, clips);
      if (clip === undefined)
        throw new Error('the timeline drop changed the clip count but created no new clip');
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
      const name = basename(fixture(ctx));
      const source = join(rowScratch(ctx, 'D-H06'), name);
      copyFileSync(fixture(ctx), source);
      try {
        chmodSync(source, 0o444);
        const before = statSync(source);
        // The Media import dialog gets the file through DOM.setFileInputFiles: a real file with a real path.
        // The helper waits for the file's card in Media, so a missing card is a failure here.
        await importThroughLeftPanel(page, source);
        const after = statSync(source);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error(
            `read-only source changed: size ${before.size}->${after.size}, mtime ${before.mtimeMs}->${after.mtimeMs}`,
          );
        }
        return `read-only ${name} is in Media; its size and modified time stayed unchanged`;
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
      const name = 'not-a-video.mp4';
      const path = join(rowScratch(ctx, 'D-H07'), name);
      writeFileSync(path, 'plain text, not an MP4 video');
      const cardsBefore = await mediaCards(page, name).count();
      await dropFiles(page, '.timeline-empty-state', [path]);
      const message = page
        .locator('.toast-message')
        .filter({ hasText: /failed|unsupported|invalid|could not|must be/iu })
        .first();
      try {
        await message.waitFor({ state: 'visible', timeout: 10_000 });
      } catch (error) {
        if (!isUiTimeout(error)) throw error;
        if ((await mediaCards(page, name).count()) > cardsBefore) {
          throw new Error('invalid MP4 was added to Media without a rejection message');
        }
        throw blockedRow(
          'D-H07',
          `needs a real mouse drag from Explorer (attended): ${UNTRUSTED_DROP_REASON}, so no message and no Media card appeared`,
        );
      }
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
      // Different bytes from every earlier import, or the catalog reuses the first asset (and its first name).
      const sources = [
        join(ctx.fixtures, 'audio-stereo.wav'),
        join(ctx.fixtures, 'picture-1080.jpg'),
      ];
      const names = ['ویدیو-تست.wav', 'فيديو-اختبار.jpg'];
      const files = names.map((name, index) => {
        const path = join(dir, name);
        copyFileSync(sources[index], path);
        appendFileSync(path, Buffer.from([index + 1]));
        return path;
      });
      // Through the Media import dialog, one file at a time. A name the app mangles never reaches a card, and the
      // helper's wait for that card times out: that is a defect of this row, not a blocked one.
      for (const file of files) {
        try {
          await importThroughLeftPanel(page, file);
        } catch (error) {
          if (!isUiTimeout(error)) throw error;
          throw new Error(
            `Media does not show ${basename(file)} after the import: ${firstLine(error)}`,
          );
        }
      }
      const shown = (
        await page
          .locator('.asset-card-name')
          .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))
      ).map((text) => text.trim());
      const missing = names.filter((name) => !shown.some((card) => card.startsWith(name)));
      if (missing.length > 0) {
        throw new Error(
          `Media does not keep the file name(s) ${missing.join(', ')} (first cards: ${JSON.stringify(shown.slice(0, 8))})`,
        );
      }
      return `Media preserved both filenames: ${names.join(', ')}`;
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
      await dropFiles(page, '.timeline-lane', [path], 4_000_000);
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
