/** T-K07 runnable colour lifecycle rows. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addPointAndDrag } from './color-curves-steps.mjs';
import { pickGreenAndDesaturate } from './color-hsl-steps.mjs';
import { applyEachBuiltInLook, runColourLifecycle } from './color-persistence-steps.mjs';
import { dragWheelChangesGrade } from './color-wheels-steps.mjs';
import { extractExportFrame } from '../compare.mjs';
import { exportAndProbe } from './export-probe.mjs';
import { ensureTimelineClip, previewShot, selectClipById } from './ui-steps.mjs';
import { readProjectIds, readLiveTimeline } from './matrix-core.mjs';
import { blockedRow } from './rows.mjs';

const COLOR_KEYS = /color|colour|grade|look|lut|curve|wheel|hsl/iu;

function collectColorState(value, path = '', out = {}) {
  if (value === null || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (COLOR_KEYS.test(key)) out[nextPath] = child;
    else if (child !== null && typeof child === 'object') collectColorState(child, nextPath, out);
  }
  return out;
}

function findNested(value, predicate) {
  if (value === null || typeof value !== 'object') return undefined;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findNested(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function readGrade(ctx) {
  const state = await ctx.readDocument();
  return collectColorState({ document: state.document, storedDocument: state.storedDocument });
}

async function readHslGrade(ctx) {
  const state = await ctx.readDocument();
  const grade = findNested(state, (value) => Array.isArray(value?.hsl));
  if (grade === undefined) throw new Error('the saved colour grade has no readable HSL bands');
  return grade;
}

async function readWheel(ctx) {
  const grade = await readGrade(ctx);
  const lift = findNested(grade, (value) => value?.lift)?.lift;
  if (!lift || !['r', 'g', 'b'].every((key) => Number.isFinite(lift[key]))) {
    throw new Error('the saved colour grade has no readable Lift wheel');
  }
  return lift;
}

async function readCurve(ctx) {
  const grade = await readGrade(ctx);
  const points = findNested(grade, (value) => Array.isArray(value?.rgb))?.rgb;
  if (!Array.isArray(points)) throw new Error('the saved colour grade has no readable RGB curve');
  return points;
}

function ffmpegRaw(input, args) {
  const tool = process.env.JOY_MEDIA_FFMPEG ?? 'ffmpeg';
  const result = spawnSync(tool, args, {
    input,
    encoding: null,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `ffmpeg pixel read failed: ${String(result.error?.message ?? result.stderr).split('\n')[0]}`,
    );
  }
  return result.stdout;
}

function dimensions(png, rowId) {
  if (!Buffer.isBuffer(png) || png.length < 24) {
    throw blockedRow(rowId, 'the live Monitor screenshot is unavailable to the frame pixel reader');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function monitorPixel(page, point, ctx, rowId) {
  const monitor = page.locator('.monitor-canvas-wrap').first();
  const box = await monitor.boundingBox();
  if (!box) throw new Error('the Monitor frame is not visible');
  const png = await monitor.screenshot();
  const size = dimensions(png, rowId);
  const x = Math.max(0, Math.min(size.width - 1, Math.round(point.x - box.x)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round(point.y - box.y)));
  const rgb = ffmpegRaw(png, [
    '-v',
    'error',
    '-i',
    'pipe:0',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  const offset = (y * size.width + x) * 3;
  if (offset + 2 >= rgb.length) throw new Error('the Monitor screenshot could not be decoded');
  if (ctx.outDir) {
    const dir = join(ctx.outDir, rowId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'preview-pixel.json'),
      JSON.stringify({ x, y, r: rgb[offset], g: rgb[offset + 1], b: rgb[offset + 2] }, null, 2),
    );
  }
  return { r: rgb[offset], g: rgb[offset + 1], b: rgb[offset + 2] };
}

async function saveAndReopen(page, ctx, rowId) {
  await page.waitForTimeout(1_000);
  const session = await ctx.restartApp();
  const heading = session.page.getByRole('heading', { name: 'Projects', exact: true });
  if (await heading.isVisible().catch(() => false)) {
    const ids = await readProjectIds(session.page);
    if (!ids.title) throw new Error(`BLOCKED ${rowId}: saved project title is unavailable`);
    await session.page.locator('.project-library-card', { hasText: ids.title }).first().click();
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const live = await readLiveTimeline(session.page).catch(() => null);
    const ids = await readProjectIds(session.page);
    if (live && live.id === ids.active) break;
    await session.page.waitForTimeout(100);
  }
  ctx.page = session.page;
  return await readGrade(ctx);
}

async function compareExport(page, pixel, ctx, rowId) {
  const preview = await previewShot(page, ctx, rowId, 'colour-export-preview');
  const exported = await exportAndProbe(page, ctx, rowId, { skipTrim: true, tag: 'colour' });
  const framePath = join(ctx.outDir, rowId, 'colour-export-frame.png');
  await extractExportFrame(exported.path, 0, framePath);
  const probeTool = process.env.JOY_MEDIA_FFPROBE ?? 'ffprobe';
  const probe = spawnSync(
    probeTool,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      framePath,
    ],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (probe.error || probe.status !== 0)
    throw new Error(`ffprobe pixel compare failed: ${probe.stderr ?? probe.error?.message}`);
  const { width, height } = JSON.parse(probe.stdout).streams[0];
  const video = ffmpegRaw(undefined, [
    '-v',
    'error',
    '-i',
    framePath,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  const monitorBox = await page.locator('.monitor-canvas-wrap').first().boundingBox();
  const screenshotDimensions = dimensions(
    await page.locator('.monitor-canvas-wrap').first().screenshot(),
    rowId,
  );
  const x = Math.max(
    0,
    Math.min(width - 1, Math.round(((pixel.x - monitorBox.x) / monitorBox.width) * width)),
  );
  const y = Math.max(
    0,
    Math.min(height - 1, Math.round(((pixel.y - monitorBox.y) / monitorBox.height) * height)),
  );
  const offset = (y * width + x) * 3;
  const expected = await monitorPixel(page, pixel, ctx, rowId);
  const actual = { r: video[offset], g: video[offset + 1], b: video[offset + 2] };
  const delta = Math.max(
    Math.abs(expected.r - actual.r),
    Math.abs(expected.g - actual.g),
    Math.abs(expected.b - actual.b),
  );
  if (delta > 16)
    throw new Error(
      `preview/export pixel differs by ${delta} levels: ${JSON.stringify(expected)} vs ${JSON.stringify(actual)}`,
    );
  writeFileSync(
    join(ctx.outDir, rowId, 'pixel-compare.json'),
    JSON.stringify(
      {
        x,
        y,
        preview: expected,
        export: actual,
        maxDelta: delta,
        previewShot: preview,
        dimensions: screenshotDimensions,
      },
      null,
      2,
    ),
  );
}

async function runLifecycle(rowId, gesture, ctx, { point, includeExport = true } = {}) {
  const base = await ensureTimelineClip(ctx.page, ctx, rowId, { fresh: true });
  await selectClipById(ctx.page, base.clips[0].id);
  const pixel = point ?? { x: 0, y: 0 };
  const lifecycle = {
    pixel,
    readPreviewPixel: (page, p) => monitorPixel(page, p, ctx, rowId),
    readGrade: () => readGrade(ctx),
    edit: (page) => gesture(page, ctx, lifecycle.pixel),
    saveAndReopen: (page) => saveAndReopen(page, ctx, rowId),
    undo: async () => ctx.page.keyboard.press('Control+z'),
    ...(includeExport
      ? { compareExportFrame: (_page, p) => compareExport(ctx.page, p, ctx, rowId) }
      : {}),
  };
  const box = await ctx.page.locator('.monitor-canvas-wrap').first().boundingBox();
  if (!box) throw new Error('the Monitor frame is not visible');
  lifecycle.pixel = point ?? { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  return await runColourLifecycle(ctx.page, lifecycle);
}

async function wheel(page, ctx) {
  await dragWheelChangesGrade(page, () => readWheel(ctx), { undo: false });
}

async function curve(page, ctx) {
  await addPointAndDrag(page, () => readCurve(ctx), { undo: false });
}

async function hsl(page, ctx, pixel) {
  await pickGreenAndDesaturate(page, {
    patch: pixel,
    readPreviewPixel: (point) => monitorPixel(page, point, ctx, 'D-K03'),
    readGrade: () => readHslGrade(ctx),
    undo: false,
  });
}

export const COLOR_MATRIX_ROWS = Object.freeze([
  {
    id: 'D-K01',
    area: 'Colour',
    title: 'Drag a colour wheel and check its lifecycle',
    severity: 'major',
    async run(page, ctx) {
      return runLifecycle('D-K01', wheel, ctx);
    },
  },
  {
    id: 'D-K02',
    area: 'Colour',
    title: 'Add and drag a curve point and check its lifecycle',
    severity: 'major',
    async run(page, ctx) {
      return runLifecycle('D-K02', curve, ctx);
    },
  },
  {
    id: 'D-K03',
    area: 'Colour',
    title: 'Pick green and drop its HSL saturation',
    severity: 'major',
    async run(page, ctx) {
      return runLifecycle('D-K03', hsl, ctx);
    },
  },
  {
    id: 'D-K04',
    area: 'Colour',
    title: 'Apply each built-in Look and check its lifecycle',
    severity: 'major',
    async run(page, ctx) {
      const base = await ensureTimelineClip(page, ctx, 'D-K04', { fresh: true });
      await selectClipById(page, base.clips[0].id);
      await page.locator('[data-feature-tool="color"]').first().click();
      await page.locator('[data-panel-tab-id="looks"]').first().click();
      let activePage = page;
      const results = await applyEachBuiltInLook(page, async () => {
        const box = await activePage.locator('.monitor-canvas-wrap').first().boundingBox();
        const pixel = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
        return {
          pixel,
          readPreviewPixel: (target, p) => monitorPixel(target, p, ctx, 'D-K04'),
          readGrade: () => readGrade(ctx),
          edit: async () => {},
          saveAndReopen: async () => {
            const result = await saveAndReopen(activePage, ctx, 'D-K04');
            activePage = ctx.page;
            return result;
          },
          undo: () => ctx.page.keyboard.press('Control+z'),
          compareExportFrame: (_target, p) => compareExport(ctx.page, p, ctx, 'D-K04'),
          getPage: async () => {
            activePage = ctx.page;
            await activePage.locator('[data-feature-tool="color"]').first().click();
            await activePage.locator('[data-panel-tab-id="looks"]').first().click();
            return activePage;
          },
        };
      });
      return {
        message: `checked ${results.length} built-in Looks through preview, export, save/reopen and Undo`,
      };
    },
  },
]);

export const COLOR_MATRIX_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(COLOR_MATRIX_ROWS.map((row) => [row.id, row])),
);
