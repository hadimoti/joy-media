/* global document */
/**
 * T-A08: the menu catalogue (`MENU_SPEC`, a copy of `APP_MENU_GROUPS` that a unit test compares with
 * `apps/editor-web/src/app-menu.ts`) and one check per menu action (`ACTION_CHECKS`).
 *
 * A check is `async (t) => message` with `t = { page, ctx, rowId, surface, fire }`. `fire()` starts the action
 * through the surface under test: a header menu click (the menu rows) or a palette click (D-071). The check
 * does its own set-up with keys, then fires, then compares before and after. So one table serves the File, Edit,
 * Clip, Joy Code, View and Window rows and the palette row.
 *
 * NOT RUN: written without launching the app. Selectors come from reading App.tsx (runMenuAction, the palette,
 * the shortcuts dialog), AppMenuBar, AssetLibrarySettingsDialog and JoyAgentSettingsDialog; the first live run
 * must confirm each one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { blockedRow, notReachable, runParts } from './rows.mjs';
import {
  blurFocus,
  ensureTimelineClip,
  exactRegex,
  openMenuGroup,
  openPalette,
  pressChord,
  readPaletteState,
  readPanelOpen,
  SEL,
  selectClipById,
  snapshot,
  waitForSnapshot,
} from './ui-steps.mjs';
import { screenshot } from './steps.mjs';

/** One panel of the View menu: the menu label equals the panel label. */
const VIEW_PANELS = [
  ['media', 'Create'],
  ['monitor', 'Program Monitor'],
  ['timeline', 'Timeline'],
  ['inspector', 'Inspector'],
  ['scene3d', '3D Scene'],
  ['history', 'History'],
  ['flow', 'Flow'],
  ['effects', 'Enhance'],
  ['camera', 'Camera'],
  ['agent', 'Joy Code'],
  ['workflows', 'Workflows'],
  ['jobs', 'Jobs'],
  ['diagnostics', 'Diagnostics'],
  ['plugins', 'Plugins'],
];

const WINDOW_PANELS = VIEW_PANELS.filter(([id]) =>
  ['media', 'monitor', 'timeline', 'inspector'].includes(id),
);

/** A copy of APP_MENU_GROUPS, in the same order. `shortcut` is '' where the menu shows none. */
export const MENU_SPEC = [
  {
    group: 'File',
    items: [
      { id: 'file.projects', label: 'Projects Library…', shortcut: '' },
      { id: 'file.projectImport', label: 'Import Editable Project…', shortcut: '' },
      { id: 'file.projectExport', label: 'Export Editable Project…', shortcut: '' },
      { id: 'file.export', label: 'Export', shortcut: '' },
    ],
  },
  {
    group: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z' },
      { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y' },
      { id: 'clip.cut', label: 'Cut', shortcut: 'Ctrl+X' },
      { id: 'clip.copy', label: 'Copy', shortcut: 'Ctrl+C' },
      { id: 'clip.paste', label: 'Paste', shortcut: 'Ctrl+V' },
      { id: 'clip.delete', label: 'Delete', shortcut: 'Del' },
      { id: 'snapping.toggle', label: 'Toggle Snapping', shortcut: 'N' },
      { id: 'edit.commandPalette', label: 'Command Palette…', shortcut: 'Ctrl+K' },
      { id: 'edit.assetLibrarySettings', label: 'Asset Library Folder…', shortcut: '' },
    ],
  },
  {
    group: 'Clip',
    items: [
      { id: 'clip.split', label: 'Split at Playhead', shortcut: 'S' },
      { id: 'clip.duplicate', label: 'Duplicate Clip', shortcut: 'Ctrl+D' },
      { id: 'clip.delete', label: 'Delete', shortcut: 'Del' },
      { id: 'clip.speed', label: 'Speed…', shortcut: '' },
    ],
  },
  {
    group: 'Joy Code',
    items: [
      { id: 'agent.open', label: 'Open Joy Code', shortcut: '' },
      { id: 'agent.active', label: 'Built-in JOY Agent Engine', shortcut: '', disabled: true },
      { id: 'agent.executionMode', label: 'Execution Mode…', shortcut: '' },
      { id: 'agent.stop', label: 'Pause / Stop', shortcut: '' },
      { id: 'agent.settings', label: 'Joy Code Settings…', shortcut: '' },
    ],
  },
  {
    group: 'View',
    items: [
      { id: 'view.fullscreen', label: 'Toggle Full Screen', shortcut: 'F11' },
      ...VIEW_PANELS.map(([id, label]) => ({ id: `view.panel.${id}`, label, shortcut: '' })),
    ],
  },
  {
    group: 'Window',
    items: [
      { id: 'window.minimize', label: 'Minimize', shortcut: 'Ctrl+M' },
      { id: 'window.maximize', label: 'Zoom / Maximize', shortcut: '' },
      { id: 'window.close', label: 'Close Window', shortcut: 'Alt+F4' },
      ...WINDOW_PANELS.map(([id, label]) => ({
        id: `window.panel.${id}`,
        label: `Focus ${label}`,
        shortcut: '',
      })),
    ],
  },
];

