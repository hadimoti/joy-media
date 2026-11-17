/** T-A09 desktop persistence and missing-media rows. */
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  normalizeDocument,
  readProjectIds,
  readLiveTimeline,
  rowsById,
  stableStringify,
  waitForImportedProject,
} from './matrix-core.mjs';
import { openMenu } from './steps.mjs';

const PROJECT_IMPORT_INPUT = 'input[type="file"][accept*="joyproject"]';
const MEDIA_FILE = 'h264-16x9-audio.mp4';

async function exportPackage(page, ctx) {
  const dir = ctx.downloadDir;
  if (!dir) throw new Error('the scratch download folder is not available');
  const listed = () =>
    new Map(
      readdirSync(dir)
        .filter((name) => name.endsWith('.joyproject.json'))
        .map((name) => [name, statSync(join(dir, name)).mtimeMs]),
    );
  const before = listed();
  await openMenu(page, 'File');
  await page.getByRole('menuitem', { name: /Export Editable Project/u }).click();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const found = [...listed()].find(
      ([name, mtime]) => before.get(name) !== mtime && statSync(join(dir, name)).size > 0,
    );
    if (found !== undefined) return join(dir, found[0]);
    await page.waitForTimeout(500);
  }
  throw new Error('no editable project file was written to the scratch download folder');
}

async function importPackage(page, file) {
  const previous = await readProjectIds(page);
  await page.locator(PROJECT_IMPORT_INPUT).setInputFiles(file);
  await waitForImportedProject(page, previous.active);
}

async function openMissingMediaReview(page) {
  const importButton = page.getByRole('button', { name: 'Import media', exact: true }).first();
  if (!(await importButton.isVisible().catch(() => false))) {
    await openMenu(page, 'View');
    await page.getByRole('menuitem', { name: 'Create', exact: true }).click();
  }
  await page
    .getByRole('region', { name: 'Missing media' })
    .getByRole('button', { name: 'Review', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Missing media', exact: true }).waitFor({
    state: 'visible',
  });
}

async function waitForDocument(page, ctx, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await ctx.readDocument(page);
    if (normalizeDocument(current.document) === normalizeDocument(expected)) return current;
    await page.waitForTimeout(100);
  }
  throw new Error('the project document did not reach the expected state');
}

function compositionContent(document, storedDocument) {
  // The stored visual document of the desktop bridge lists no assets table (found live), so the asset ids a package
  // import remaps cannot be resolved to names: every asset link is then compared as "has an asset" only.
  const assets = storedDocument?.assets;
  const named = (value) => {
    if (Array.isArray(value)) return value.map(named);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'projectId')
        .map(([key, item]) => [
          key,
          key === 'assetId' && typeof item === 'string'
            ? assets === undefined
              ? 'ASSET-LINK'
              : (assets[item]?.displayName ?? `MISSING:${item}`)
            : named(item),
        ]),
    );
  };
  return Object.fromEntries(
    Object.entries(document.compositions ?? {}).map(([id, composition]) => [
      id,
      named({ tracks: composition.tracks, clips: composition.clips }),
    ]),
  );
}

async function importWithMissingMedia(page, ctx, rowId) {
  const exportedPath = await exportPackage(page, ctx);
  const pkg = JSON.parse(await readFile(exportedPath, 'utf8'));
  pkg.media = pkg.media.map((entry) => {
    if (entry.asset.displayName !== MEDIA_FILE) return entry;
    const { dataBase64: _dataBase64, ...withoutData } = entry;
    return { ...withoutData, status: 'missing', missingReason: 'unavailable' };
  });
  if (!pkg.media.some((entry) => entry.asset.displayName === MEDIA_FILE)) {
    throw new Error(`exported package does not contain ${MEDIA_FILE}`);
  }
  const missingPath = join(ctx.outDir, rowId, 'missing-media.joyproject.json');
  await mkdir(join(ctx.outDir, rowId), { recursive: true });
  await writeFile(missingPath, JSON.stringify(pkg), 'utf8');
  await importPackage(page, missingPath);
  await openMissingMediaReview(page);
  return page.getByLabel(`Relink ${MEDIA_FILE}`);
}

