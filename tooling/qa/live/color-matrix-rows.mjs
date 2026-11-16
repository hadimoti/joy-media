/* global document */
/** T-K07 runnable colour lifecycle rows. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openColorPanel, restoreColorRowUi } from './color-panel-steps.mjs';
import { addPointAndDrag } from './color-curves-steps.mjs';
import { pickGreenAndDesaturate } from './color-hsl-steps.mjs';
import { applyEachBuiltInLook, runColourLifecycle } from './color-persistence-steps.mjs';
import { dragWheelChangesGrade } from './color-wheels-steps.mjs';
import { compareFrames, extractExportFrame } from '../compare.mjs';
import { exportAndProbe } from './export-probe.mjs';
import { blurFocus, ensureTimelineClip, previewShot, selectClipById } from './ui-steps.mjs';
import { readProjectIds, readLiveTimeline } from './matrix-core.mjs';
import { blockedRow } from './rows.mjs';

export function clipColourGrade(state, clipId) {
  if (clipId === undefined) return undefined;
  // With no clip selected a colour edit goes to the whole-output grade (`colorGrade`); with a clip selected it goes
  // to that clip's entry. A row starts on a fresh project, so whichever one holds a grade is the row's edit.
  return (
    state.liveVisualProject?.clipColorGrades?.[clipId] ??
    state.storedDocument?.clipColorGrades?.[clipId] ??
    state.document?.clipColorGrades?.[clipId] ??
    state.liveVisualProject?.colorGrade ??
    state.storedDocument?.colorGrade
  );
}

/** What the app holds before any colour edit: no grade is stored yet, which means every control at rest. */
const IDENTITY_POINTS = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];
const AT_REST_GRADE = Object.freeze({
  wheels: Object.freeze({
    lift: Object.freeze({ r: 0, g: 0, b: 0, master: 0 }),
    gamma: Object.freeze({ r: 0, g: 0, b: 0, master: 0 }),
    gain: Object.freeze({ r: 0, g: 0, b: 0, master: 0 }),
    offset: Object.freeze({ r: 0, g: 0, b: 0, master: 0 }),
  }),
  curves: Object.freeze({
    rgb: IDENTITY_POINTS,
    red: IDENTITY_POINTS,
    green: IDENTITY_POINTS,
    blue: IDENTITY_POINTS,
  }),
  hsl: Object.freeze([]),
});

export async function readColourGrade(ctx, clipId) {
  const state = await ctx.readDocument();
  const grade = clipColourGrade(state, clipId);
  // Before the first edit nothing is stored: read that as the controls at rest, so a before and after compare works.
  return grade === undefined ? AT_REST_GRADE : grade;
}

async function readHslGrade(ctx, clipId) {
  const grade = await readColourGrade(ctx, clipId);
  if (!Array.isArray(grade?.hsl))
    throw new Error('the saved colour grade has no readable HSL bands');
  return grade;
}

async function readWheel(ctx, clipId) {
  const grade = await readColourGrade(ctx, clipId);
  const lift = grade?.wheels?.lift ?? grade?.lift;
  if (!lift || !['r', 'g', 'b'].every((key) => Number.isFinite(lift[key]))) {
    throw new Error('the saved colour grade has no readable Lift wheel');
  }
  return lift;
}

async function readCurve(ctx, clipId) {
  const grade = await readColourGrade(ctx, clipId);
  const points = grade?.curves?.rgb ?? grade?.rgb;
  if (!Array.isArray(points)) throw new Error('the saved colour grade has no readable RGB curve');
  return points;
}

export function monitorPictureRect(box, composition, view = {}) {
  if (!composition || !Number.isFinite(composition.width) || !Number.isFinite(composition.height))
    throw new Error('the Monitor picture dimensions are unavailable');
  const zoom = Number(view.zoom ?? 1);
  const left = Number(view.panX ?? 0);
  const top = Number(view.panY ?? 0);
  return {
    x: box.x + left,
    y: box.y + top,
    width: composition.width * zoom,
    height: composition.height * zoom,
  };
}

export function monitorPicturePoint(rect, xRatio, yRatio) {
  return { x: rect.x + rect.width * xRatio, y: rect.y + rect.height * yRatio };
}

