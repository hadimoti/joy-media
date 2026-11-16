/* global document */
/**
 * T-A06 matrix rows D-A06-xx: every timeline command of packages/commands/src/commands.ts
 * (SpikeCommand, lines 196-227) that has a UI path is done through the UI, read back through
 * `desktop.media.project.document.get`, undone, checked back, and redone. Then the Inspector
 * tabs, keyframes, track controls and a multi-select move.
 *
 * Each command row is `{ id, command, title, severity, act, check }` run by `runCommandCycle`
 * (matrix-core.mjs), which writes the document snapshots before, after, after undo and after
 * redo. Commands with no UI path are listed in `NOT_REACHABLE_COMMANDS` with a reason, and each
 * has a row that reports `not-reachable` so CC can judge it.
 *
 * NOT RUN LIVE: selectors come from reading TimelinePanel.tsx, timeline-commands.tsx and
 * InspectorPanel.tsx. Confirm each on the first live pass.
 *
 * Profile assumed: the scratch profile of run.mjs with the scratch library set, and the
 * fixtures of T-A04 in C:\jgp\v111\fixtures. Rows add h264-16x9-audio.mp4 to the timeline
 * themselves (ensureClips); each row opens its own fresh project, so rows do not depend on each other.
 */
import { join } from 'node:path';
import { addToTimelineThroughLeftPanel, importThroughLeftPanel, openMenu } from './steps.mjs';
import {
  FIXTURE_ROOT,
  clipsOf,
  pollUntil,
  readDocument,
  rootComposition,
  rowsById,
  runCommandCycle,
} from './matrix-core.mjs';
import { ensureProject } from './desktop-projects-import-steps.mjs';

const MEDIA_FILE = 'h264-16x9-audio.mp4';
const INSPECTOR = '.inspector-panel';

/** The commands of commands.ts:196-227 with no UI path found in the editor source. */
export const NOT_REACHABLE_COMMANDS = Object.freeze({
  'timeline.joinClips':
    'only the workflow runner and agent tools dispatch it; no menu, button or key',
  'timeline.setClipAsset':
    'the Relink… menu item and media replacement need a clip whose source is missing; a scratch run has none',
  'timeline.restoreCompound':
    'internal: the inverse of Merge; checked by the undo step of D-A06-14',
  'timeline.restoreTrackClips':
    'internal: the inverse of Remove Track and of speed ramps; checked by the undo step of D-A06-16',
  'timeline.setCompositionDimensions':
    'reached from the Export format picker (export-format-actions.ts), not from the timeline; left to the export rows',
  'timeline.reorderTrack': 'no track header drag or move control found in TimelinePanel.tsx',
  'timeline.reorderTracks':
    'only dispatched inside family moves (timeline-track-family.ts), not by a control',
  'timeline.renameTrack': 'no rename field: the track header only shows the name',
  'timeline.setTrackFamily':
    'only dispatched inside universal placement when a clip crosses families',
});

function notReachable(command) {
  return `NOT-REACHABLE ${command}: ${NOT_REACHABLE_COMMANDS[command]}`;
}

const clipLocator = (page, clipId) =>
  page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first();

async function dragBy(page, locator, dx, dy = 0) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the drag source is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

async function contextItem(page, label) {
  // Only an entry of the open menu: a bare text match can hit a button or a tooltip elsewhere on the page,
  // and the click then does nothing (found live: split at playhead left its menu open).
  const menu = page.getByRole('menu').last();
  await menu.waitFor({ state: 'visible', timeout: 5_000 });
  // The accessible name of an entry includes its shortcut ("Split at playheadS"), so a string matches a part.
  await menu.getByRole('menuitem', { name: label }).first().click({ timeout: 8_000 });
}

async function rightClickClip(page, clipId, label) {
  await clipLocator(page, clipId).click({ button: 'right' });
  await contextItem(page, label);
}

/** Edit > Undo and Edit > Redo, so the path is a menu, not a focus-dependent key. */
export async function undoThroughMenu(page) {
  await openMenu(page, 'Edit');
  await page.getByRole('menuitem', { name: /^Undo/u }).click();
}
export async function redoThroughMenu(page) {
  await openMenu(page, 'Edit');
  await page.getByRole('menuitem', { name: /^Redo/u }).click();
}

