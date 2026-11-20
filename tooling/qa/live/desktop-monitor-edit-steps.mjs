/* global document, navigator */
/** Isolated live Monitor editing rows for T-M07. */
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readLiveVisualProject } from './matrix-core.mjs';
import { labRoots } from './lab-roots.mjs';
import {
  addToTimelineThroughLeftPanel,
  importThroughLeftPanel,
  newProject,
  openMenu,
} from './steps.mjs';

const LAB = labRoots();

export const M07_TITLE_TEXT = Object.freeze({
  english: 'T-M07 English edited in place',
  persian: 'عنوان فارسی ویرایش‌شده',
});

const SETTLE_TIMEOUT_MS = 5_000;
const IMAGE_ROW_IDS = new Set(['D-M07-03', 'D-M07-04', 'D-M07-05', 'D-M07-06', 'D-M07-09']);
const VIDEO_ROW_IDS = new Set(['D-M07-10']);
const MEDIA_ROW_IDS = new Set([...IMAGE_ROW_IDS, ...VIDEO_ROW_IDS, 'D-M07-07', 'D-M07-08']);

export function readTextValue(textDocument) {
  return (textDocument?.blocks ?? [])
    .flatMap((block) => block.runs ?? [])
    .map((run) => run.text ?? '')
    .join('');
}

export function cropHandleSelector(edge) {
  if (!['top', 'right', 'bottom', 'left'].includes(edge))
    throw new Error(`unknown crop handle: ${edge}`);
  return `[data-crop-handle="${edge}"]`;
}

export function scratchLibraryAssetPath(libraryDir, assetId, assetKind) {
  if (!/^joylib-[a-f0-9]{64}$/u.test(assetId))
    throw new Error('asset ID is not a scratch library entry');
  if (assetKind !== 'image' && assetKind !== 'video')
    throw new Error(`unsupported scratch library asset kind: ${assetKind}`);
  const root = resolve(LAB.scratch, 'libraries');
  const runDir = resolve(libraryDir);
  const relativeRunDir = relative(root, runDir);
  if (
    !relativeRunDir ||
    relativeRunDir === '..' ||
    relativeRunDir.startsWith(`..${sep}`) ||
    relativeRunDir.includes(sep) ||
    isAbsolute(relativeRunDir)
  )
    throw new Error('library directory is outside the scratch library root');
  const folder = assetKind === 'image' ? 'images' : 'video';
  return join(runDir, folder, assetId);
}

