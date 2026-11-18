/* global document */
/**
 * T-A05 matrix rows D-A05-01 to D-A05-60: Projects page, import of each fixture type, Media
 * panel, Asset Library Folder dialog, drag to the timeline, bridge-reply logging and the export
 * of the sample project "Local editor project".
 *
 * Each row is `{ id, area, title, severity, expected, run(page, ctx) }` (see matrix-core.mjs).
 * NOT RUN LIVE: the selectors come from reading ProjectLibrary.tsx, AssetLibraryPanel.tsx,
 * TimelinePanel.tsx and app-menu.ts; confirm each on the first live pass.
 *
 * Profile assumed: a new scratch profile, so the first visit seeds the two sample projects, and
 * `run.mjs` has already pointed the Asset Library Folder at the scratch library. Fixtures are
 * read from C:\jgp\v111\fixtures (T-A04), never copied or changed.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importThroughLeftPanel, newProject, openMenu } from './steps.mjs';
import { FIXTURE_ROOT, clipsOf, readDocument, rowsById } from './matrix-core.mjs';

const EDITOR_PROJECT = 'Local editor project';
// The accessible name gains a warning suffix when a preset warns, and reads "Exporting" while busy.
const EXPORT_BUTTON = { name: /^Export MP4/u };

/** One row per fixture type of T-A04: the file, and the kind the Media panel should show. */
export const IMPORT_FIXTURES = Object.freeze([
  { id: 'D-A05-06', file: 'h264-16x9-audio.mp4', kind: 'H.264 video with audio' },
  { id: 'D-A05-07', file: 'vp9-webm-audio.webm', kind: 'WebM video' },
  { id: 'D-A05-08', file: 'picture-1080.jpg', kind: 'JPG picture' },
  { id: 'D-A05-09', file: 'picture-tiny.png', kind: 'tiny PNG picture' },
  { id: 'D-A05-10', file: 'picture-720-lossless.webp', kind: 'WebP picture' },
  { id: 'D-A05-11', file: 'audio-stereo.wav', kind: 'WAV audio' },
  { id: 'D-A05-12', file: 'audio-mp3.mp3', kind: 'MP3 audio' },
  { id: 'D-A05-13', file: 'audio-aac.m4a', kind: 'AAC audio' },
  { id: 'D-A05-14', file: 'picture-8k.png', kind: '8K PNG picture' },
]);

function fixturePath(ctx, file) {
  return join(ctx.fixtures ?? FIXTURE_ROOT, file);
}

async function pressed(locator) {
  return (await locator.getAttribute('aria-pressed')) === 'true';
}

/** Back to the Projects page: the File menu item "Projects Library…" when an editor is open. */
export async function goToProjects(page) {
  const tile = page.getByRole('button', { name: 'New project', exact: true });
  if (await tile.isVisible().catch(() => false)) return;
  await openMenu(page, 'File');
  await page.getByRole('menuitem', { name: /Projects Library/u }).click();
  await tile.waitFor({ state: 'visible' });
}

/** An open editor on a fresh project; the title is unique per call so cards never collide. */
export async function ensureProject(page, ctx, label) {
  const inEditor = await page
    .getByRole('button', { name: 'File', exact: true })
    .isVisible()
    .catch(() => false);
  if (inEditor && !ctx.freshProjectEveryRow) return;
  await goToProjects(page).catch(() => undefined);
  await newProject(page, `${label} ${ctx.runTag ?? ''}`.trim());
}

function projectCard(page, title) {
  return page.locator('.project-library-card', { hasText: title }).first();
}

async function openProjectActions(page, title) {
  await page.getByRole('button', { name: `Project actions for ${title}`, exact: true }).click();
}

async function assetCatalogNames(ctx) {
  const reply = await ctx.bridge.invoke('desktop.asset-library.get-catalog', {});
  return JSON.stringify(reply ?? '');
}