/** The ids the palette lists: every menu id once, in menu order (Delete is in Edit and Clip). */
export function paletteSpec() {
  const seen = new Map();
  for (const { items } of MENU_SPEC) {
    for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

/** Page-side: the text of every visible dialog. */
export function readDialogTexts() {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((element) => element.innerText ?? '');
}

/** Page-side: the Joy Code settings dialog, its navigation labels and the active one. */
export function readSettingsDialog() {
  const dialog = document.querySelector(
    '[role="dialog"][aria-labelledby="joy-agent-settings-title"]',
  );
  if (dialog === null) return { open: false, title: '', nav: [], active: '' };
  return {
    open: true,
    title: dialog.querySelector('#joy-agent-settings-title')?.textContent?.trim() ?? '',
    nav: [...dialog.querySelectorAll('.joy-settings-nav-item')].map(
      (item) => item.textContent?.trim() ?? '',
    ),
    active: dialog.querySelector('.joy-settings-nav-item.is-active')?.textContent?.trim() ?? '',
  };
}

/** Page-side: the execution mode cards (name, selected). */
export function readModeCards() {
  return [...document.querySelectorAll('.joy-settings-mode-card')].map((card) => ({
    name: card.querySelector('.joy-settings-mode-card-title span')?.textContent?.trim() ?? '',
    selected: card.classList.contains('is-selected'),
  }));
}

const KEY_UNDO = 'Control+KeyZ';

async function prep(t, minClips = 1) {
  return ensureTimelineClip(t.page, t.ctx, t.rowId, { minClips });
}

async function selectBase(t, state) {
  await selectClipById(t.page, state.clips[0].id);
}

async function expectCount(page, count, why) {
  return waitForSnapshot(page, (state) => state.clips.length === count, why);
}

async function waitPanel(page, label, { focus = false } = {}) {
  let last;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    last = await page.evaluate(readPanelOpen, label);
    if ((last.shown || last.tabActive) && (!focus || last.focused)) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(
    `the ${label} panel is not ${focus ? 'focused' : 'open'} (${JSON.stringify(last)})`,
  );
}

export function listNonMp4(dir) {
  try {
    return readdirSync(dir).filter((name) => !name.toLowerCase().endsWith('.mp4'));
  } catch {
    return [];
  }
}

async function closeDialogByButton(page, name) {
  const close = page.getByRole('button', { name, exact: true }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press('Escape');
}

export async function getWindowState(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState;
  } finally {
    await cdp.detach();
  }
}

export async function setWindowState(page, windowState) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  } finally {
    await cdp.detach();
  }
}

async function windowStateTools(t) {
  if (t.ctx.windowState) return t.ctx.windowState;
  return {
    get: () => getWindowState(t.page),
    set: (state) => setWindowState(t.page, state),
  };
}

async function waitWindowState(tools, wanted) {
  let last;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    last = await tools.get();
    if (last === wanted) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`the window state is "${last}", expected "${wanted}"`);
}

function panelCheck(label, { focus }) {
  return async (t) => {
    await t.fire();
    const state = await waitPanel(t.page, label, { focus });
    return `${label} panel ${focus ? 'focused' : 'open'} (${JSON.stringify(state)})`;
  };
}

