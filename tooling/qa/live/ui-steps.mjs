/* global document */
/**
 * Shared page helpers of the T-A07 and T-A08 rows: the header menus, the palette, the editor snapshot,
 * key chords and a timeline with a clip. They need a running app through the T-A02 driver (`driver.mjs`).
 *
 * NOT RUN: written in the T-A07/T-A08 helper session without launching the app. Every selector comes from
 * reading the source (AppMenuBar, App.tsx palette and header, TimelinePanel, MonitorTimeControls) and is
 * listed in `SEL`; the first live run must confirm each one. Page-side readers are named module-level
 * functions with no closure, because Playwright serialises them, and the unit tests answer them by name.
 */
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { blockedRow } from './rows.mjs';
import { addToTimelineThroughLeftPanel, importThroughLeftPanel } from './steps.mjs';

export const SEL = Object.freeze({
  menuTrigger: 'button.app-menu-trigger',
  dropdown: '.app-menu-dropdown[role="menu"]',
  menuItemLabel: '.app-menu-dropdown .app-menu-item-label',
  palette: 'section.palette[role="dialog"]',
  paletteInput: 'section.palette input',
  shortcutsDialog: '.shortcuts-overlay[role="dialog"]',
  clip: '.timeline-clip[data-clip-id]',
  playhead: '.timeline-playhead',
  createTab: (toolId) => `[role="tab"][data-feature-tool="${toolId}"]`,
});