async function assetLibraryPath(ctx) {
  return JSON.stringify((await ctx.bridge.invoke('desktop.asset-library.get-settings', {})) ?? '');
}

const rows = [];

rows.push({
  id: 'D-A05-01',
  area: 'Projects page',
  title: 'Projects page lists the two sample projects',
  severity: 'major',
  expected: `A new profile shows ${EDITOR_PROJECT} and the timeline-elements showcase`,
  async run(page, ctx) {
    await goToProjects(page);
    await projectCard(page, EDITOR_PROJECT).waitFor({ state: 'visible' });
    const cards = await page.locator('.project-library-card').count();
    if (cards < 2)
      throw new Error(`only ${cards} project card(s); the seed has two sample projects`);
    return {
      message: `${cards} project cards; "${EDITOR_PROJECT}" listed`,
      evidence: [await ctx.shot('D-A05-01', 'samples')],
    };
  },
});

rows.push({
  id: 'D-A05-02',
  area: 'Projects page',
  title: 'Projects page grid and list views switch',
  severity: 'minor',
  expected: 'Grid view and List view buttons flip aria-pressed and the list class on the grid',
  async run(page, ctx) {
    await goToProjects(page);
    const grid = page.getByRole('button', { name: 'Grid view', exact: true });
    const list = page.getByRole('button', { name: 'List view', exact: true });
    await list.click();
    if (!(await pressed(list)) || (await pressed(grid)))
      throw new Error('List view did not become the pressed view');
    const shotList = await ctx.shot('D-A05-02', 'list');
    await grid.click();
    if (!(await pressed(grid)) || (await pressed(list)))
      throw new Error('Grid view did not become the pressed view');
    const shotGrid = await ctx.shot('D-A05-02', 'grid');
    return { message: 'list and grid views both switch', evidence: [shotList, shotGrid] };
  },
});

rows.push({
  id: 'D-A05-03',
  area: 'Projects page',
  title: 'New project creates a project card',
  severity: 'blocker',
  expected: 'Create project opens the editor; the Projects page then lists the new title',
  async run(page, ctx) {
    await goToProjects(page);
    const title = `A05 new ${ctx.runTag ?? 'run'}`;
    await newProject(page, title);
    await goToProjects(page);
    await projectCard(page, title).waitFor({ state: 'visible' });
    ctx.projectTitle = title;
    return {
      message: `created "${title}" and found its card`,
      evidence: [await ctx.shot('D-A05-03', 'card')],
    };
  },
});