/** The checks, keyed by menu action id. */
export const ACTION_CHECKS = {
  'file.projects': async (t) => {
    if (!t.ctx.projectTitle) {
      throw blockedRow(
        t.rowId,
        'needs the project title (ctx.projectTitle) to open the project again afterwards',
      );
    }
    await t.fire();
    await t.page
      .getByRole('button', { name: 'New project', exact: true })
      .waitFor({ state: 'visible' });
    await t.page.getByText(t.ctx.projectTitle).first().click();
    await t.page.getByRole('button', { name: 'File', exact: true }).waitFor({ state: 'visible' });
    return 'the projects page opened with New project, and the project opened again';
  },

  'file.projectImport': async (t) => {
    if (!t.ctx.editableProjectFile) {
      throw blockedRow(t.rowId, 'needs the file that D-003 exports; run D-003 first');
    }
    const [chooser] = await Promise.all([t.page.waitForEvent('filechooser'), t.fire()]);
    await chooser.setFiles(t.ctx.editableProjectFile);
    const wanted = t.ctx.editableProjectClips ?? 1;
    const state = await waitForSnapshot(
      t.page,
      (now) => now.clips.length >= wanted,
      `the imported project does not show ${wanted} clip(s)`,
      { attempts: 60, stepMs: 500 },
    );
    return `imported ${t.ctx.editableProjectFile}; the editor shows ${state.clips.length} clip(s)`;
  },

  'file.projectExport': async (t) => {
    const state = await prep(t);
    if (!t.ctx.downloadDir) {
      throw blockedRow(
        t.rowId,
        'needs the driver in test mode (JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY) so the file is saved without a Save window',
      );
    }
    const before = listNonMp4(t.ctx.downloadDir);
    await t.fire();
    let fresh;
    for (let attempt = 0; attempt < 60 && fresh === undefined; attempt += 1) {
      fresh = listNonMp4(t.ctx.downloadDir).find((name) => !before.includes(name));
      if (fresh === undefined) await t.page.waitForTimeout(500);
    }
    if (fresh === undefined)
      throw new Error('no editable project file appeared in the scratch download folder');
    const path = join(t.ctx.downloadDir, fresh);
    if (statSync(path).size === 0) throw new Error(`${fresh} is empty`);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object')
      throw new Error(`${fresh} is not a JSON object`);
    t.ctx.editableProjectFile = path;
    t.ctx.editableProjectClips = state.clips.length;
    return `${fresh} written (${statSync(path).size} bytes) and parses as JSON`;
  },

  'file.export': async (t) => {
    await prep(t);
    await t.fire();
    let texts = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      texts = await t.page.evaluate(readDialogTexts);
      if (texts.some((text) => /\d+\s*[×x]\s*\d+/u.test(text))) {
        await t.page.keyboard.press('Escape');
        return 'the export dialog opened and shows the canvas size';
      }
      await t.page.waitForTimeout(250);
    }
    const busy = await t.page.locator('.header-export-btn[aria-busy="true"]').count();
    if (busy > 0) {
      const cancel = t.page.getByRole('button', { name: 'Cancel export', exact: true });
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      throw new Error(
        'File > Export started the export at once; no dialog with the canvas size opened (the matrix, D-004, expects one)',
      );
    }
    throw new Error('File > Export opened no dialog and started no export');
  },

  'edit.undo': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.page.keyboard.press('Control+KeyD');
    await expectCount(t.page, count + 1, 'Ctrl+D did not duplicate the clip (the set-up for Undo)');
    await t.fire();
    await expectCount(t.page, count, 'Undo did not take the duplicate back');
    return `Undo took a duplicate back (${count + 1} -> ${count} clips)`;
  },

  'edit.redo': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.page.keyboard.press('Control+KeyD');
    const duplicated = await expectCount(t.page, count + 1, 'Ctrl+D did not duplicate the clip');
    await t.page.keyboard.press(KEY_UNDO);
    await expectCount(t.page, count, 'Undo did not take the duplicate back (the set-up for Redo)');
    await t.fire();
    const redone = await expectCount(t.page, count + 1, 'Redo did not put the duplicate back');
    const same =
      JSON.stringify(duplicated.clips.map((c) => c.id)) ===
      JSON.stringify(redone.clips.map((c) => c.id));
    await t.page.keyboard.press(KEY_UNDO);
    if (!same) throw new Error('Redo brought back different clip ids than the duplicate had');
    return 'Redo put the duplicate back with the same clip ids';
  },

  'clip.delete': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.fire();
    await expectCount(t.page, count - 1, 'Delete did not remove the selected clip');
    await t.page.keyboard.press(KEY_UNDO);
    const back = await expectCount(t.page, count, 'Undo did not bring the clip back');
    if (!back.clips.some((clip) => clip.id === state.clips[0].id)) {
      throw new Error('Undo brought back a clip with a different id');
    }
    return `Delete removed the clip and Undo brought it back (${count} -> ${count - 1} -> ${count})`;
  },

  'clip.duplicate': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.fire();
    const after = await expectCount(t.page, count + 1, 'Duplicate Clip did not add a clip');
    const original = state.clips[0];
    const added = after.clips.find((clip) => !state.clips.some((c) => c.id === clip.id));
    if (added?.trackId !== original.trackId) {
      throw new Error(
        `the copy is on track ${added?.trackId}, the original is on ${original.trackId}`,
      );
    }
    await t.page.keyboard.press(KEY_UNDO);
    await expectCount(t.page, count, 'one Undo did not remove the copy');
    return `the copy is on the same track and one Undo removed it (${count} -> ${count + 1} -> ${count})`;
  },

  'clip.cut': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.fire();
    await expectCount(t.page, count - 1, 'Cut did not remove the selected clip');
    await t.page.keyboard.press('Control+KeyV');
    await expectCount(t.page, count, 'pasting the cut clip did not bring a clip back');
    return `Cut removed the clip and Paste brought one back (${count} -> ${count - 1} -> ${count})`;
  },

  'clip.copy': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.fire();
    await expectCount(t.page, count, 'Copy changed the clip count');
    await t.page.keyboard.press('Control+KeyV');
    await expectCount(t.page, count + 1, 'pasting the copied clip did not add a clip');
    await t.page.keyboard.press(KEY_UNDO);
    await expectCount(t.page, count, 'Undo did not remove the pasted clip');
    return `Copy kept the clip and Paste added one (${count} -> ${count + 1}); Undo removed it`;
  },

  'clip.paste': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    await t.page.keyboard.press('Control+KeyC');
    await t.fire();
    await expectCount(t.page, count + 1, 'Paste did not add the copied clip');
    await t.page.keyboard.press(KEY_UNDO);
    await expectCount(t.page, count, 'Undo did not remove the pasted clip');
    return `Paste added the copied clip (${count} -> ${count + 1}); Undo removed it`;
  },

  'clip.split': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    const count = state.clips.length;
    // The playhead goes one second in, inside the clip, with the clip still selected.
    await blurFocus(t.page);
    await t.page.keyboard.press('Home');
    await t.page.keyboard.press('ArrowRight');
    await t.fire();
    await expectCount(t.page, count + 1, 'Split at Playhead did not cut the clip in two');
    await t.page.keyboard.press(KEY_UNDO);
    await expectCount(t.page, count, 'one Undo did not join the halves');
    return `Split cut the clip in two and one Undo restored it (${count} -> ${count + 1} -> ${count})`;
  },

  'clip.speed': async (t) => {
    const state = await prep(t);
    await selectBase(t, state);
    await t.fire();
    const tab = t.page.locator('button[role="tab"][data-panel-tab-id="speed"]').first();
    await tab.waitFor({ state: 'visible' });
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
      throw new Error('Speed… did not select the Inspector Speed tab for a video clip');
    }
    return 'Speed… opened the Inspector Speed tab for the video clip';
  },

  'snapping.toggle': async (t) => {
    const before = (await snapshot(t.page)).snapping;
    if (before === null) throw new Error('the Snapping button is not on the timeline');
    await t.fire();
    const flipped = await waitForSnapshot(
      t.page,
      (s) => s.snapping === !before,
      'Toggle Snapping did not flip the Snapping button',
    );
    await t.fire();
    await waitForSnapshot(
      t.page,
      (s) => s.snapping === before,
      'a second Toggle Snapping did not flip it back',
    );
    return `Snapping went ${before} -> ${flipped.snapping} -> ${before}`;
  },

  'edit.commandPalette': async (t) => {
    await t.fire();
    const open = await t.page.locator('section.palette[role="dialog"]').first().isVisible();
    if (!open) throw new Error('the palette did not open');
    const focused = await t.page.evaluate(function readPaletteFocus() {
      const input = document.querySelector('section.palette input');
      return input !== null && document.activeElement === input;
    });
    await t.page.keyboard.press('Escape');
    if (!focused) throw new Error('the palette opened but its search box has no focus');
    return 'the palette opened with its search box focused';
  },

  'edit.assetLibrarySettings': async (t) => {
    await t.fire();
    const dialog = t.page.getByRole('dialog').first();
    await dialog.waitFor({ state: 'visible' });
    const value = await dialog.getByRole('textbox').first().inputValue();
    if (value.trim() === '') throw new Error('the Asset Library Folder dialog shows no path');
    if (
      t.ctx.libraryDir &&
      !value.toLowerCase().includes(resolve(t.ctx.libraryDir).toLowerCase())
    ) {
      throw new Error(
        `the dialog shows "${value}", not the scratch library ${resolve(t.ctx.libraryDir)}`,
      );
    }
    await closeDialogByButton(t.page, 'Close dialog');
    await dialog.waitFor({ state: 'detached' });
    return `the dialog shows the library folder ${value} and closed`;
  },

  'agent.open': panelCheck('Joy Code', { focus: false }),

  'agent.active': async (t) => {
    const menu = await openMenuGroup(t.page, 'Joy Code');
    const item = menu.items.find((candidate) => candidate.label === 'Built-in JOY Agent Engine');
    await t.page.keyboard.press('Escape');
    if (item?.disabled !== true) {
      throw new Error('Built-in JOY Agent Engine is not shown as disabled');
    }
    throw notReachable(
      t.rowId,
      'Built-in JOY Agent Engine is a disabled status item with no click action',
    );
  },

  'agent.executionMode': async (t) => {
    await t.fire();
    const dialog = t.page
      .locator('[role="dialog"][aria-labelledby="joy-agent-settings-title"]')
      .first();
    await dialog.waitFor({ state: 'visible' });
    const settings = await t.page.evaluate(readSettingsDialog);
    const trigger = dialog.locator('button.joy-accordion-trigger').first();
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    const cards = await t.page.evaluate(readModeCards);
    if (cards.length < 2)
      throw new Error(`the execution tab lists ${cards.length} mode(s), expected several`);
    const current = cards.find((card) => card.selected);
    const other = cards.find((card) => !card.selected);
    await dialog.locator('.joy-settings-mode-card').filter({ hasText: other.name }).first().click();
    const changed = (await t.page.evaluate(readModeCards)).find((card) => card.selected);
    if (changed?.name !== other.name)
      throw new Error(`picking ${other.name} left ${changed?.name} selected`);
    if (current !== undefined) {
      await dialog
        .locator('.joy-settings-mode-card')
        .filter({ hasText: current.name })
        .first()
        .click();
    }
    await closeDialogByButton(t.page, 'Close settings');
    return `Execution Mode… opened settings on "${settings.active}"; ${cards.length} modes; picking ${other.name} moved the selection and ${current?.name ?? 'the first mode'} was restored`;
  },

  'agent.stop': async (t) => {
    await t.fire();
    await waitPanel(t.page, 'Joy Code', { focus: false });
    throw notReachable(
      t.rowId,
      'the menu item is enabled and opens Joy Code, but stopping a running turn needs a stub-model run (T-A11)',
    );
  },

  'agent.settings': async (t) => {
    await t.fire();
    const dialog = t.page
      .locator('[role="dialog"][aria-labelledby="joy-agent-settings-title"]')
      .first();
    await dialog.waitFor({ state: 'visible' });
    const settings = await t.page.evaluate(readSettingsDialog);
    if (settings.title !== 'Joy Code Settings')
      throw new Error(`the dialog title is "${settings.title}"`);
    if (settings.nav.length === 0) throw new Error('the settings dialog lists no categories');
    if (t.ctx.outDir)
      await screenshot(t.page, join(t.ctx.outDir, t.rowId, 'shot-joy-code-settings.png'));
    await closeDialogByButton(t.page, 'Close settings');
    return `the Joy Code Settings dialog opened with ${settings.nav.length} categories (${settings.nav.join(', ')})`;
  },

  'view.fullscreen': async (t) => {
    const before = (await snapshot(t.page)).fullscreen;
    await t.fire();
    await waitForSnapshot(
      t.page,
      (s) => s.fullscreen === !before,
      'Toggle Full Screen did not change the full-screen state',
    );
    await t.fire();
    await waitForSnapshot(
      t.page,
      (s) => s.fullscreen === before,
      'a second Toggle Full Screen did not leave full screen',
    );
    return `full screen went ${before} -> ${!before} -> ${before}`;
  },

  'window.minimize': async (t) => {
    const tools = await windowStateTools(t).catch(() => undefined);
    let before;
    try {
      before = await tools.get();
    } catch (error) {
      throw notReachable(
        t.rowId,
        `the window state cannot be read through CDP: ${String(error.message).split('\n')[0]}`,
      );
    }
    await t.fire();
    await waitWindowState(tools, 'minimized');
    await tools.set('normal');
    await waitWindowState(tools, before === 'minimized' ? 'normal' : before);
    return `the window went ${before} -> minimized and was restored through CDP`;
  },

  'window.maximize': async (t) => {
    const tools = await windowStateTools(t);
    let before;
    try {
      before = await tools.get();
    } catch (error) {
      throw notReachable(
        t.rowId,
        `the window state cannot be read through CDP: ${String(error.message).split('\n')[0]}`,
      );
    }
    await t.fire();
    const wanted = before === 'maximized' ? 'normal' : 'maximized';
    await waitWindowState(tools, wanted);
    await t.fire();
    await waitWindowState(tools, before);
    return `Zoom / Maximize took the window ${before} -> ${wanted} -> ${before}`;
  },

  'window.close': async (t) => {
    if (!t.ctx.allowClose) {
      throw notReachable(
        t.rowId,
        'closing the window ends the run; run D-035 alone, last, with --allow-close (the save prompt is also attended)',
      );
    }
    const closed = t.page.waitForEvent('close', { timeout: 30_000 });
    await t.fire();
    await closed;
    return 'the window closed';
  },
};