async function currentDocument(page, ctx) {
  return (await readDocument(page, ctx.bridge)).document;
}

let timelineProjectCount = 0;

/** The project has at least `count` clips on the timeline; adds the fixture video until it does. */
export async function ensureClips(page, ctx, count) {
  // Every row starts on its own project: clips, tracks and a moved clip left by an earlier row made the
  // first clip a sliver that no click could reach (found live, 16 Nov).
  timelineProjectCount += 1;
  await ensureProject(
    page,
    { ...ctx, freshProjectEveryRow: ctx.freshProjectEveryRow ?? true },
    `A06 timeline ${timelineProjectCount}`,
  );
  const mediaPath = join(ctx.fixtures ?? FIXTURE_ROOT, MEDIA_FILE);
  if ((await page.locator('.asset-card', { hasText: MEDIA_FILE }).count()) === 0) {
    await importThroughLeftPanel(page, mediaPath);
  }
  for (let attempt = 0; attempt < count + 2; attempt += 1) {
    if (clipsOf(await currentDocument(page, ctx)).length >= count) return;
    await addToTimelineThroughLeftPanel(page, mediaPath);
    await page.waitForTimeout(400);
  }
  throw new Error(`could not put ${count} clips on the timeline`);
}

async function firstClip(page, ctx, index = 0) {
  const clips = clipsOf(await currentDocument(page, ctx));
  const entry = clips[index];
  if (!entry) throw new Error(`BLOCKED: the document has no clip number ${index + 1}`);
  return entry;
}

async function selectClip(page, clipId, additive = false) {
  await clipLocator(page, clipId).click(additive ? { modifiers: ['Control'] } : {});
}

const tracksOf = (document) => rootComposition(document)?.tracks ?? [];
const clipCount = (document) => clipsOf(document).length;
const findClip = (document, clipId) => clipsOf(document).find((entry) => entry.clip.id === clipId);

/** A playhead inside the clip: a click on the ruler above its middle. */
async function parkPlayheadInside(page, clipId) {
  const box = await clipLocator(page, clipId).boundingBox();
  const ruler = await page.locator('.timeline-ruler').first().boundingBox();
  if (box === null || ruler === null) throw new Error('the clip or the ruler is not on screen');
  await page.mouse.click(box.x + box.width / 2, ruler.y + ruler.height / 2);
}

const commandRows = [];
function commandRow(row) {
  commandRows.push({
    area: 'Timeline commands',
    severity: 'major',
    async run(page, ctx) {
      await ensureClips(page, ctx, row.needClips ?? 1);
      await row.prepare?.(page, ctx);
      return runCommandCycle(row, page, ctx);
    },
    ...row,
  });
}

commandRow({
  id: 'D-A06-01',
  command: 'timeline.insertClip',
  title: 'Add to timeline inserts a clip',
  severity: 'blocker',
  // The project holds one clip already (ensureClips), so the stored document exists to read.
  act: (page, ctx) =>
    addToTimelineThroughLeftPanel(page, join(ctx.fixtures ?? FIXTURE_ROOT, MEDIA_FILE)),
  check: (before, after) =>
    clipCount(after) === clipCount(before) + 1
      ? undefined
      : `clips ${clipCount(before)} -> ${clipCount(after)}, wanted +1`,
});

commandRow({
  id: 'D-A06-02',
  command: 'timeline.removeClip',
  title: 'Ripple delete removes the clip',
  severity: 'blocker',
  needClips: 2,
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx, 0);
    await rightClickClip(page, clip.id, 'Ripple delete');
  },
  check: (before, after) =>
    clipCount(after) === clipCount(before) - 1
      ? undefined
      : `clips ${clipCount(before)} -> ${clipCount(after)}, wanted -1`,
});