async function monitorPicture(page, ctx) {
  const stage = page.locator('.monitor-canvas-wrap').first();
  const box = await stage.boundingBox();
  if (!box) throw new Error('the Monitor frame is not visible');
  const document = (await ctx.readDocument()).document;
  const composition = document?.compositions?.[document?.rootCompositionId];
  const view = {
    zoom: Number(await stage.getAttribute('data-monitor-zoom')) || 1,
    panX: Number(await stage.getAttribute('data-monitor-pan-x')) || 0,
    panY: Number(await stage.getAttribute('data-monitor-pan-y')) || 0,
  };
  return monitorPictureRect(box, composition, view);
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
  const canvasBox = await page.locator('.monitor-canvas').first().boundingBox();
  if (!canvasBox) throw blockedRow(rowId, 'the Monitor canvas is not visible');
  const xRatio = Math.max(0, Math.min(1, (point.x - canvasBox.x) / canvasBox.width));
  const yRatio = Math.max(0, Math.min(1, (point.y - canvasBox.y) / canvasBox.height));
  const sample = await page
    .locator('.monitor-canvas')
    .first()
    .evaluate(
      function readMonitorCanvasPixel(element, ratios) {
        const source = element.querySelector('canvas');
        if (!source || source.width === 0 || source.height === 0) return null;
        const target = document.createElement('canvas');
        target.width = source.width;
        target.height = source.height;
        const context = target.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(source, 0, 0);
        const x = Math.max(0, Math.min(source.width - 1, Math.floor(ratios.x * source.width)));
        const y = Math.max(0, Math.min(source.height - 1, Math.floor(ratios.y * source.height)));
        const data = context.getImageData(x, y, 1, 1).data;
        return {
          x,
          y,
          width: source.width,
          height: source.height,
          r: data[0],
          g: data[1],
          b: data[2],
        };
      },
      { x: xRatio, y: yRatio },
    );
  if (!sample) throw blockedRow(rowId, 'the Monitor canvas pixel is unavailable');
  ctx.monitorCanvasSize = { width: sample.width, height: sample.height };
  if (ctx.outDir) {
    const dir = join(ctx.outDir, rowId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preview-pixel.json'), JSON.stringify(sample, null, 2));
  }
  return { r: sample.r, g: sample.g, b: sample.b };
}

const MONITOR_BACKGROUND = { r: 12, g: 16, b: 28 };
const MONITOR_PIXEL_TOLERANCE = 3;

function pixelDistance(left, right) {
  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b),
  );
}

export async function waitForMonitorPixel(page, point, ctx, rowId, predicate, description) {
  let previous;
  let stableReads = 0;
  let last;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    last = await monitorPixel(page, point, ctx, rowId);
    if (predicate(last)) {
      stableReads =
        previous && pixelDistance(previous, last) <= MONITOR_PIXEL_TOLERANCE ? stableReads + 1 : 1;
      if (stableReads >= 2) return last;
    } else {
      stableReads = 0;
    }
    previous = last;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `${rowId}: timed out waiting for ${description}; last pixel ${JSON.stringify(last)}; Monitor canvas ${JSON.stringify(ctx.monitorCanvasSize ?? null)}`,
  );
}

async function waitForColourPixel(page, point, ctx, rowId, condition, baseline) {
  return waitForMonitorPixel(
    page,
    point,
    ctx,
    rowId,
    (pixel) => {
      if (condition === 'baseline')
        return pixelDistance(pixel, MONITOR_BACKGROUND) > MONITOR_PIXEL_TOLERANCE;
      if (condition === 'changed') return pixelDistance(pixel, baseline) > MONITOR_PIXEL_TOLERANCE;
      return pixelDistance(pixel, baseline) <= MONITOR_PIXEL_TOLERANCE;
    },
    condition === 'baseline'
      ? 'a stable picture pixel'
      : condition === 'changed'
        ? 'the edited picture pixel'
        : 'Undo to restore the baseline pixel',
  );
}

async function saveAndReopen(page, ctx, rowId, clipId) {
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
  return await readColourGrade(ctx, clipId);
}