for (const [id, label] of VIEW_PANELS) {
  ACTION_CHECKS[`view.panel.${id}`] = panelCheck(label, { focus: false });
}
for (const [id, label] of WINDOW_PANELS) {
  ACTION_CHECKS[`window.panel.${id}`] = panelCheck(label, { focus: true });
}

function actionItems() {
  return MENU_SPEC.flatMap((group) =>
    group.items.map((item) => ({
      name: `${group.group} > ${item.label}`,
      group,
      item,
      surface: 'menu',
    })),
  );
}

async function firePaletteAction(page, item) {
  await openPalette(page);
  const input = page.locator(SEL.paletteInput).first();
  await input.fill(item.label.replace(/…$/u, ''));
  const palette = await readPaletteState(page);
  const found = palette.items.find((entry) => entry.title === item.label);
  if (found === undefined) {
    await page.keyboard.press('Escape');
    throw new Error(`the command palette does not list "${item.label}"`);
  }
  if (found.disabled) {
    await page.keyboard.press('Escape');
    throw notReachable(
      'D-071',
      `command palette > ${item.label} is disabled in this project state`,
    );
  }
  const escaped = item.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  await page.getByRole('button', { name: new RegExp(`^${escaped}(?:\\s|$)`, 'u') }).click();
}

async function fireMenuAction(page, group, item, rowId) {
  const menu = await openMenuGroup(page, group);
  const found = menu.items.find((candidate) => candidate.label === item.label);
  if (found === undefined) {
    await page.keyboard.press('Escape');
    throw new Error(`${group} > ${item.label} is missing from the open menu`);
  }
  if (found.disabled) {
    await page.keyboard.press('Escape');
    throw notReachable(rowId, `${group} > ${item.label} is disabled in this project state`);
  }
  await page
    .locator(SEL.menuItemLabel)
    .filter({ hasText: exactRegex(item.label) })
    .first()
    .click();
}