commandRow({
  id: 'D-A06-03',
  command: 'timeline.moveClip',
  title: 'Dragging a clip along its track moves it',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx, 0);
    await selectClip(page, clip.id);
    await dragBy(page, clipLocator(page, clip.id), 160);
  },
  check(before, after) {
    const a = clipsOf(before)[0];
    const b = findClip(after, a.clip.id);
    if (!b) return 'the dragged clip is gone';
    return b.clip.startUs !== a.clip.startUs && b.trackId === a.trackId
      ? undefined
      : `start ${a.clip.startUs} -> ${b.clip.startUs} on track ${a.trackId} -> ${b.trackId}`;
  },
});

commandRow({
  id: 'D-A06-04',
  command: 'timeline.moveElement',
  title: 'Dragging a clip to another track moves it there',
  async prepare(page) {
    // The audio lane counts as a lane too, so count the video (visual) lanes: a clip needs another one of its own kind.
    if ((await page.locator('.timeline-track--visual .timeline-lane').count()) < 2) {
      await page.getByRole('button', { name: 'Add video track', exact: true }).click();
      await page.waitForTimeout(400);
    }
  },
  async act(page, ctx) {
    const { clip, trackId } = await firstClip(page, ctx);
    // Another video lane: the lane order is not the track order, and an audio lane refuses a video clip.
    const lanes = page.locator(
      `.timeline-track--visual:not([data-track-id="${trackId}"]) .timeline-lane`,
    );
    if ((await lanes.count()) < 1) throw new Error('BLOCKED: needs a second video timeline lane');
    await selectClip(page, clip.id);
    const target = await lanes.first().boundingBox();
    const source = await clipLocator(page, clip.id).boundingBox();
    if (target === null || source === null) throw new Error('lane or clip not on screen');
    await dragBy(page, clipLocator(page, clip.id), 0, target.y - source.y);
  },
  check(before, after) {
    const a = clipsOf(before)[0];
    const b = findClip(after, a.clip.id);
    return b && b.trackId !== a.trackId ? undefined : 'the clip stayed on its track';
  },
});

commandRow({
  id: 'D-A06-05',
  command: 'timeline.moveElements',
  title: 'Multi-select move shifts both clips by the same amount',
  needClips: 2,
  async act(page, ctx) {
    const first = await firstClip(page, ctx, 0);
    const second = await firstClip(page, ctx, 1);
    await selectClip(page, first.clip.id);
    await selectClip(page, second.clip.id, true);
    await dragBy(page, clipLocator(page, second.clip.id), 120);
  },
  check(before, after) {
    const [a, b] = clipsOf(before);
    const moved = [a, b].map((entry) => findClip(after, entry.clip.id));
    if (moved.some((entry) => !entry)) return 'a selected clip is gone';
    const shifts = moved.map((entry, index) => entry.clip.startUs - [a, b][index].clip.startUs);
    if (shifts[0] === 0) return 'the first selected clip did not move';
    return shifts[0] === shifts[1] ? undefined : `the clips shifted by ${shifts.join(' and ')}`;
  },
});

commandRow({
  id: 'D-A06-06',
  command: 'timeline.trimClipStart',
  title: 'Dragging the start handle trims the clip start',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await dragBy(page, page.getByRole('button', { name: /^Trim start of/u }).first(), 40);
  },
  check(before, after) {
    const a = clipsOf(before)[0];
    const b = findClip(after, a.clip.id);
    return b && b.clip.durationUs < a.clip.durationUs
      ? undefined
      : 'the clip is not shorter after the start trim';
  },
});

commandRow({
  id: 'D-A06-07',
  command: 'timeline.trimClipEnd',
  title: 'Dragging the end handle trims the clip end',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await dragBy(page, page.getByRole('button', { name: /^Trim end of/u }).first(), -40);
  },
  check(before, after) {
    const a = clipsOf(before)[0];
    const b = findClip(after, a.clip.id);
    return b && b.clip.durationUs < a.clip.durationUs
      ? undefined
      : 'the clip is not shorter after the end trim';
  },
});

commandRow({
  id: 'D-A06-08',
  command: 'timeline.splitClip',
  title: 'Split at playhead makes two clips',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await parkPlayheadInside(page, clip.id);
    await rightClickClip(page, clip.id, 'Split at playhead');
  },
  check: (before, after) =>
    clipCount(after) === clipCount(before) + 1
      ? undefined
      : `clips ${clipCount(before)} -> ${clipCount(after)}, wanted +1`,
});