function waitForVisual(page, predicate, rowId, message) {
  return page.waitForFunction(
    async ({ expectedRow, expectedMessage }) => {
      const root = document.getElementById('root');
      const key = root && Object.keys(root).find((name) => name.startsWith('__reactContainer'));
      if (!key) return false;
      const seen = new Set();
      const stack = [root[key]];
      while (stack.length > 0) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        for (const state of [fiber.memoizedProps, fiber.memoizedState]) {
          const session = state?.session ?? state?.context?.session;
          const visual = session?.visualProject;
          if (visual?.visualObjects) {
            const objects = Object.values(visual.visualObjects);
            if (expectedRow === 'title') {
              if (
                objects.some((object) => object?.kind === 'text' && object.text === expectedMessage)
              )
                return true;
            }
            if (expectedRow === 'crop') {
              if (objects.some((object) => object?.transform?.crop?.left > 0.02)) return true;
            }
          }
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      return false;
    },
    { expectedRow: rowId, expectedMessage: message },
    { timeout: SETTLE_TIMEOUT_MS, polling: 100 },
  );
}

async function visualProject(page, rowId) {
  const project = await readLiveVisualProject(page);
  if (!project?.visualObjects) throw new Error(`${rowId}: the live visual project is unavailable`);
  return project;
}

async function mediaObject(page, rowId) {
  const project = await visualProject(page, rowId);
  const candidates = Object.values(project.visualObjects).filter(
    (object) =>
      object &&
      object.assetId &&
      object.transform &&
      (object.kind === 'image' || object.kind === 'null'),
  );
  if (candidates.length === 0)
    throw new Error(`${rowId}: no image or video child exists in the document`);
  return { project, object: candidates[0] };
}

async function prepareMedia(page, ctx, rowId, expectedKind) {
  if (!ctx.media)
    throw new Error(
      `BLOCKED-on-fixture ${rowId}: needs --media <picture or video in the fixtures folder>`,
    );
  const file = basename(ctx.media).toLowerCase();
  const isVideo = /\.(mp4|webm|mov|m4v)$/u.test(file);
  if (expectedKind === 'image' && isVideo)
    throw new Error(`${rowId}: expected a still picture fixture, received ${basename(ctx.media)}`);
  if (expectedKind === 'video' && !isVideo)
    throw new Error(`${rowId}: expected a video fixture, received ${basename(ctx.media)}`);
  await newProject(page, `Monitor edit ${rowId} ${ctx.runTag ?? 'run'}`);
  await importThroughLeftPanel(page, ctx.media);
  await addToTimelineThroughLeftPanel(page, ctx.media);
  await page.locator('.timeline-clip').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.timeline-clip').first().click();
  await page
    .locator('.monitor-selection-overlay polygon[data-clip-id]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  return mediaObject(page, rowId);
}

async function openInspector(page) {
  const field = page.locator('#insp-rotationDeg').first();
  if (!(await field.isVisible().catch(() => false))) {
    await openMenu(page, 'View');
    await page.getByRole('menuitem', { name: 'Inspector', exact: true }).click();
  }
  await field.waitFor({ state: 'visible', timeout: 5_000 });
}

async function setTransform(page, rowId, values) {
  await openInspector(page);
  for (const [key, value] of Object.entries(values)) {
    const field = page.locator(`#insp-${key}`).first();
    await field.fill(String(value));
    await field.press('Enter');
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let current;
  while (Date.now() < deadline) {
    current = await mediaObject(page, rowId);
    if (
      Object.entries(values).every(
        ([key, value]) => Math.abs(current.object.transform[key] - value) < 0.02,
      )
    )
      return current;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `${rowId}: Inspector values did not reach the document (${JSON.stringify(values)})`,
  );
}

async function rightClickSelected(page, rowId) {
  const outline = page.locator('.monitor-selection-overlay polygon[data-clip-id]').first();
  const box = await outline.boundingBox();
  if (!box) throw new Error(`${rowId}: selected child has no Monitor outline`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.locator('.timeline-context-menu').waitFor({ state: 'visible', timeout: 5_000 });
}

async function clickContextItem(page, rowId, label) {
  const item = page.getByRole('menuitem', { name: label, exact: true });
  await item.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {
    throw new Error(`${rowId}: right-click menu did not show ${label}`);
  });
  if (!(await item.isEnabled()))
    throw new Error(`${rowId}: ${label} is disabled in the right-click menu`);
  await item.click();
}

async function createTitle(page, ctx, rowId, text) {
  await newProject(page, `Monitor title ${rowId} ${ctx.runTag ?? 'run'}`);
  const textPanel = page.getByRole('tab', { name: 'Text', exact: true }).first();
  if (await textPanel.isVisible().catch(() => false)) await textPanel.click();
  await page.getByRole('button', { name: 'Add Clean Title', exact: true }).click();
  const outline = page.locator('.monitor-selection-overlay polygon[data-clip-id]').first();
  await outline.waitFor({ state: 'visible', timeout: 10_000 });
  const box = await outline.boundingBox();
  if (!box) throw new Error(`${rowId}: the new title has no Monitor outline`);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const editor = page.getByRole('textbox', { name: 'Edit text on Monitor', exact: true });
  await editor.waitFor({ state: 'visible', timeout: 5_000 });
  await editor.fill(text);
  await editor.press('Escape');
  await waitForVisual(page, 'title', rowId, text);
  const project = await visualProject(page, rowId);
  const saved = Object.values(project.visualObjects).find(
    (object) => object?.kind === 'text' && object.text === text,
  );
  if (!saved || readTextValue(saved.textDocument) !== text)
    throw new Error(`${rowId}: the document text did not exactly match the text entered in place`);
  return `typed and saved exact document text ${JSON.stringify(text)}`;
}

async function cropCurrentChild(page, ctx, rowId, expectedKind) {
  const before = await prepareMedia(page, ctx, rowId, expectedKind);
  await rightClickSelected(page, rowId);
  await clickContextItem(page, rowId, 'Crop');
  const box = page.locator('.monitor-crop-box');
  await box.waitFor({ state: 'visible', timeout: 5_000 });
  const handles = box.locator('[data-crop-handle]');
  if ((await handles.count()) !== 4)
    throw new Error(`${rowId}: crop mode did not show four edge handles`);
  const left = box.locator(cropHandleSelector('left'));
  const handleBox = await left.boundingBox();
  if (!handleBox) throw new Error(`${rowId}: the left crop handle has no screen position`);
  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y, { steps: 8 });
  await page.mouse.up();
  await box.getByRole('button', { name: 'Done', exact: true }).click();
  await waitForVisual(page, 'crop', rowId, '');
  const after = await mediaObject(page, rowId);
  if (!(after.object.transform.crop.left > before.object.transform.crop.left + 0.02))
    throw new Error(`${rowId}: crop drag did not commit a larger left crop to the document`);
  return `left crop committed as ${after.object.transform.crop.left}`;
}

async function clearSelectedAssetCache(page, ctx, rowId, assetId, assetKind) {
  const settings = await ctx.bridge.invoke('desktop.asset-library.get-settings');
  if (resolve(settings?.directory ?? '').toLowerCase() !== resolve(ctx.libraryDir).toLowerCase())
    throw new Error(`${rowId}: the app is not bound to this run's scratch library`);
  const fixtureHash = createHash('sha256')
    .update(await readFile(ctx.media))
    .digest('hex');
  if (assetId !== `joylib-${fixtureHash}`)
    throw new Error(`${rowId}: imported asset ID does not match the supplied fixture`);
  const libraryPath = scratchLibraryAssetPath(ctx.libraryDir, assetId, assetKind);
  const storedHash = createHash('sha256')
    .update(await readFile(libraryPath))
    .digest('hex');
  if (assetId !== `joylib-${storedHash}`)
    throw new Error(`${rowId}: scratch library file does not match its content-addressed ID`);
  await unlink(libraryPath);
  const catalogRemoval = await ctx.bridge.invoke('desktop.asset-library.remove-entry', {
    id: assetId,
  });
  if (catalogRemoval?.removed !== true)
    throw new Error(`${rowId}: the asset was not removed from the scratch library catalog`);
  const removed = await page.evaluate(async (id) => {
    const notFound = (error) => error?.name === 'NotFoundError';
    let directory;
    try {
      const root = await navigator.storage.getDirectory();
      directory = await root.getDirectoryHandle('joy-media-assets', { create: false });
    } catch (error) {
      if (notFound(error)) return true;
      throw error;
    }
    try {
      await directory.removeEntry(`${id}.bin`);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    try {
      await directory.getFileHandle(`${id}.bin`, { create: false });
      return false;
    } catch (error) {
      return notFound(error);
    }
  }, assetId);
  if (!removed) throw new Error(`${rowId}: scratch profile OPFS still contains the source bytes`);
}

function row(id, title, expected, run) {
  return {
    id,
    area: 'Monitor text, crop and context menu',
    title,
    severity: 'major',
    expected,
    run,
  };
}

export const MONITOR_EDIT_ROWS = Object.freeze([
  row(
    'D-M07-01',
    'Edit an English title in place',
    'the typed English text equals the saved document text',
    async (page, ctx) => ({
      message: await createTitle(page, ctx, 'D-M07-01', M07_TITLE_TEXT.english),
      evidence: [await ctx.shot('D-M07-01', 'document-text')],
    }),
  ),
  row(
    'D-M07-02',
    'Edit a Persian title in place',
    'the typed Persian text equals the saved document text',
    async (page, ctx) => ({
      message: await createTitle(page, ctx, 'D-M07-02', M07_TITLE_TEXT.persian),
      evidence: [await ctx.shot('D-M07-02', 'document-text')],
    }),
  ),
  row(
    'D-M07-03',
    'Right-click Fit to frame',
    'Fit to frame applies to a picture and changes its saved transform',
    async (page, ctx) => {
      await prepareMedia(page, ctx, 'D-M07-03', 'image');
      const initial = await setTransform(page, 'D-M07-03', { scaleX: 0.37, scaleY: 0.37 });
      await rightClickSelected(page, 'D-M07-03');
      await clickContextItem(page, 'D-M07-03', 'Fit to frame');
      const after = await mediaObject(page, 'D-M07-03');
      if (Math.abs(after.object.transform.scaleX - initial.object.transform.scaleX) < 0.01)
        throw new Error('Fit to frame did not change the saved picture scale');
      return {
        message: `Fit to frame changed scale from ${initial.object.transform.scaleX} to ${after.object.transform.scaleX}`,
        evidence: [await ctx.shot('D-M07-03', 'fit')],
      };
    },
  ),
  row(
    'D-M07-04',
    'Right-click Fill frame',
    'Fill frame applies to a picture and changes its saved transform',
    async (page, ctx) => {
      await prepareMedia(page, ctx, 'D-M07-04', 'image');
      const initial = await setTransform(page, 'D-M07-04', { scaleX: 0.37, scaleY: 0.37 });
      await rightClickSelected(page, 'D-M07-04');
      await clickContextItem(page, 'D-M07-04', 'Fill frame');
      const after = await mediaObject(page, 'D-M07-04');
      if (Math.abs(after.object.transform.scaleX - initial.object.transform.scaleX) < 0.01)
        throw new Error('Fill frame did not change the saved picture scale');
      return {
        message: `Fill frame changed scale from ${initial.object.transform.scaleX} to ${after.object.transform.scaleX}`,
        evidence: [await ctx.shot('D-M07-04', 'fill')],
      };
    },
  ),
  row(
    'D-M07-05',
    'Right-click Crop',
    'Crop opens the crop outline and four edge handles',
    async (page, ctx) => {
      await prepareMedia(page, ctx, 'D-M07-05', 'image');
      await rightClickSelected(page, 'D-M07-05');
      await clickContextItem(page, 'D-M07-05', 'Crop');
      const box = page.locator('.monitor-crop-box');
      await box.waitFor({ state: 'visible', timeout: 5_000 });
      const count = await box.locator('[data-crop-handle]').count();
      if (count !== 4) throw new Error(`Crop opened with ${count} handles, expected four`);
      await page.keyboard.press('Escape');
      return {
        message: 'Crop opened with four edge handles',
        evidence: [await ctx.shot('D-M07-05', 'crop-mode')],
      };
    },
  ),
  row(
    'D-M07-06',
    'Right-click Relink',
    'Relink opens the missing-media review for a missing source',
    async (page, ctx) => {
      const { object, project } = await prepareMedia(page, ctx, 'D-M07-06', 'image');
      if (!object.assetId) throw new Error('the imported picture has no asset ID');
      const assetKind = project.assets[object.assetId]?.kind;
      await clearSelectedAssetCache(page, ctx, 'D-M07-06', object.assetId, assetKind);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.timeline-clip').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('.timeline-clip').first().click();
      await page.locator('.monitor-selection-overlay polygon[data-clip-id]').first().waitFor({
        state: 'visible',
        timeout: 15_000,
      });
      await rightClickSelected(page, 'D-M07-06');
      await clickContextItem(page, 'D-M07-06', 'Relink');
      const dialog = page.getByRole('dialog', { name: 'Missing media', exact: true });
      await dialog.waitFor({ state: 'visible', timeout: 8_000 });
      await dialog.locator(`[data-missing-asset-id="${object.assetId}"]`).waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return {
        message: 'Relink opened Missing media review for the scratch-profile source',
        evidence: [await ctx.shot('D-M07-06', 'relink')],
      };
    },
  ),
  row(
    'D-M07-07',
    'Centre a rotated child',
    'Centre changes position and preserves the child rotation',
    async (page, ctx) => {
      await prepareMedia(page, ctx, 'D-M07-07', 'image');
      const before = await setTransform(page, 'D-M07-07', { x: 620, y: 240, rotationDeg: 27 });
      await rightClickSelected(page, 'D-M07-07');
      await clickContextItem(page, 'D-M07-07', 'Centre');
      const after = await mediaObject(page, 'D-M07-07');
      if (Math.abs(after.object.transform.rotationDeg - 27) > 0.5)
        throw new Error(`Centre changed rotation to ${after.object.transform.rotationDeg}`);
      if (Math.abs(after.object.transform.x - before.object.transform.x) < 1)
        throw new Error('Centre did not change the rotated child position');
      return {
        message: `Centre moved the child while preserving ${after.object.transform.rotationDeg} degrees`,
        evidence: [await ctx.shot('D-M07-07', 'centred')],
      };
    },
  ),
  row(
    'D-M07-08',
    'Reset a rotated child',
    'Reset transform returns the child rotation to zero',
    async (page, ctx) => {
      await prepareMedia(page, ctx, 'D-M07-08', 'image');
      await setTransform(page, 'D-M07-08', { x: 620, y: 240, rotationDeg: 27 });
      await rightClickSelected(page, 'D-M07-08');
      await clickContextItem(page, 'D-M07-08', 'Reset transform');
      const after = await mediaObject(page, 'D-M07-08');
      if (Math.abs(after.object.transform.rotationDeg) > 0.5)
        throw new Error(`Reset transform left rotation at ${after.object.transform.rotationDeg}`);
      return {
        message: `Reset transform returned rotation to ${after.object.transform.rotationDeg}`,
        evidence: [await ctx.shot('D-M07-08', 'reset')],
      };
    },
  ),
  row(
    'D-M07-09',
    'Commit a cropped picture',
    'a left-edge crop is committed to the picture document',
    async (page, ctx) => ({
      message: await cropCurrentChild(page, ctx, 'D-M07-09', 'image'),
      evidence: [await ctx.shot('D-M07-09', 'cropped-picture')],
    }),
  ),
  row(
    'D-M07-10',
    'Commit a cropped video clip',
    'a left-edge crop is committed to the video child document',
    async (page, ctx) => ({
      message: await cropCurrentChild(page, ctx, 'D-M07-10', 'video'),
      evidence: [await ctx.shot('D-M07-10', 'cropped-video')],
    }),
  ),
]);

export const MONITOR_EDIT_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(MONITOR_EDIT_ROWS.map((item) => [item.id, item])),
);

export function isMonitorEditMediaRow(id) {
  return MEDIA_ROW_IDS.has(id);
}