const rows = [];

rows.push({
  id: 'D-A09-01',
  area: 'Save and restart',
  title: 'Save an edit, restart on the same profile, and compare the document',
  severity: 'major',
  expected: 'The reopened project has the same document as it had after saving',
  async run(page, ctx) {
    await ctx.editDocument(page);
    const before = await ctx.readDocument(page);
    // Project document edits are persisted as they are made; allow the write to settle before relaunch.
    await page.waitForTimeout(1_000);
    const session = await ctx.restartApp();
    const projectHeading = session.page.getByRole('heading', { name: 'Projects', exact: true });
    if (await projectHeading.isVisible().catch(() => false)) {
      const ids = await readProjectIds(session.page);
      if (!ids.title) throw new Error('BLOCKED D-A09-01: the saved project title is unavailable');
      await session.page.locator('.project-library-card', { hasText: ids.title }).first().click();
    }
    const deadline = Date.now() + 10_000;
    let reopenedLive = null;
    while (Date.now() < deadline) {
      const live = await readLiveTimeline(session.page).catch(() => null);
      const ids = await readProjectIds(session.page);
      if (live !== null && live.id === ids.active) {
        reopenedLive = live;
        break;
      }
      await session.page.waitForTimeout(100);
    }
    if (reopenedLive === null) {
      throw new Error('BLOCKED D-A09-01: the reopened project timeline did not become available');
    }
    const reopened = { document: reopenedLive };
    if (normalizeDocument(reopened.document) !== normalizeDocument(before.document)) {
      throw new Error(
        'the document differs after closing and relaunching on the same scratch profile',
      );
    }
    return {
      message: `document ${before.projectId} matches after close and same-profile relaunch`,
      evidence: [await ctx.shot('D-A09-01', 'reopened')],
    };
  },
});

rows.push({
  id: 'D-A09-02',
  area: 'Process recovery',
  title: 'Kill the process during an edit and reopen the project',
  severity: 'major',
  expected:
    'The process can be killed during an edit and the project reopens with a readable document',
  async run(page, ctx) {
    if (typeof ctx.killApp !== 'function') {
      throw new Error('BLOCKED D-A09-02: the live QA harness has no process-kill control');
    }
    await ctx.editDocument(page);
    const before = await ctx.readDocument(page);
    // Let the last write settle (JOY_QA_KILL_WAIT_MS, default 6 s), then pull the plug with no clean shutdown.
    await page.waitForTimeout(Number(process.env.JOY_QA_KILL_WAIT_MS ?? 6_000));
    const session = await ctx.killApp();
    const projectHeading = session.page.getByRole('heading', { name: 'Projects', exact: true });
    if (await projectHeading.isVisible().catch(() => false)) {
      const ids = await readProjectIds(session.page);
      if (!ids.title) throw new Error('BLOCKED D-A09-02: the saved project title is unavailable');
      await session.page.locator('.project-library-card', { hasText: ids.title }).first().click();
    }
    const deadline = Date.now() + 15_000;
    let reopened = null;
    while (Date.now() < deadline) {
      const live = await readLiveTimeline(session.page).catch(() => null);
      const ids = await readProjectIds(session.page);
      if (live !== null && live.id === ids.active) {
        reopened = live;
        break;
      }
      await session.page.waitForTimeout(100);
    }
    if (reopened === null) throw new Error('the project did not reopen after the kill');
    if (normalizeDocument(reopened) !== normalizeDocument(before.document)) {
      throw new Error(
        `the document after the kill differs from the document before it (clips before ${JSON.stringify(before.document).match(/"clips":\[/g)?.length ?? 0}, text sizes ${JSON.stringify(before.document).length} against ${JSON.stringify(reopened).length})`,
      );
    }
    return {
      message: `app killed hard after an edit; project ${before.projectId} reopened with the same document`,
      evidence: [await ctx.shot('D-A09-02', 'reopened-after-kill')],
    };
  },
});