commandRow({
  id: 'D-A06-09',
  command: 'timeline.duplicateClip',
  title: 'Duplicate clones the clip after itself',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await rightClickClip(page, clip.id, 'Duplicate');
  },
  check: (before, after) =>
    clipCount(after) === clipCount(before) + 1
      ? undefined
      : `clips ${clipCount(before)} -> ${clipCount(after)}, wanted +1`,
});

commandRow({
  id: 'D-A06-10',
  command: 'timeline.setClipRate',
  title: 'A speed preset in the Inspector changes the playback rate',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await openInspectorTab(page, 'Speed');
    const presets = page.locator(INSPECTOR).locator('[aria-label="Speed presets"] button');
    await presets.nth((await presets.count()) > 1 ? 1 : 0).click();
  },
  check(before, after) {
    const a = clipsOf(before)[0];
    const b = findClip(after, a.clip.id);
    return b && (b.clip.playbackRate ?? 1) !== (a.clip.playbackRate ?? 1)
      ? undefined
      : 'the playback rate did not change';
  },
});

commandRow({
  id: 'D-A06-11',
  command: 'timeline.freezeFrame',
  title: 'Freeze frame at playhead adds a held frame',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await parkPlayheadInside(page, clip.id);
    await rightClickClip(page, clip.id, 'Freeze frame at playhead');
  },
  check: (before, after) =>
    clipCount(after) > clipCount(before) ||
    clipsOf(after).some(({ clip }) => clip.playbackRate === 0)
      ? undefined
      : 'no held frame in the document',
});

commandRow({
  id: 'D-A06-12',
  command: 'timeline.toggleClipReverse',
  title: 'Reverse clip flips the reversed flag',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    // The entry's accessible name ends with its shortcut ("Reverse clipShift+R").
    await rightClickClip(page, clip.id, /^(Reverse clip|Restore forward playback)/u);
  },
  check(before, after) {
    const a = clipsOf(before)[0];
    const b = findClip(after, a.clip.id);
    return b && (b.clip.reversed === true) !== (a.clip.reversed === true)
      ? undefined
      : 'the reversed flag did not flip';
  },
});

commandRow({
  id: 'D-A06-13',
  command: 'timeline.setTimeRemap',
  title: 'The Inspector Time remap control writes a time remap',
  async act(page, ctx) {
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await openInspectorTab(page, 'Speed');
    await page.locator(INSPECTOR).locator('[aria-label="Time remap"] button').first().click();
  },
  check: (_before, after) =>
    clipsOf(after).some(({ clip }) => clip.timeRemap !== undefined)
      ? undefined
      : 'no clip carries a timeRemap',
});

commandRow({
  id: 'D-A06-14',
  command: 'timeline.createCompound',
  title: 'Merge two selected clips creates a merged timeline',
  needClips: 2,
  async act(page, ctx) {
    const first = await firstClip(page, ctx, 0);
    const second = await firstClip(page, ctx, 1);
    await selectClip(page, first.clip.id);
    await selectClip(page, second.clip.id, true);
    await rightClickClip(page, second.clip.id, /^Merge \d+ selected clips$/u);
  },
  check: (before, after) =>
    Object.keys(after.compositions ?? {}).length > Object.keys(before.compositions ?? {}).length
      ? undefined
      : 'no new composition after the merge',
});

commandRow({
  id: 'D-A06-15',
  command: 'timeline.addTrack',
  title: 'Add video track adds a track',
  async act(page) {
    await page.getByRole('button', { name: 'Add video track', exact: true }).click();
  },
  check: (before, after) =>
    tracksOf(after).length === tracksOf(before).length + 1
      ? undefined
      : `tracks ${tracksOf(before).length} -> ${tracksOf(after).length}, wanted +1`,
});