async function runMenuAndPalette(page, ctx) {
  const rowId = 'D-071';
  const menuCases = actionItems();
  const paletteCases = paletteSpec().map((item) => ({
    name: `Command palette > ${item.label}`,
    group: undefined,
    item,
    surface: 'palette',
  }));
  const cases = [...menuCases, ...paletteCases];
  const outcome = await runParts(
    rowId,
    'menu and command-palette actions',
    cases,
    async (entry) => {
      const { item, group, surface } = entry;
      const fire = async () => {
        if (surface === 'menu') await fireMenuAction(page, group.group, item, rowId);
        else await firePaletteAction(page, item);
      };
      if (surface === 'menu') {
        const menu = await openMenuGroup(page, group.group);
        try {
          const found = menu.items.find((candidate) => candidate.label === item.label);
          if (found === undefined)
            throw new Error(`${group.group} > ${item.label} is missing from the open menu`);
          if (group.group === 'File' && item.id === 'file.projects' && ctx.outDir) {
            await screenshot(page, join(ctx.outDir, rowId, 'shot-file-menu.png'));
          }
        } finally {
          await page.keyboard.press('Escape');
        }
      }
      const check = ACTION_CHECKS[item.id];
      if (check === undefined) throw new Error(`${item.id} has no action check`);
      return check({ page, ctx, rowId, surface, fire });
    },
  );
  return outcome;
}

/** Page-side: the exact shortcut groups and rows shown in the dialog. */
export function readShortcutsDialog() {
  const dialog = document.querySelector('.shortcuts-overlay[role="dialog"]');
  if (dialog === null) return { open: false, groups: [] };
  return {
    open: true,
    groups: [...dialog.querySelectorAll('.shortcut-group')].map((group) => ({
      title: group.querySelector('.shortcut-group-heading')?.textContent?.trim() ?? '',
      rows: [...group.querySelectorAll('.shortcut-row')].map((row) => ({
        keys: row.querySelector('.shortcut-keys')?.textContent?.trim() ?? '',
        action: row.querySelector('.shortcut-action')?.textContent?.trim() ?? '',
      })),
    })),
  };
}