async function compareExport(page, pixel, ctx, rowId) {
  const preview = await previewShot(page, ctx, rowId, 'colour-export-preview');
  const exported = await exportAndProbe(page, ctx, rowId, {
    skipTrim: true,
    seconds: 3,
    tag: 'colour',
  });
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
  const picture = await monitorPicture(page, ctx);
  const screenshotDimensions = dimensions(await page.screenshot({ clip: picture }), rowId);
  const x = Math.max(
    0,
    Math.min(width - 1, Math.round(((pixel.x - picture.x) / picture.width) * width)),
  );
  const y = Math.max(
    0,
    Math.min(height - 1, Math.round(((pixel.y - picture.y) / picture.height) * height)),
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

async function runLifecycle(
  rowId,
  gesture,
  ctx,
  { point, sampleRatios = [0.25, 0.2], includeExport = true } = {},
) {
  const base = await ensureTimelineClip(ctx.page, ctx, rowId, { fresh: true });
  const clipId = base.clips[0].id;
  await selectClipById(ctx.page, clipId);
  const pixel = point ?? { x: 0, y: 0 };
  let baselinePixel;
  const lifecycle = {
    clipId,
    pixel,
    readPreviewPixel: (page, p) => monitorPixel(page, p, ctx, rowId),
    waitForPreviewPixel: (page, p, _predicate, description) => {
      if (description === 'stable picture pixel') {
        return waitForColourPixel(page, p, ctx, rowId, 'baseline').then((pixel) => {
          baselinePixel = pixel;
          return pixel;
        });
      }
      if (description === 'colour edit to reach the Monitor')
        return waitForColourPixel(page, p, ctx, rowId, 'changed', baselinePixel);
      if (description === 'Redo to restore the edited Monitor pixel') {
        return waitForMonitorPixel(
          page,
          p,
          ctx,
          rowId,
          (sample) => pixelDistance(sample, baselinePixel) > MONITOR_PIXEL_TOLERANCE,
          'Redo to restore the edited picture pixel',
        );
      }
      return waitForColourPixel(page, p, ctx, rowId, 'restored', baselinePixel);
    },
    readGrade: () => readColourGrade(ctx, clipId),
    edit: (page) => gesture(page, ctx, lifecycle.pixel, clipId),
    saveAndReopen: (page) => saveAndReopen(page, ctx, rowId, clipId),
    undo: async () => {
      await blurFocus(ctx.page);
      await ctx.page.keyboard.press('Control+KeyZ');
    },
    redo: async () => {
      await blurFocus(ctx.page);
      await ctx.page.keyboard.press('Control+KeyY');
    },
    ...(includeExport
      ? { compareExportFrame: (_page, p) => compareExport(ctx.page, p, ctx, rowId) }
      : {}),
  };
  const picture = await monitorPicture(ctx.page, ctx);
  lifecycle.pixel = point ?? monitorPicturePoint(picture, sampleRatios[0], sampleRatios[1]);
  // Capture the baseline and every later read at the same opening frame.
  await blurFocus(ctx.page);
  await ctx.page.keyboard.press('Home');
  return await runColourLifecycle(ctx.page, lifecycle);
}

async function wheel(page, ctx, _pixel, clipId) {
  await dragWheelChangesGrade(page, () => readWheel(ctx, clipId), { undo: false });
}

async function curve(page, ctx, _pixel, clipId) {
  await addPointAndDrag(page, () => readCurve(ctx, clipId), { undo: false });
}

async function hsl(page, ctx, pixel, clipId) {
  await pickGreenAndDesaturate(page, {
    patch: pixel,
    readPreviewPixel: (point) => waitForColourPixel(page, point, ctx, 'D-K03', 'baseline'),
    readGrade: () => readHslGrade(ctx, clipId),
    undo: false,
  });
}

async function runColorRow(page, ctx, run) {
  try {
    return await run();
  } finally {
    await restoreColorRowUi(ctx.page ?? page);
  }
}

export const COLOR_MATRIX_ROWS = Object.freeze([
  {
    id: 'D-F23-01',
    area: 'first and later exports have matching pixels',
    title: 'First and later exports have matching pixels',
    severity: 'major',
    async run(page, ctx) {
      const base = await ensureTimelineClip(page, ctx, 'D-F23-01', { fresh: true });
      await selectClipById(page, base.clips[0].id);
      const first = await exportAndProbe(page, ctx, 'D-F23-01', {
        skipTrim: true,
        seconds: 3,
        tag: 'first',
      });
      const firstPath = join(ctx.downloadDir, `D-F23-01-first-${Date.now()}.mp4`);
      renameSync(first.path, firstPath);
      const later = await exportAndProbe(page, ctx, 'D-F23-01', {
        skipTrim: true,
        seconds: 3,
        tag: 'later',
      });
      const dir = join(ctx.outDir, 'D-F23-01');
      const firstFrame = join(dir, 'first-frame.png');
      const laterFrame = join(dir, 'later-frame.png');
      await extractExportFrame(
        firstPath,
        0,
        firstFrame,
        first.probe.streams.find((s) => s.codec_type === 'video'),
      );
      await extractExportFrame(
        later.path,
        0,
        laterFrame,
        later.probe.streams.find((s) => s.codec_type === 'video'),
      );
      const comparison = await compareFrames(firstFrame, laterFrame, join(dir, 'pixel-compare'), 0);
      writeFileSync(join(dir, 'pixel-compare.json'), `${JSON.stringify(comparison, null, 2)}\n`);
      if (comparison.status !== 'pass') {
        throw new Error(
          `first and later exports differ: mean pixel delta ${comparison.meanAbsoluteChannelDelta}`,
        );
      }
      return `first and later exports have identical decoded pixels (${comparison.totalChannels} channels)`;
    },
  },
  {
    id: 'D-K01',
    area: 'Colour',
    title: 'Drag a colour wheel and check its lifecycle',
    severity: 'major',
    async run(page, ctx) {
      return runColorRow(page, ctx, () => runLifecycle('D-K01', wheel, ctx));
    },
  },
  {
    id: 'D-K02',
    area: 'Colour',
    title: 'Add and drag a curve point and check its lifecycle',
    severity: 'major',
    async run(page, ctx) {
      return runColorRow(page, ctx, () => runLifecycle('D-K02', curve, ctx));
    },
  },
  {
    id: 'D-K03',
    area: 'Colour',
    title: 'Pick green and drop its HSL saturation',
    severity: 'major',
    async run(page, ctx) {
      return runColorRow(page, ctx, () =>
        runLifecycle('D-K03', hsl, ctx, { sampleRatios: [0.25, 0.2] }),
      );
    },
  },
  {
    id: 'D-K04',
    area: 'Colour',
    title: 'Apply each built-in Look and check its lifecycle',
    severity: 'major',
    async run(page, ctx) {
      return runColorRow(page, ctx, async () => {
        const base = await ensureTimelineClip(page, ctx, 'D-K04', { fresh: true });
        const clipId = base.clips[0].id;
        await selectClipById(page, clipId);
        await openColorPanel(page, 'looks');
        let activePage = page;
        const results = await applyEachBuiltInLook(page, async () => {
          const picture = await monitorPicture(activePage, ctx);
          const pixel = monitorPicturePoint(picture, 0.25, 0.2);
          let baselinePixel;
          return {
            pixel,
            readPreviewPixel: (target, p) => monitorPixel(target, p, ctx, 'D-K04'),
            waitForPreviewPixel: (target, p, _predicate, description) => {
              if (description === 'stable picture pixel') {
                return waitForColourPixel(target, p, ctx, 'D-K04', 'baseline').then((sample) => {
                  baselinePixel = sample;
                  return sample;
                });
              }
              if (description === 'colour edit to reach the Monitor') {
                return waitForColourPixel(target, p, ctx, 'D-K04', 'changed', baselinePixel);
              }
              if (description === 'Redo to restore the edited Monitor pixel') {
                return waitForMonitorPixel(
                  target,
                  p,
                  ctx,
                  'D-K04',
                  (sample) => pixelDistance(sample, baselinePixel) > MONITOR_PIXEL_TOLERANCE,
                  'Redo to restore the edited picture pixel',
                );
              }
              return waitForColourPixel(target, p, ctx, 'D-K04', 'restored', baselinePixel);
            },
            readGrade: () => readColourGrade(ctx, clipId),
            edit: async () => {},
            saveAndReopen: async () => {
              const result = await saveAndReopen(activePage, ctx, 'D-K04', clipId);
              activePage = ctx.page;
              return result;
            },
            undo: async () => {
              await blurFocus(ctx.page);
              await ctx.page.keyboard.press('Control+KeyZ');
            },
            redo: async () => {
              await blurFocus(ctx.page);
              await ctx.page.keyboard.press('Control+KeyY');
            },
            compareExportFrame: (_target, p) => compareExport(ctx.page, p, ctx, 'D-K04'),
            getPage: async () => {
              activePage = ctx.page;
              await openColorPanel(activePage, 'looks');
              return activePage;
            },
          };
        });
        return {
          message: `checked ${results.length} built-in Looks through preview, export, save/reopen, Undo and Redo`,
        };
      });
    },
  },
]);

export const COLOR_MATRIX_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(COLOR_MATRIX_ROWS.map((row) => [row.id, row])),
);