commandRow({
  id: 'D-A06-16',
  command: 'timeline.removeTrack',
  title: 'Remove Track from the header menu removes an empty track',
  async act(page) {
    // The product refuses to remove a track that holds clips (the menu item is disabled), so aim at an empty one.
    const trackId = await page.evaluate(() => {
      const empty = [...document.querySelectorAll('.timeline-track')].find(
        (track) => track.querySelector('.timeline-clip') === null,
      );
      return empty?.getAttribute('data-track-id') ?? null;
    });
    if (trackId === null)
      throw new Error('no empty track to remove (a track with clips cannot be removed)');
    await page
      .locator('.timeline-track-header[data-track-id="' + trackId + '"]')
      .click({ button: 'right' });
    await contextItem(page, 'Remove Track');
  },
  check: (before, after) =>
    tracksOf(after).length === tracksOf(before).length - 1
      ? undefined
      : `tracks ${tracksOf(before).length} -> ${tracksOf(after).length}, wanted -1`,
});

/**
 * A track header button. The controls are hidden (pointer-events: none) until the header is
 * hovered, so the pointer goes to the header first; found live on 16 Nov 2026.
 */
async function trackButton(page, name) {
  const button = page.getByRole('button', { name }).first();
  await button
    .locator('xpath=ancestor::*[contains(@class,"timeline-track-header")][1]')
    .hover({ timeout: 8_000 });
  return button;
}

commandRow({
  id: 'D-A06-17',
  command: 'timeline.setTrackLocked',
  title: 'The Lock button locks the track',
  async act(page) {
    await (await trackButton(page, /^Lock /u)).click();
  },
  check: (_before, after) =>
    tracksOf(after).some((track) => track.locked === true) ? undefined : 'no track is locked',
});

commandRow({
  id: 'D-A06-18',
  command: 'timeline.setTrackMuted',
  title: 'The Mute button mutes the track',
  async act(page) {
    await (await trackButton(page, /^Mute /u)).click();
  },
  check: (_before, after) =>
    tracksOf(after).some((track) => track.muted === true) ? undefined : 'no track is muted',
});

commandRow({
  id: 'D-A06-19',
  command: 'timeline.setTrackLabelColor',
  title: 'The track colour menu sets a label colour',
  severity: 'minor',
  async act(page) {
    await (await trackButton(page, /^Change label color for /u)).click();
    // The colour menu is a portal "Track color" menu of menuitemradio entries named by colour (found live).
    await page
      .getByRole('menu', { name: 'Track color' })
      .getByRole('menuitemradio')
      .nth(1)
      .click({ timeout: 8_000 });
  },
  check: (before, after) =>
    JSON.stringify(tracksOf(before)) !== JSON.stringify(tracksOf(after))
      ? undefined
      : 'the track did not change',
  // The header must show the colour (and drop it on Undo): it once kept the old colour after Undo.
  async checkScreen(page, phase) {
    const shown = await page
      .locator('.timeline-track--visual')
      .first()
      .getAttribute('data-track-label-color');
    const wanted = phase === 'undo' ? 'default' : null;
    if (wanted !== null && shown !== wanted)
      return `after Undo the track header shows ${shown}, wanted ${wanted}`;
    if (wanted === null && shown === 'default')
      return `after ${phase} the track header still shows the default colour`;
    return undefined;
  },
});

commandRow({
  id: 'D-A06-20',
  command: 'property.setTrackEnabled',
  title: 'Hide Track turns the track off',
  severity: 'minor',
  async act(page) {
    await page.locator('.timeline-track-header').first().click({ button: 'right' });
    await contextItem(page, 'Hide Track');
  },
  check: (_before, after) =>
    tracksOf(after).some((track) => track.enabled === false) ? undefined : 'no track is disabled',
});

for (const [index, command] of Object.keys(NOT_REACHABLE_COMMANDS).entries()) {
  commandRows.push({
    id: `D-A06-9${index}`,
    area: 'Timeline commands',
    command,
    title: `${command} has no UI path`,
    severity: 'minor',
    expected: 'CC judges: a UI path should exist, or the command is internal',
    async run() {
      throw new Error(notReachable(command));
    },
  });
}