export const SHORTCUT_ACTIONS = new Map([
  ['Toggle playback', { field: 'playing', requiresClip: true }],
  ['Step back / forward 1s', { field: 'timecode', requiresClip: true }],
  ['Fine step 100ms', { field: 'timecode', requiresClip: true }],
  ['Go to start / end', { field: 'timecode', requiresClip: true }],
  ['Step back / forward one frame', { field: 'timecode', requiresClip: true }],
  [
    'Step one frame when the Monitor has focus',
    { field: 'timecode', scope: 'monitor', requiresClip: true },
  ],
  [
    'Reverse / stop / forward; press J or L again to go faster (up to 8x)',
    { field: 'playing', requiresClip: true },
  ],
  ['Set in point / out point', { field: 'rangeSignature', requiresClip: true }],
  ['Clear in and out points', { field: 'rangeSignature', requiresClip: true }],
  ['Play in to out', { field: 'playing', requiresClip: true }],
  ['Loop on or off', { field: 'loop' }],
  ['Undo', { menuAction: 'edit.undo', requiresClip: true }],
  ['Redo', { menuAction: 'edit.redo', requiresClip: true }],
  ['Copy selected clips', { menuAction: 'clip.copy', requiresClip: true }],
  ['Cut selected clips', { menuAction: 'clip.cut', requiresClip: true }],
  ['Paste clips at playhead', { menuAction: 'clip.paste', requiresClip: true }],
  ['Duplicate the selected clips', { menuAction: 'clip.duplicate', requiresClip: true }],
  ['Delete selected clip or marker', { menuAction: 'clip.delete', requiresClip: true }],
  ['Split clip at playhead', { menuAction: 'clip.split', requiresClip: true }],
  ['Toggle timeline snapping', { menuAction: 'snapping.toggle' }],
  ['Select tool / Split tool (Timeline)', { fields: ['selectTool', 'splitTool'] }],
  ['Add a marker at the playhead (Timeline)', { field: 'markers' }],
  ['Add a visual / audio track (Timeline)', { field: 'tracks' }],
  ['Zoom the Timeline in / out', { field: 'zoom' }],
  ['Fit the Timeline to its width', { field: 'zoom' }],
  ['Freeze frame at the playhead (Timeline)', { field: 'clipSignature', requiresClip: true }],
  ['Reverse the selected clip (Timeline)', { field: 'clipSignature', requiresClip: true }],
  ['Ripple delete the selected clip (Timeline)', { field: 'clips', requiresClip: true }],
  ['Import media (Timeline)', { media: true }],
  [
    'Select the next / previous element; past the last or first, focus leaves',
    { field: 'monitorSignature', scope: 'monitor' },
  ],
  ['Move the selected element 1 pixel', { field: 'monitorSignature', scope: 'monitor' }],
  ['Move the selected element 10 pixels', { field: 'monitorSignature', scope: 'monitor' }],
  [
    'Scale the selected element 1% (Shift: 10%); Up and Right grow it',
    { field: 'monitorSignature', scope: 'monitor' },
  ],
  [
    'Rotate the selected element 1 degree (with Shift: 15 degrees)',
    { field: 'monitorSignature', scope: 'monitor' },
  ],
  ['Leave the Monitor picture', { field: 'monitorFocus', scope: 'monitor' }],
  ['Command palette', { field: 'paletteOpen' }],
  ['Full-screen preview (Esc leaves)', { field: 'fullscreen' }],
  ['Toggle this panel', { field: 'shortcutsOpen' }],
]);

export function parseShortcutAlternatives(keys) {
  const value = String(keys)
    .replace(/\s*\([^)]*\)\s*/gu, ' ')
    .trim();
  const parts = value.split(/\s+\/\s+/u).map((part) => part.trim());
  const expanded = [];
  for (const part of parts) {
    const prefix = /^(Ctrl|Shift|Alt|Meta)\+/iu.exec(part)?.[0] ?? '';
    const body = prefix === '' ? part : part.slice(prefix.length);
    if (/^(Ctrl|Shift|Alt|Meta)\+/iu.test(body)) {
      expanded.push(body);
    } else if (/^(?:Shift|Alt)\+/iu.test(prefix) && /^[←→↑↓] [←→↑↓ ]+$/u.test(body)) {
      expanded.push(...body.split(/\s+/u).map((key) => `${prefix}${key}`));
    } else if (/^[←→↑↓] [←→↑↓ ]+$/u.test(body)) {
      expanded.push(...body.split(/\s+/u));
    } else {
      expanded.push(`${prefix}${body}`);
    }
  }
  return expanded;
}

function changedField(before, after, rule) {
  if (rule.fields) return rule.fields.some((field) => before[field] !== after[field]);
  return before[rule.field] !== after[rule.field];
}