export function exactRegex(text) {
  return new RegExp(`^${String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
}

/** Page-side: the open header menu (group name, items with label, shortcut and disabled). */
export function readOpenMenu() {
  const visible = (element) => {
    if (element === null) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const menu = [...document.querySelectorAll('.app-menu-dropdown[role="menu"]')].find(visible);
  if (menu === undefined) return { open: false, group: '', items: [] };
  return {
    open: true,
    group: menu.closest('.app-menu')?.querySelector('.app-menu-trigger')?.textContent?.trim() ?? '',
    items: [...menu.querySelectorAll('button[role="menuitem"]')].map((button) => ({
      label: button.querySelector('.app-menu-item-label')?.textContent?.trim() ?? '',
      shortcut: button.querySelector('.app-menu-item-shortcut')?.textContent?.trim() ?? '',
      disabled: button.disabled === true,
    })),
  };
}

/** Page-side: the command palette (open, focused search box, every entry with title, shortcut, disabled). */
export function readPalette() {
  const palette = document.querySelector('section.palette[role="dialog"]');
  if (palette === null || palette.getBoundingClientRect().height === 0) {
    return { open: false, focused: false, items: [] };
  }
  return {
    open: true,
    focused: document.activeElement === palette.querySelector('input'),
    items: [...palette.querySelectorAll('button')].map((button) => ({
      title: [...button.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent)
        .join('')
        .trim(),
      shortcut: button.querySelector('kbd')?.textContent?.trim() ?? '',
      disabled: button.disabled === true,
    })),
  };
}

/** Page-side: the things the shortcut and menu rows compare before and after a key or a click. */
export function readEditorSnapshot() {
  const visible = (element) => {
    if (element === null) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const pressed = (selector) => {
    const element = document.querySelector(selector);
    return element === null ? null : element.getAttribute('aria-pressed') === 'true';
  };
  const timecodeElement = document.querySelector('[aria-label="Timecode"]');
  const timecode =
    timecodeElement === null
      ? null
      : (('value' in timecodeElement ? timecodeElement.value : timecodeElement.textContent) ?? '')
          .toString()
          .trim();
  const sign = (selector) => {
    const element = document.querySelector(selector);
    const html = element === null ? '' : element.outerHTML;
    let hash = 0;
    for (let index = 0; index < html.length; index += 1) {
      hash = (hash * 31 + html.charCodeAt(index)) | 0;
    }
    return `${html.length}:${hash}`;
  };
  const firstClip = document.querySelector('.timeline-clip[data-clip-id]');
  const zoomSlider = document.querySelector('input.timeline-zoom-slider');
  return {
    clips: [...document.querySelectorAll('.timeline-clip[data-clip-id]')].map((element) => ({
      id: element.getAttribute('data-clip-id'),
      selected: element.getAttribute('aria-pressed') === 'true',
      trackId: element.closest('[data-track-id]')?.getAttribute('data-track-id') ?? null,
    })),
    clipSignature:
      sign('.timeline-clip[data-clip-id]') + (firstClip === null ? '' : firstClip.className),
    zoom: zoomSlider === null ? null : zoomSlider.value,
    playing: [...document.querySelectorAll('.monitor-transport button')].some(
      (button) => button.getAttribute('aria-label') === 'Pause',
    ),
    tracks: new Set(
      [...document.querySelectorAll('[data-track-id]')].map((element) =>
        element.getAttribute('data-track-id'),
      ),
    ).size,
    markers: document.querySelectorAll('.timeline-marker').length,
    timecode,
    snapping: pressed('button[data-guide="Snapping"]'),
    selectTool: pressed('button[aria-label="Select tool"]'),
    splitTool: pressed('button[aria-label="Split tool"]'),
    loop: pressed('button[aria-label^="Loop on or off"]'),
    rangeSignature: `${sign('.timeline-ruler')}|${sign('.monitor-transport')}`,
    monitorSignature: sign('.monitor-selection-overlay') + sign('.monitor-transform-box'),
    monitorFocus: Boolean(document.activeElement?.closest?.('.monitor-canvas-wrap')),
    focusedElement: `${document.activeElement?.tagName ?? ''}:${document.activeElement?.getAttribute?.('aria-label') ?? ''}:${document.activeElement?.className?.toString?.() ?? ''}`,
    fullscreen: document.fullscreenElement !== null,
    paletteOpen: visible(document.querySelector('section.palette[role="dialog"]')),
    shortcutsOpen: visible(document.querySelector('.shortcuts-overlay[role="dialog"]')),
    dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(visible)
      .map((element) =>
        (element.getAttribute('aria-label') ?? element.className ?? '').toString().slice(0, 60),
      ),
  };
}

/** Page-side: is a dock panel with this label shown, is its tab the active one, does focus sit inside it. */
export function readPanelOpen(label) {
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const inside = [...document.querySelectorAll('[aria-label]')].filter(
    (element) =>
      element.getAttribute('aria-label') === label &&
      visible(element) &&
      element.closest('.app-menubar, .workspace-switcher, .palette, .header-group') === null,
  );
  const tabs = [...document.querySelectorAll('.dv-tab')].filter(
    (element) => element.textContent?.trim() === label,
  );
  return {
    shown: inside.length > 0,
    tabCount: tabs.length,
    tabActive: tabs.some((tab) => tab.classList.contains('dv-active-tab')),
    focused: inside.some((element) => element.contains(document.activeElement)),
  };
}

/** Page-side: every timeline clip with its screen box, and the playhead's x (null when it is not drawn). */
export function readTimelineBoxes() {
  const clips = [...document.querySelectorAll('.timeline-clip[data-clip-id]')].map((element) => {
    const box = element.getBoundingClientRect();
    return {
      id: element.getAttribute('data-clip-id'),
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      selected: element.getAttribute('aria-pressed') === 'true',
    };
  });
  const playhead = document.querySelector('.timeline-playhead');
  const box = playhead === null ? null : playhead.getBoundingClientRect();
  return { clips, playheadX: box === null ? null : box.left + box.width / 2 };
}

export async function snapshot(page) {
  return page.evaluate(readEditorSnapshot);
}

export async function readMenu(page) {
  return page.evaluate(readOpenMenu);
}

export async function readPaletteState(page) {
  return page.evaluate(readPalette);
}

/** Polls a snapshot until the predicate holds; returns it, or throws with the last one. */
export async function waitForSnapshot(page, predicate, why, { attempts = 20, stepMs = 150 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await snapshot(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(stepMs);
  }
  throw new Error(`${why}; last state: ${JSON.stringify(last)}`);
}

export async function openMenuGroup(page, label) {
  await page
    .locator(SEL.menuTrigger)
    .filter({ hasText: exactRegex(label) })
    .first()
    .click();
  await page.locator(SEL.dropdown).first().waitFor({ state: 'visible' });
  const menu = await readMenu(page);
  if (!menu.open || menu.group !== label) {
    throw new Error(`the ${label} menu did not open (the open menu is "${menu.group}")`);
  }
  return menu;
}

/** Opens the menu and returns its item, or throws when the item is missing. */
export async function menuItem(page, group, label) {
  const menu = await openMenuGroup(page, group);
  const item = menu.items.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(
      `${group} > ${label} is missing; the menu lists: ${menu.items.map((entry) => entry.label).join(', ')}`,
    );
  }
  return { item, menu };
}

/** Clicks a menu item. A disabled item throws, because the click would do nothing. */
export async function clickMenuItem(page, group, label) {
  const { item } = await menuItem(page, group, label);
  if (item.disabled) throw new Error(`${group} > ${label} is greyed out, so it cannot be clicked`);
  await page
    .locator(SEL.menuItemLabel)
    .filter({ hasText: exactRegex(label) })
    .first()
    .click();
  return item;
}

export async function closeMenus(page) {
  await page.keyboard.press('Escape');
}

export async function openPalette(page) {
  await page.keyboard.press('Control+KeyK');
  const state = await readPaletteState(page);
  if (!state.open) throw new Error('Ctrl+K did not open the command palette');
  return state;
}

export async function closePalette(page) {
  await page.keyboard.press('Escape');
}

/** Blurs the focused control so a bare key reaches the editor and not a button. */
export async function blurFocus(page) {
  await page.evaluate(function blurActiveElement() {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  });
}

const NAMED_KEYS = {
  space: 'Space',
  esc: 'Escape',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
  enter: 'Enter',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '=': 'Equal',
  '-': 'Minus',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '?': 'Shift+Slash',
};

const MODIFIERS = { ctrl: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' };

/** `Ctrl+Z` -> `Control+KeyZ`, `Shift+Delete` -> `Shift+Delete`, `?` -> `Shift+Slash`. One chord only. */
export function toPlaywrightChord(text) {
  const parts = String(text).split('+');
  const key = parts.pop();
  if (key === '' && parts.length > 0) {
    // "Ctrl++" style is not used in the shortcut table; refuse it instead of guessing.
    throw new Error(`cannot read the chord "${text}"`);
  }
  const modifiers = parts.map((part) => {
    const mapped = MODIFIERS[part.trim().toLowerCase()];
    if (mapped === undefined) throw new Error(`unknown modifier "${part}" in "${text}"`);
    return mapped;
  });
  const lower = key.trim().toLowerCase();
  let main = NAMED_KEYS[lower] ?? NAMED_KEYS[key.trim()];
  if (main === undefined) {
    if (/^[a-z]$/u.test(lower)) main = `Key${lower.toUpperCase()}`;
    else if (/^[0-9]$/u.test(lower)) main = `Digit${lower}`;
    else throw new Error(`cannot read the key "${key}" in "${text}"`);
  }
  return [...modifiers, main].join('+');
}

export async function pressChord(page, text) {
  await page.keyboard.press(toPlaywrightChord(text));
}

/** Makes the Create panel show one of its tools (media, text, captions, audio, templates). */
export async function openCreateTool(page, toolId) {
  const tab = page.locator(SEL.createTab(toolId)).first();
  if (!(await tab.isVisible().catch(() => false))) {
    await clickMenuItem(page, 'View', 'Create');
    await tab.waitFor({ state: 'visible' });
  }
  await tab.click();
  const selected = await tab.getAttribute('aria-selected');
  if (selected !== 'true') throw new Error(`the ${toolId} tab did not become the selected tab`);
}

/**
 * The project must hold at least `minClips` timeline clips. When it does not, the `--media` fixture is
 * imported (unless its card is already there) and added to the timeline. Without the fixture the row is blocked.
 */
export async function ensureTimelineClip(page, ctx, rowId, { minClips = 1 } = {}) {
  let state = await snapshot(page);
  for (let added = 0; state.clips.length < minClips; added += 1) {
    if (!ctx.media) {
      throw blockedRow(
        rowId,
        'needs --media <video file in C:\\jgp\\v111\\fixtures> so there is a clip on the timeline',
      );
    }
    if (added >= minClips + 1) {
      throw new Error(
        `adding ${basename(ctx.media)} did not put ${minClips} clip(s) on the timeline`,
      );
    }
    const name = basename(resolve(ctx.media));
    await openCreateTool(page, 'media');
    const cards = await page.locator('.asset-card', { hasText: name }).count();
    if (cards === 0) await importThroughLeftPanel(page, ctx.media);
    const previous = state.clips.length;
    await addToTimelineThroughLeftPanel(page, ctx.media);
    state = await waitForSnapshot(
      page,
      (now) => now.clips.length > previous,
      `adding ${name} did not add a clip`,
    );
  }
  return state;
}

export async function selectClipByIndex(page, index) {
  await page.locator(SEL.clip).nth(index).click();
}

/** The id of the clip that is in `after` and was not in `before` (snapshots), or undefined. */
export function addedClipId(before, after) {
  const known = new Set(before.clips.map((clip) => clip.id));
  return after.clips.find((clip) => !known.has(clip.id))?.id;
}

export async function selectClipById(page, clipId) {
  await page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first().click();
}

/** A picture of the Monitor only, saved as `<out>/<row>/preview-<slug>.png`. Returns the path, or null without an out folder. */
export async function previewShot(page, ctx, rowId, slug) {
  if (!ctx.outDir) return null;
  const path = join(ctx.outDir, rowId, `preview-${slug}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.locator('.monitor-canvas-wrap').first().screenshot({ path });
  return path;
}