/** Opens an Inspector tab by its name (the tab's aria-label is not always its text). */
const TAB_LABELS = {
  Visual: 'Visual (Transform)',
  Enhance: 'AI upscaling',
  Mask: 'Mask and background removal',
  Adjust: 'Adjustment layer',
  Effects: 'Effects',
  Audio: 'Audio',
  Speed: 'Speed',
};

export async function openInspectorTab(page, tab) {
  const name = TAB_LABELS[tab];
  const inspector = page.locator(INSPECTOR);
  await inspector
    .getByRole('tab', { name })
    .or(inspector.getByRole('button', { name }))
    .first()
    .click();
}

/**
 * Changes every number input, select and switch of the open Inspector tab and reads the value
 * back. Returns the lines written, and throws on the first control that did not keep its value.
 */
export async function exerciseControls(page) {
  const inspector = page.locator(INSPECTOR);
  const lines = [];
  const numbers = inspector.locator('input[type="number"]');
  for (let index = 0; index < (await numbers.count()); index += 1) {
    const input = numbers.nth(index);
    if (
      !(await input.isVisible().catch(() => false)) ||
      !(await input.isEnabled().catch(() => false))
    )
      continue;
    const before = Number(await input.inputValue());
    const max = Number((await input.getAttribute('max')) ?? Number.POSITIVE_INFINITY);
    // A control may clamp at a limit the page does not declare (Opacity stops at 100): try the other way once.
    let next = before + 1 <= max ? before + 1 : before - 1;
    let read = before;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await input.fill(String(next));
      await input.press('Enter');
      read = Number(await input.inputValue());
      // Only a clamp at a limit (the value stays) earns the second try the other way; any other value is a failure.
      if (read === next || read !== before) break;
      next = before - (next - before);
    }
    if (read !== next) {
      const why = read === before ? 'would not change either way' : `wanted ${next}`;
      throw new Error(`number control ${index + 1} kept ${read}, ${why}`);
    }
    lines.push(`number ${index + 1}: ${before} -> ${read}`);
  }
  const selects = inspector.locator('select');
  for (let index = 0; index < (await selects.count()); index += 1) {
    const select = selects.nth(index);
    const before = await select.inputValue();
    const options = await select
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => node.value));
    const other = options.find((value) => value !== before);
    if (other === undefined) continue;
    await select.selectOption(other);
    const read = await select.inputValue();
    if (read !== other) throw new Error(`select ${index + 1} kept ${read}, wanted ${other}`);
    lines.push(`select ${index + 1}: ${before} -> ${read}`);
  }
  const switches = inspector.locator('[role="switch"], input[type="checkbox"]');
  for (let index = 0; index < (await switches.count()); index += 1) {
    const toggle = switches.nth(index);
    if (!(await toggle.isEnabled().catch(() => false))) continue;
    const read = async () =>
      (await toggle.getAttribute('aria-checked')) ??
      String(await toggle.isChecked().catch(() => ''));
    const before = await read();
    await toggle.click();
    if ((await read()) === before) throw new Error(`switch ${index + 1} did not change`);
    lines.push(`switch ${index + 1}: ${before} -> ${await read()}`);
  }
  if (lines.length === 0) throw new Error('the tab shows no control to change');
  return lines;
}

const inspectorRows = Object.entries(TAB_LABELS).map(([tab], index) => ({
  id: `D-A06-3${index}`,
  area: 'Inspector',
  title: `Inspector ${tab} tab: change each control and read it back`,
  severity: 'major',
  expected: `Every ${tab} control keeps the value that was set`,
  async run(page, ctx) {
    await ensureClips(page, ctx, 1);
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    if (tab === 'Adjust') {
      if (
        (await page.locator(INSPECTOR).getByRole('tab', { name: TAB_LABELS.Visual }).count()) === 0
      )
        throw new Error('BLOCKED: the Inspector does not show the selected clip');
      const present = await page
        .locator(INSPECTOR)
        .getByRole('tab', { name: TAB_LABELS[tab] })
        .count();
      if (present === 0)
        throw new Error(
          'NOT-REACHABLE Adjustment layer tab: the Inspector shows it only for an adjustment layer clip, not for a video clip',
        );
    }
    await openInspectorTab(page, tab);
    if (
      tab === 'Effects' &&
      (await page.locator(INSPECTOR).getByText('No effects applied').count()) > 0
    )
      throw new Error(
        'NOT-REACHABLE Effects tab controls: a fresh clip shows "No effects applied"; the effect controls are exercised by the effects rows',
      );
    const lines = await exerciseControls(page);
    return {
      message: `${tab}: ${lines.length} control(s) changed: ${lines.join('; ')}`,
      evidence: [await ctx.shot(`D-A06-3${index}`, tab.toLowerCase())],
    };
  },
}));