async function checkShortcut(page, ctx, rowId, row, chord) {
  const rule = SHORTCUT_ACTIONS.get(row.action);
  await closeDialogByButton(page, 'Close shortcuts');
  if (rule?.requiresClip) {
    let state = await snapshot(page);
    if (state.clips.length === 0 && ctx.media) state = await ensureTimelineClip(page, ctx, rowId);
    if (state.clips.length === 0) {
      await pressChord(page, chord);
      throw notReachable(rowId, `${row.keys}: needs a clip on the timeline`);
    }
    await selectClipById(page, state.clips[0].id);
  }
  if (
    (row.action === 'Toggle playback' ||
      row.action === 'Reverse / stop / forward; press J or L again to go faster (up to 8x)') &&
    (row.action === 'Toggle playback' || chord === 'J') &&
    (await snapshot(page)).playing
  ) {
    await page.keyboard.press('k');
    await waitForSnapshot(
      page,
      (state) => !state.playing,
      `${row.keys} setup could not stop playback`,
    );
  }
  if (rule?.media && !ctx.media) {
    await pressChord(page, chord);
    await page.keyboard.press('Escape');
    throw notReachable(rowId, `${row.keys}: needs --media to import a fixture`);
  }
  if (rule?.fields && rule.fields.includes('selectTool')) {
    const opposite = chord === 'KeyV' ? 'Split tool' : 'Select tool';
    await page.getByRole('button', { name: opposite }).click();
  }
  if (rule?.scope === 'monitor') {
    const monitor = page.locator('.monitor-canvas-wrap').first();
    if (!(await monitor.isVisible().catch(() => false))) {
      await pressChord(page, chord);
      throw notReachable(rowId, `${row.keys}: the Monitor picture is not visible`);
    }
    const selection = page.locator('.monitor-selection-overlay polygon').first();
    if (row.keys.includes('Monitor picture') && !(await selection.isVisible().catch(() => false))) {
      await pressChord(page, chord);
      throw notReachable(rowId, `${row.keys}: select a text or picture in the Monitor first`);
    }
    await monitor.click();
    if (rule?.field === 'monitorFocus' && !(await snapshot(page)).monitorFocus) {
      await monitor.focus().catch(() => {});
      if (!(await snapshot(page)).monitorFocus) {
        throw notReachable(rowId, `${row.keys}: the Monitor picture did not accept keyboard focus`);
      }
    }
  } else {
    await blurFocus(page);
  }
  if (rule?.menuAction) {
    const check = ACTION_CHECKS[rule.menuAction];
    return check({ page, ctx, rowId, surface: 'shortcut', fire: () => pressChord(page, chord) });
  }
  if (!rule) {
    await pressChord(page, chord);
    throw notReachable(rowId, `${row.keys}: no observable check is mapped for "${row.action}"`);
  }
  if (rule.media) {
    const dialog = page.getByRole('dialog', { name: 'Import media', exact: true });
    await pressChord(page, chord);
    await dialog.waitFor({ state: 'visible' });
    await dialog
      .locator('input[type="file"][aria-label="Media file"]')
      .setInputFiles(resolve(ctx.media));
    await dialog.getByRole('button', { name: 'Confirm import', exact: true }).click();
    await page.locator('.asset-card').first().waitFor({ state: 'visible' });
    return 'Ctrl+I opened Import media and imported the fixture';
  }
  if (rule.field === 'timecode') {
    const beforeTime = (await snapshot(page)).timecode ?? '';
    if (/^(?:00:00|00:00:00)/u.test(beforeTime)) await page.keyboard.press('End');
    else await page.keyboard.press('Home');
  }
  if (rule.field === 'rangeSignature' && row.action === 'Clear in and out points') {
    await page.keyboard.press('i');
    await page.keyboard.press('End');
    await page.keyboard.press('o');
  }
  const before = await snapshot(page);
  if (rule.field === 'timecode' && before.timecode === null) {
    await pressChord(page, chord);
    throw notReachable(rowId, `${row.keys}: the timecode is not visible in this workspace`);
  }
  await pressChord(page, chord);
  const after = await waitForSnapshot(
    page,
    (state) => changedField(before, state, rule),
    `${row.keys} did not change the expected editor state (${row.action})`,
    { attempts: 8, stepMs: 100 },
  );
  if (after.paletteOpen) await page.keyboard.press('Escape');
  if (after.shortcutsOpen) await closeDialogByButton(page, 'Close shortcuts');
  if (rule.field === 'fullscreen' && after.fullscreen) {
    await page.keyboard.press('Escape');
    if ((await snapshot(page)).fullscreen) await pressChord(page, 'F');
    await waitForSnapshot(page, (state) => !state.fullscreen, 'full-screen preview did not close');
  }
  return `${row.keys} changed the ${rule.field ?? rule.fields.join('/')} state`;
}

async function ensureShortcutsDialog(page, trigger) {
  const dialog = page.locator('.shortcuts-overlay[role="dialog"]');
  if (!(await dialog.isVisible().catch(() => false))) {
    await trigger.click();
    await dialog.waitFor({ state: 'visible' });
  }
}

async function shortcutsDialog(page, ctx) {
  const rowId = 'D-072';
  const trigger = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await trigger.click();
  const inventory = await page.evaluate(readShortcutsDialog);
  if (!inventory.open || inventory.groups.length === 0) {
    throw new Error('the Keyboard Shortcuts dialog did not show its groups');
  }
  const cases = inventory.groups.flatMap((group) =>
    group.rows.map((row) => ({
      ...row,
      group: group.title,
      name: `${group.title}: ${row.keys} — ${row.action}`,
    })),
  );
  const outcome = await runParts(rowId, 'keyboard shortcuts', cases, async (row) => {
    await ensureShortcutsDialog(page, trigger);
    const chords = parseShortcutAlternatives(row.keys);
    if (chords.length === 0) throw new Error(`could not read shortcut keys "${row.keys}"`);
    for (const chord of chords) await checkShortcut(page, ctx, rowId, row, chord);
    if (ctx.outDir && row.action === 'Toggle playback') {
      if (!(await snapshot(page)).playing) throw new Error('Space did not start Monitor playback');
      await page.waitForTimeout(250);
      await screenshot(page, join(ctx.outDir, rowId, 'shot-playing-state.png'));
      await blurFocus(page);
      await page.keyboard.press('k');
      await waitForSnapshot(
        page,
        (state) => !state.playing,
        'playback did not stop after the screenshot',
      );
    } else if (
      row.action === 'Reverse / stop / forward; press J or L again to go faster (up to 8x)' &&
      (await snapshot(page)).playing
    ) {
      await page.keyboard.press('k');
      await waitForSnapshot(
        page,
        (state) => !state.playing,
        'playback did not stop after the J/K/L checks',
      );
    }
    return `${row.keys} was pressed and checked (${row.action})`;
  });
  return {
    message: `${inventory.groups.length} groups, ${cases.length} shortcut rows; ${outcome.message}`,
    parts: outcome.parts,
  };
}

async function chooseWorkspace(page, label) {
  await page.getByRole('button', { name: /^Workspace:/u }).click();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const item = page
    .getByRole('menuitemradio', { name: new RegExp(`^${escaped}(?:\\s|$)`, 'u') })
    .first();
  await item.waitFor({ state: 'visible' });
  await item.click();
  // The click closes the menu, so the item is gone: read the always-mounted trigger instead.
  const trigger = await page.getByRole('button', { name: /^Workspace:/u }).textContent();
  if (!String(trigger).includes(label)) throw new Error(`workspace ${label} did not become active`);
}

export function readVisibleFeatureToolIds() {
  return [...document.querySelectorAll('.feature-hub [data-feature-tool]')]
    .filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((element) => element.getAttribute('data-feature-tool') ?? '');
}