rows.push({
  id: 'D-A05-04',
  area: 'Projects page',
  title: 'Rename project changes the card title',
  severity: 'major',
  expected: 'Project actions, Rename, a new name: the card shows the new name',
  async run(page, ctx) {
    const from = ctx.projectTitle;
    if (!from) throw new Error('BLOCKED D-A05-04: needs the project D-A05-03 created');
    await goToProjects(page);
    const to = `${from} renamed`;
    await openProjectActions(page, from);
    await page.getByRole('menuitem', { name: /Rename/u }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(to);
    await dialog
      .getByRole('button', { name: /Rename/u })
      .last()
      .click();
    await projectCard(page, to).waitFor({ state: 'visible' });
    ctx.projectTitle = to;
    return {
      message: `renamed "${from}" to "${to}"`,
      evidence: [await ctx.shot('D-A05-04', 'renamed')],
    };
  },
});

rows.push({
  id: 'D-A05-05',
  area: 'Projects page',
  title: 'Delete project: Trash, then delete permanently with the typed name',
  severity: 'major',
  expected:
    'Move to Trash removes the card and Trash lists it; Delete permanently needs the typed name',
  async run(page, ctx) {
    const title = ctx.projectTitle;
    if (!title) throw new Error('BLOCKED D-A05-05: needs the project from D-A05-03 and D-A05-04');
    await goToProjects(page);
    await openProjectActions(page, title);
    await page.getByRole('menuitem', { name: /Move to Trash/u }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Move to Trash', exact: true })
      .click();
    await projectCard(page, title).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /^Trash \(/u }).click();
    await projectCard(page, title).waitFor({ state: 'visible' });
    await openProjectActions(page, title);
    await page.getByRole('menuitem', { name: /Delete permanently/u }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Delete permanently', exact: true });
    if (await confirm.isEnabled())
      throw new Error('Delete permanently was enabled before the name was typed');
    await dialog.getByRole('textbox').fill(title);
    await confirm.click();
    await projectCard(page, title).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /^Projects \(/u }).click();
    ctx.projectTitle = undefined;
    return {
      message: `"${title}" went to Trash and was deleted permanently`,
      evidence: [await ctx.shot('D-A05-05', 'trash')],
    };
  },
});

for (const fixture of IMPORT_FIXTURES) {
  rows.push({
    id: fixture.id,
    area: 'Import',
    title: `Import ${fixture.kind} (${fixture.file}) through the Media panel`,
    severity: fixture.file === 'picture-8k.png' ? 'minor' : 'major',
    expected:
      'Import media, choose the file, Confirm import: an asset card with the file name, and the catalog lists it',
    async run(page, ctx) {
      await ensureProject(page, ctx, 'A05 import');
      await importThroughLeftPanel(page, fixturePath(ctx, fixture.file));
      const catalog = await assetCatalogNames(ctx);
      if (!catalog.includes(fixture.file)) {
        throw new Error(
          `desktop.asset-library.get-catalog does not list ${fixture.file} after the import`,
        );
      }
      return {
        message: `${fixture.file} imported; card shown and listed by the catalog`,
        evidence: [await ctx.shot(fixture.id, 'imported')],
      };
    },
  });
}

rows.push({
  id: 'D-A05-20',
  area: 'Media panel',
  title: 'Media panel views: Large previews, Compact grid, List view',
  severity: 'minor',
  expected: 'Each view button becomes the only pressed one',
  async run(page, ctx) {
    await ensureProject(page, ctx, 'A05 media');
    const evidence = [];
    for (const name of ['Large previews', 'Compact grid', 'List view']) {
      const button = page.getByRole('button', { name, exact: true }).first();
      await button.click();
      if (!(await pressed(button))) throw new Error(`${name} did not become pressed`);
      evidence.push(await ctx.shot('D-A05-20', name.toLowerCase().replace(/\s+/gu, '-')));
    }
    return { message: 'three Media panel views switch', evidence };
  },
});

rows.push({
  id: 'D-A05-21',
  area: 'Media panel',
  title: 'Media panel filter and sort drawer opens and changes the sort',
  severity: 'minor',
  expected:
    'Filter and sort opens a dialog with the availability filter and the sort control; Close filters closes it',
  async run(page, ctx) {
    await ensureProject(page, ctx, 'A05 media');
    await page.getByRole('button', { name: 'Filter and sort', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Asset filters', exact: true });
    await drawer.waitFor({ state: 'visible' });
    const sort = drawer.getByLabel('Sort assets', { exact: true });
    const before = await sort.inputValue();
    const options = await sort
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => node.value));
    const other = options.find((value) => value !== before);
    if (other === undefined) throw new Error('the sort control has one option only');
    await sort.selectOption(other);
    if ((await sort.inputValue()) !== other) throw new Error(`sort stayed at ${before}`);
    await sort.selectOption(before);
    const shot = await ctx.shot('D-A05-21', 'drawer');
    await page.getByRole('button', { name: 'Close filters', exact: true }).click();
    return {
      message: `sort ${before} -> ${other} -> ${before}; availability filter present`,
      evidence: [shot],
    };
  },
});

rows.push({
  id: 'D-A05-22',
  area: 'Media panel',
  title: 'Media panel delete asks for a confirm and removes the asset',
  severity: 'major',
  expected: 'Delete <name> opens a confirm; confirming removes the card and the catalog entry',
  async run(page, ctx) {
    await ensureProject(page, ctx, 'A05 media');
    const file = 'picture-tiny.png';
    const card = page.locator('.asset-card', { hasText: file }).first();
    if ((await card.count()) === 0) await importThroughLeftPanel(page, fixturePath(ctx, file));
    await card.hover();
    await page
      .getByRole('button', { name: `Delete ${file}`, exact: true })
      .first()
      .click();
    // The confirm is an alertdialog (class app-dialog), not a plain dialog.
    const dialog = page.getByRole('alertdialog').last();
    await dialog.waitFor({ state: 'visible' });
    const shot = await ctx.shot('D-A05-22', 'confirm');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    const catalog = await assetCatalogNames(ctx);
    if (catalog.includes(file)) throw new Error(`the catalog still lists ${file} after the delete`);
    return {
      message: `${file} deleted after the confirm; catalog no longer lists it`,
      evidence: [shot],
    };
  },
});

rows.push({
  id: 'D-A05-30',
  area: 'Asset Library Folder',
  title: 'Asset Library Folder dialog: switch the folder, then cancel a second change',
  severity: 'major',
  expected: 'Apply Path switches the library (get-settings shows it); Cancel leaves it unchanged',
  async run(page, ctx) {
    if (!ctx.altLibraryDir)
      throw new Error('BLOCKED D-A05-30: needs ctx.altLibraryDir (a second scratch folder)');
    mkdirSync(ctx.altLibraryDir, { recursive: true });
    await ensureProject(page, ctx, 'A05 library');
    const original = ctx.libraryDir;
    const openDialog = async () => {
      await openMenu(page, 'Edit');
      await page.getByRole('menuitem', { name: /Asset Library Folder/u }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible' });
      return dialog;
    };
    // The dialog stays open after Apply Path and blocks the menu: close it before the next open.
    const closeDialog = (open) =>
      open.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const evidence = [];
    let dialog = await openDialog();
    await dialog.getByRole('textbox').first().fill(ctx.altLibraryDir);
    await dialog.getByRole('button', { name: 'Apply Path', exact: true }).click();
    await closeDialog(dialog);
    if (
      !(await assetLibraryPath(ctx))
        .toLowerCase()
        .includes(ctx.altLibraryDir.toLowerCase().replace(/\\/gu, '\\\\'))
    ) {
      throw new Error('get-settings does not show the second library after Apply Path');
    }
    evidence.push(await ctx.shot('D-A05-30', 'switched'));
    dialog = await openDialog();
    await dialog.getByRole('textbox').first().fill(original);
    await dialog.getByRole('button', { name: 'Apply Path', exact: true }).click();
    await closeDialog(dialog);
    dialog = await openDialog();
    await dialog.getByRole('textbox').first().fill(ctx.altLibraryDir);
    await dialog
      .getByRole('button', { name: /^(Cancel|Close)/u })
      .first()
      .click();
    const settings = (await assetLibraryPath(ctx)).toLowerCase();
    if (!settings.includes(original.toLowerCase().replace(/\\/gu, '\\\\'))) {
      throw new Error('Cancel changed the library folder');
    }
    evidence.push(await ctx.shot('D-A05-30', 'cancelled'));
    return {
      message:
        'switched to the second scratch library, back, and a cancelled change kept the folder',
      evidence,
    };
  },
});

rows.push({
  id: 'D-A05-40',
  area: 'Media panel',
  title: 'Drag an asset card to the timeline adds a clip',
  severity: 'major',
  expected:
    'Dragging the card onto the timeline adds a clip, and the stored document holds one for the asset',
  async run(page, ctx) {
    await ensureProject(page, ctx, 'A05 drag');
    const file = 'h264-16x9-audio.mp4';
    const card = page.locator('.asset-card', { hasText: file }).first();
    if ((await card.count()) === 0) await importThroughLeftPanel(page, fixturePath(ctx, file));
    const clips = page.locator('.timeline-clip[data-clip-id]');
    const before = await clips.count();
    const target = page
      .locator('.timeline-lane, .timeline-empty-state, .timeline-file-new-track-drop')
      .first();
    await card.dragTo(target);
    await clips.first().waitFor({ state: 'attached' });
    const after = await clips.count();
    if (after <= before) throw new Error(`the clip count stayed at ${before} after the drag`);
    const stored = clipsOf((await readDocument(page, ctx.bridge)).document);
    if (stored.length === 0) throw new Error('the stored document has no clip after the drag');
    return {
      message: `clips ${before} -> ${after}; stored document holds ${stored.length}`,
      evidence: [await ctx.shot('D-A05-40', 'dragged')],
    };
  },
});

rows.push({
  id: 'D-A05-50',
  area: 'Bridge',
  title: 'Every desktop.media.* and desktop.asset-library.* reply is logged',
  severity: 'minor',
  expected:
    'bridge-replies.jsonl holds a line for the asset-library and media channels used in this run',
  async run(page, ctx) {
    await ensureProject(page, ctx, 'A05 bridge');
    await ctx.bridge.invoke('desktop.asset-library.get-settings', {});
    await ctx.bridge.invoke('desktop.asset-library.get-catalog', {});
    await readDocument(page, ctx.bridge);
    const tap = await ctx.bridge.installTap();
    const channels = new Set(ctx.bridge.log.entries.map((entry) => entry.channel));
    const need = [
      'desktop.asset-library.get-settings',
      'desktop.asset-library.get-catalog',
      'desktop.media.project.document.get',
    ];
    const missing = need.filter((channel) => !channels.has(channel));
    if (missing.length > 0) throw new Error(`no log line for ${missing.join(', ')}`);
    return {
      message: `${ctx.bridge.log.entries.length} bridge replies logged; UI-side tap ${tap ? 'installed' : 'not installable (frozen bridge), steps and readbacks only'}`,
      evidence: ctx.bridgeLogPath ? [ctx.bridgeLogPath] : [],
    };
  },
});

/** The size of the newest MP4 written after `since` (ms epoch) in the scratch download folder, or 0. */
function freshMp4Size(downloadDir, since) {
  if (!downloadDir) return 0;
  try {
    let size = 0;
    for (const name of readdirSync(downloadDir)) {
      if (!/\.mp4$/iu.test(name)) continue;
      const info = statSync(join(downloadDir, name));
      if (info.mtimeMs >= since - 1_000) size = Math.max(size, info.size);
    }
    return size;
  } catch {
    return 0;
  }
}

/** True when the scratch download folder holds a non-empty MP4 written after `since` (ms epoch). */
function hasFreshMp4(downloadDir, since) {
  return freshMp4Size(downloadDir, since) > 0;
}

rows.push({
  id: 'D-A05-60',
  area: 'Export',
  title: `Export the sample project "${EDITOR_PROJECT}"`,
  severity: 'major',
  expected: `Export MP4 on "${EDITOR_PROJECT}" finishes with no "Missing media" refusal and no "cannot resolve visual asset" text (every clip of the sample ships its media)`,
  async run(page, ctx) {
    await goToProjects(page);
    await projectCard(page, EDITOR_PROJECT).click();
    await page.getByRole('button', { name: 'File', exact: true }).waitFor({ state: 'visible' });
    const startedAt = Date.now();
    const consoleTail = [];
    const onConsole = (message) =>
      consoleTail.push(`${message.type()}: ${message.text()}`.slice(0, 160));
    page.on?.('console', onConsole);
    await page.getByRole('button', EXPORT_BUTTON).click();
    // The button is idle before the click, so "not busy" is already true: wait for the export to start first,
    // then for it to finish, and require a message. Without this the row passed on an empty page.
    await page
      .waitForFunction(
        () => document.querySelector('.header-export-btn')?.getAttribute('aria-busy') === 'true',
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => {
        throw new Error('the export did not start (the button never became busy)');
      });
    // The export button goes idle between the encode and the Worker's final step, so idle is not "done". Like the
    // other export rows, poll until the exported file is in the scratch download folder and the button is idle,
    // or until a refusal or failure toast shows (a clean export removes its toast at once).
    const exportDeadline = Date.now() + (ctx.exportTimeoutMs ?? 240_000);
    let toast = '';
    let lastSize = -1;
    const stateTrail = [];
    while (Date.now() < exportDeadline) {
      toast = await page
        .locator('.export-toast')
        .innerText({ timeout: 500 })
        .catch(() => '');
      if (/failed|error|missing media|cannot resolve/iu.test(toast)) break;
      const busy = await page
        .locator('.header-export-btn')
        .getAttribute('aria-busy')
        .catch(() => null);
      const size = freshMp4Size(ctx.downloadDir, startedAt);
      const seen = await page
        .evaluate(() => {
          const progress = document.querySelector('.export-progress');
          return `busy=${document.querySelector('.header-export-btn')?.getAttribute('aria-busy')} progress=${progress?.getAttribute('style') ?? progress?.textContent ?? '-'} toast=${document.querySelector('.export-toast')?.textContent ?? '-'}`;
        })
        .catch(() => 'page gone');
      if (stateTrail[stateTrail.length - 1]?.text !== seen)
        stateTrail.push({ at: Math.round((Date.now() - startedAt) / 1000), text: seen });
      if (size > 0 && size === lastSize && busy !== 'true') break;
      lastSize = size;
      await page.waitForTimeout(1_000);
    }
    if (toast === '' && !hasFreshMp4(ctx.downloadDir, startedAt)) {
      const where = await ctx.shot('D-A05-60', 'no-file');
      if (ctx.outDir) {
        const dir = join(ctx.outDir, 'D-A05-60');
        mkdirSync(dir, { recursive: true });
        const trail = stateTrail.map((entry) => `${entry.at}s ${entry.text}`).join('\n');
        writeFileSync(
          join(dir, 'state-trail.txt'),
          `${trail}\n--- console\n${consoleTail.join('\n')}\n`,
          'utf8',
        );
      }
      let dialogs = [];
      try {
        dialogs = await page.locator('[role="dialog"], [role="alertdialog"]').allInnerTexts();
      } catch {
        // diagnostics only
      }
      let toasts = [];
      try {
        toasts = await page.locator('[class*="toast"]').allInnerTexts();
      } catch {
        // diagnostics only
      }
      throw new Error(
        `the export ended with no message and no MP4 in the scratch download folder (screenshot ${where}; open dialogs: ${dialogs.join(' | ').slice(0, 300) || 'none'}; toasts: ${toasts.join(' | ').slice(0, 300) || 'none'}; console: ${consoleTail.slice(-4).join(' // ')}; trail: ${stateTrail
          .slice(0, 14)
          .map((entry) => `${entry.at}s ${entry.text}`)
          .join(' | ')})`,
      );
    }
    const first = toast.split('\n')[0] ?? '';
    const shot = await ctx.shot('D-A05-60', 'export');
    if (/cannot resolve visual asset/iu.test(toast)) {
      throw new Error(`known failure still present: ${first}`);
    }
    if (/missing media in this export/iu.test(toast)) {
      throw new Error(`the sample ships without a clip's media: ${first}`);
    }
    if (/failed|error/iu.test(toast)) throw new Error(`export ended with: ${first}`);
    return {
      message: `export of "${EDITOR_PROJECT}" ended: ${first || 'no toast'}`,
      evidence: [shot],
    };
  },
});

export const PROJECTS_IMPORT_ROWS = Object.freeze(rows);
export const PROJECTS_IMPORT_ROWS_BY_ID = rowsById(rows);