rows.push({
  id: 'D-A09-03',
  area: 'Editable project package',
  title: 'Export and import an editable project package',
  severity: 'major',
  expected:
    'Export Editable Project followed by Import Editable Project restores the same document',
  async run(page, ctx) {
    await ctx.editDocument(page);
    const before = await ctx.readDocument(page);
    const exportedPath = await exportPackage(page, ctx);
    await importPackage(page, exportedPath);
    const imported = await ctx.readDocument(page);
    if (
      stableStringify(compositionContent(imported.document, imported.storedDocument)) !==
      stableStringify(compositionContent(before.document, before.storedDocument))
    ) {
      throw new Error('the imported editable project does not match the exported document');
    }
    return {
      message: `editable package for ${before.projectId} imported with the same document`,
      evidence: [await ctx.shot('D-A09-03', 'imported')],
    };
  },
});

rows.push({
  id: 'D-A09-04',
  area: 'Missing media',
  title: 'Strip a media entry, import the project, and relink to the same file',
  severity: 'major',
  expected:
    'The same file relinks successfully and the restored original appears in the Media list',
  async run(page, ctx) {
    await ctx.editDocument(page);
    const relink = await importWithMissingMedia(page, ctx, 'D-A09-04');
    await relink.setInputFiles(join(ctx.fixtures, MEDIA_FILE));
    await page.getByRole('status').getByText(`Relinked ${MEDIA_FILE}.`, { exact: true }).waitFor({
      state: 'visible',
    });
    await page.getByRole('button', { name: 'Close missing media', exact: true }).click();
    await page.getByRole('tab', { name: 'Media', exact: true }).click();
    await page
      .locator('.asset-card', { hasText: MEDIA_FILE })
      .first()
      .waitFor({ state: 'visible' });
    return {
      message: `${MEDIA_FILE} relinked and shown in the Media list`,
      evidence: [await ctx.shot('D-A09-04', 'relinked')],
    };
  },
});

rows.push({
  id: 'D-A09-05',
  area: 'Missing media',
  title: 'Refuse a different relink file, try Use different file and Undo, then cancel the picker',
  severity: 'major',
  expected:
    'A different file is refused, Use different file is undoable, and cancelling leaves the relink unchanged',
  async run(page, ctx) {
    await ctx.editDocument(page);
    const relink = await importWithMissingMedia(page, ctx, 'D-A09-05');
    const importedBaseline = await ctx.readDocument(page);
    await relink.setInputFiles(join(ctx.fixtures, 'picture-1080.jpg'));
    const warning = page.getByRole('alert').filter({
      hasText: /different size from the original|does not match the original checksum/u,
    });
    await warning.waitFor({ state: 'visible' });
    const refused = await ctx.readDocument(page);
    if (normalizeDocument(refused.document) !== normalizeDocument(importedBaseline.document)) {
      throw new Error('the refused different file changed the imported project document');
    }
    const useDifferent = page.getByLabel(`Use a different file for ${MEDIA_FILE}`);
    await useDifferent.setInputFiles(join(ctx.fixtures, 'picture-1080.jpg'));
    await page
      .getByRole('status')
      .getByText(/is now a separate asset/u)
      .waitFor({
        state: 'visible',
      });
    const overridden = await ctx.readDocument(page);
    if (normalizeDocument(overridden.document) === normalizeDocument(importedBaseline.document)) {
      throw new Error('using a different file did not change the imported project document');
    }
    await page.getByRole('button', { name: 'Close missing media', exact: true }).click();
    await ctx.undo(page);
    await waitForDocument(page, ctx, importedBaseline.document);
    await openMissingMediaReview(page);
    await relink.setInputFiles([]);
    await page.getByRole('button', { name: 'Close missing media', exact: true }).click();
    const after = await ctx.readDocument(page);
    if (normalizeDocument(after.document) !== normalizeDocument(importedBaseline.document)) {
      throw new Error('cancelling the relink changed the project document');
    }
    return {
      message:
        'different-file relink was refused, override was undone, and cancellation kept the document',
      evidence: [await ctx.shot('D-A09-05', 'cancelled')],
    };
  },
});

export const PERSISTENCE_ROWS = Object.freeze(rows);
export const PERSISTENCE_ROWS_BY_ID = Object.freeze(rowsById(rows));