function workspaceRow(id, label, panelLabels, featureTools = []) {
  return {
    id,
    area: `Workspace preset: ${label}`,
    expected: `The ${label} workspace shows ${panelLabels.join(', ')}`,
    run: async (page) => {
      await chooseWorkspace(page, label);
      const results = [];
      for (const panel of panelLabels) {
        const state = await page.evaluate(readPanelOpen, panel);
        if (!state.shown && !state.tabActive)
          throw new Error(`${label} workspace did not show ${panel}`);
        results.push(panel);
      }
      if (featureTools.length > 0) {
        const visibleTools = await page.evaluate(readVisibleFeatureToolIds);
        for (const tool of featureTools) {
          if (!visibleTools.includes(tool)) {
            throw new Error(`${label} workspace did not show the ${tool} feature tab`);
          }
        }
        results.push(...featureTools);
      }
      return `${label} workspace shows ${results.join(', ')}`;
    },
  };
}

async function resetWorkspace(page) {
  await page.getByRole('button', { name: /^Workspace:/u }).click();
  await page.getByRole('button', { name: 'Reset Workspace', exact: true }).click();
  const label = await page.getByRole('button', { name: /^Workspace:/u }).textContent();
  if (!String(label).includes('Edit'))
    throw new Error(`Reset Workspace left ${String(label).trim()}`);
  return 'Reset Workspace returned to Edit';
}

async function savedLayoutAfterRestart(page, ctx) {
  const rowId = 'D-079';
  if (typeof ctx.restartApp !== 'function') {
    throw notReachable(rowId, 'the runner does not provide an isolated same-profile app restart');
  }
  await chooseWorkspace(page, 'Custom');
  const layoutButton = page.locator('button[aria-label^="Switch to "]').first();
  const before = await layoutButton.getAttribute('aria-label');
  await layoutButton.click();
  const after = await layoutButton.getAttribute('aria-label');
  if (before === after) throw new Error('the layout button did not switch the editor layout');
  await ctx.restartApp();
  const restarted = ctx.page;
  const label = await restarted.getByRole('button', { name: /^Workspace:/u }).textContent();
  if (!String(label).includes('Custom'))
    throw new Error('the Custom workspace was not restored after restart');
  const resumedButton = restarted.locator('button[aria-label^="Switch to "]').first();
  if ((await resumedButton.getAttribute('aria-label')) !== after) {
    throw new Error('the saved layout button state did not survive restart');
  }
  return 'the layout button changed and the Custom workspace persisted after restart';
}

async function recentProcesses(page, ctx) {
  const rowId = 'D-080';
  await page.getByRole('button', { name: 'Recent processes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Recent processes' });
  await dialog.waitFor({ state: 'visible' });
  const link = dialog.getByRole('link', { name: /^Download .+ again$/u }).first();
  if ((await link.count()) === 0)
    throw notReachable(rowId, 'no completed export has a Download again link');
  const label = (await link.getAttribute('aria-label')) ?? '';
  const name = label.replace(/^Download | again$/gu, '');
  if (name === '') throw new Error('the completed export link has no filename');
  const download = page.waitForEvent('download');
  await link.click();
  const item = await download;
  const destination = join(ctx.downloadDir ?? ctx.outDir, `reopened-${basename(name)}`);
  await item.saveAs(destination);
  return `Recent processes listed ${name} and opened its download again`;
}

export const A08_ROWS = [
  {
    id: 'D-071',
    area: 'Menus and command palette',
    expected: 'Every menu item and every palette command performs its action',
    run: runMenuAndPalette,
  },
  {
    id: 'D-072',
    area: 'Keyboard shortcuts dialog',
    expected: 'Every listed shortcut performs its action',
    run: shortcutsDialog,
  },
  workspaceRow('D-073', 'Edit', ['Create', 'Program Monitor', 'Inspector', 'Timeline']),
  workspaceRow(
    'D-074',
    'Enhance',
    ['Enhance', 'Program Monitor', 'Timeline'],
    ['motion', 'effects', 'transitions', 'color'],
  ),
  workspaceRow(
    'D-075',
    'Audio & Captions',
    ['Create', 'Program Monitor', 'Timeline'],
    ['audio', 'captions'],
  ),
  workspaceRow('D-076', 'Automate', ['Joy Code', 'Workflows', 'Jobs']),
  {
    id: 'D-077',
    area: 'Workspace preset: Custom',
    expected: 'A manually changed layout remains separate from the named presets',
    run: async (page) => {
      await chooseWorkspace(page, 'Custom');
      const layout = page.locator('button[aria-label^="Switch to "]').first();
      const before = await layout.getAttribute('aria-label');
      await layout.click();
      const customized = await layout.getAttribute('aria-label');
      if (before === customized)
        throw new Error('the layout button did not change the Custom layout');
      await page.getByRole('button', { name: /^Workspace:/u }).click();
      await page.getByRole('menuitemradio', { name: /^Edit(?:\s|$)/u }).click();
      await chooseWorkspace(page, 'Custom');
      const after = await layout.getAttribute('aria-label');
      if (customized !== after) {
        throw new Error('switching away and back changed the saved Custom layout');
      }
      return 'Custom layout remained selected after switching away and back';
    },
  },
  {
    id: 'D-078',
    area: 'Workspace switcher, Reset Workspace',
    expected: 'Reset returns to Edit',
    run: resetWorkspace,
  },
  {
    id: 'D-079',
    area: 'Layout button and saved custom layout',
    expected: 'The chosen layout survives app restart',
    run: savedLayoutAfterRestart,
  },
  {
    id: 'D-080',
    area: 'Recent processes popover',
    expected: 'A recent export can be opened again',
    run: recentProcesses,
  },
];

export const A08_MENU_SPEC = MENU_SPEC;