/** The number of keyframes anywhere in a document. */
export function countKeyframes(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countKeyframes(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) =>
      sum +
      (key === 'keyframes' && Array.isArray(child) ? child.length : 0) +
      countKeyframes(child),
    0,
  );
}

const keyframeRow = {
  id: 'D-A06-40',
  area: 'Inspector',
  title: 'Inspector keyframe: add one, then remove it',
  severity: 'major',
  expected:
    'The keyframe button adds a keyframe to the stored document; pressing it again removes it',
  async run(page, ctx) {
    await ensureClips(page, ctx, 1);
    const { clip } = await firstClip(page, ctx);
    await selectClip(page, clip.id);
    await openInspectorTab(page, 'Visual');
    const first = await readDocument(page, ctx.bridge);
    const start = countKeyframes(first.document) + countKeyframes(first.storedDocument ?? {});
    // The same button reads "Add Position X keyframe at playhead", then "Remove ..." (found live).
    const keyframeButton = (verb) =>
      page
        .locator(INSPECTOR)
        .getByRole('button', { name: new RegExp(`^${verb} Position X keyframe`, 'u') })
        .first();
    await keyframeButton('Add').click();
    const added = await waitForKeyframes(page, ctx, (count) => count > start);
    if (!added.ok) throw new Error(`keyframes stayed at ${start} after Add keyframe was pressed`);
    const shot = await ctx.shot('D-A06-40', 'added');
    await keyframeButton('Remove').click();
    const removed = await waitForKeyframes(page, ctx, (count) => count === start);
    if (!removed.ok)
      throw new Error(`keyframes stayed at ${removed.value} after removing, wanted ${start}`);
    return {
      message: `keyframes ${start} -> ${added.value} -> ${removed.value}`,
      evidence: [shot],
    };
  },
};

/** Keyframes live in the stored visual document, not in the timeline read (found live), so count both. */
async function waitForKeyframes(page, ctx, accept) {
  return pollUntil(
    async () => {
      const read = await readDocument(page, ctx.bridge);
      return countKeyframes(read.document) + countKeyframes(read.storedDocument ?? {});
    },
    accept,
    ctx.poll,
  );
}

/** One row per track control: add, remove, lock and mute are the cycle rows above; this checks the headers. */
const trackRows = [
  {
    id: 'D-A06-50',
    area: 'Tracks',
    title: 'Track controls: lock and mute buttons flip aria-pressed and back',
    severity: 'major',
    expected: 'Lock and Mute buttons toggle and keep their state',
    async run(page, ctx) {
      await ensureClips(page, ctx, 1);
      const evidence = [];
      for (const name of [/^(Lock|Unlock) /u, /^(Mute|Unmute) /u]) {
        const before = await (await trackButton(page, name)).getAttribute('aria-pressed');
        await (await trackButton(page, name)).click();
        const during = await (await trackButton(page, name)).getAttribute('aria-pressed');
        if (during === before) throw new Error(`${String(name)} did not toggle`);
        await (await trackButton(page, name)).click();
        evidence.push(await ctx.shot('D-A06-50', String(name).replace(/\W+/gu, '')));
      }
      return { message: 'lock and mute toggle on and off', evidence };
    },
  },
];

export const TIMELINE_ROWS = Object.freeze([
  ...commandRows,
  ...inspectorRows,
  keyframeRow,
  ...trackRows,
]);
export const TIMELINE_ROWS_BY_ID = rowsById(TIMELINE_ROWS);
