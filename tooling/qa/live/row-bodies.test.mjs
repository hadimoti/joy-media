/**
 * Runs the body of every T-A07 and T-A08 row (`LIVE_ROWS`) against the recording fake page, with a small scripted
 * editor. The fake knows the page-side readers by name and answers them with the state below, so each body
 * walks as far as that state allows.
 *
 * What a failure means: a body that throws a TypeError or a ReferenceError has a programming error (a missing
 * helper, a read of a value that does not exist, a selector constant that is misspelled and so reads as undefined,
 * which the fake rejects). A body that stops at a check it can see is a modelled app state, not a failure here:
 * the fake is not the app, so the first live run decides those. A body that makes no page call must refuse with
 * BLOCKED or NOT REACHABLE. Each body's stopping point is printed as a diagnostic, so the reach is visible.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MENU_SPEC, paletteSpec } from './actions.mjs';
import { createFakePage } from './fake-page.mjs';
import { PERSISTENCE_ROWS } from './desktop-persistence-steps.mjs';
import { LIVE_ROWS } from './matrix.mjs';

/** The label of a header menu, from the locator path: `filter({"hasText":"/^File$/u"})`. */
const MENU_LABEL = /app-menu-trigger.*"\/\^(.*)\$\/u"/u;
/** The dB the measured A07 bodies read, in call order: the full clip, the half volume, then the muted export. */
const MEASURED_DB = [-20, -26, -60];
const EXPORT_PROBE = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000000' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '2.000000' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
  ],
};

/** The editor state the scripted app keeps while a body runs. */
function scriptedApp() {
  const app = { openGroup: null, palette: false, exportsDone: 0, measures: 0, md5s: 0, values: {} };

  function menuOf(group) {
    const spec = MENU_SPEC.find((entry) => entry.group === group);
    if (spec === undefined) return { open: false, group: '', items: [] };
    return {
      open: true,
      group,
      items: spec.items.map((item) => ({
        label: item.label,
        shortcut: item.shortcut,
        disabled: item.disabled === true,
      })),
    };
  }

  function snapshot() {
    return {
      clips: [
        { id: 'clip-1', selected: true, trackId: 'track-v1' },
        { id: 'clip-2', selected: false, trackId: 'track-v2' },
      ],
      clipSignature: 'clips',
      zoom: '10',
      playing: false,
      tracks: 2,
      markers: 0,
      timecode: '00:00:00:00',
      snapping: true,
      selectTool: true,
      splitTool: false,
      loop: false,
      rangeSignature: 'range',
      monitorSignature: 'monitor',
      monitorFocus: false,
      focusedElement: '',
      fullscreen: false,
      paletteOpen: app.palette,
      shortcutsOpen: false,
      dialogs: [],
    };
  }

  function answer({ method, path, args, fn }) {
    // A filled field keeps its text, so the read-back check of a row sees what was typed.
    if (method === 'fill') {
      app.values[path] = String(args[0]);
      return undefined;
    }
    if (method === 'inputValue') return app.values[path] ?? '';
    // Tabs, preset choices and toggles that a row reads back report themselves as selected or pressed.
    if (method === 'getAttribute' && ['aria-selected', 'aria-pressed'].includes(args[0])) {
      return 'true';
    }
    if (method === 'click' && path.includes('app-menu-trigger')) {
      app.openGroup = path.match(MENU_LABEL)?.[1] ?? null;
      return undefined;
    }
    if (method === 'click' && path.includes('app-menu-item-label')) {
      app.openGroup = null;
      return undefined;
    }
    if (method === 'click' && app.palette && path.startsWith('getByRole("button"')) {
      app.palette = false;
      return undefined;
    }
    if (method === 'click' && path.includes('Export MP4')) {
      app.exportsDone += 1;
      return undefined;
    }
    if (method === 'press' && path === 'keyboard') {
      if (args[0] === 'Escape') {
        app.openGroup = null;
        app.palette = false;
      }
      if (args[0] === 'Control+KeyK') app.palette = true;
      return undefined;
    }
    if (method !== 'evaluate' && method !== 'evaluateAll') return undefined;
    switch (fn) {
      case 'readEditorSnapshot':
        return snapshot();
      case 'readPanelOpen':
        return { shown: true, tabCount: 1, tabActive: true, focused: true };
      case 'readOpenMenu':
        return app.openGroup === null
          ? { open: false, group: '', items: [] }
          : menuOf(app.openGroup);
      case 'readPalette':
        return app.palette
          ? {
              open: true,
              focused: true,
              items: paletteSpec().map((item) => ({
                title: item.label,
                shortcut: item.shortcut,
                disabled: false,
              })),
            }
          : { open: false, focused: false, items: [] };
      case 'readPaletteFocus':
        return app.palette;
      case 'readDialogTexts':
        return ['Export 1920 × 1080'];
      case 'readSettingsDialog':
        return {
          open: true,
          title: 'Joy Code Settings',
          nav: ['General', 'Models'],
          active: 'General',
        };
      case 'readModeCards':
        return [
          { name: 'Auto', selected: true },
          { name: 'Manual', selected: false },
        ];
      case 'readShortcutsDialog':
        return { open: false, groups: [] };
      case 'readVisibleFeatureToolIds':
        return [];
      case 'readTimelineBoxes':
        return {
          clips: [{ id: 'clip-1', left: 0, right: 40, top: 0, bottom: 10, selected: true }],
          playheadX: 50,
        };
      case 'readExportState':
        return { busy: false, toast: '' };
      case 'readInputRange':
        return { min: 0, max: 1, step: 0.01, value: 0.5 };
      case 'readControlKind':
        return 'range';
      case 'readOptionValues':
        return ['opt-1'];
      case 'readNodeLabels':
        return ['Add Blur'];
      case 'readNodeTexts':
        return ['Titles'];
      default:
        return undefined;
    }
  }

  return { app, answer };
}

/**
 * The injected helpers of a row, as the live runner has none: the frame hash, the loudness measure and the export
 * deps. The effects rows take them as their third argument (`deps`); the left-panel rows read `ctx.export`.
 */
function injectedFor({ app }) {
  const exportDeps = {
    list: () =>
      Array.from({ length: app.exportsDone }, (_unused, index) => `export-${index + 1}.mp4`),
    size: () => 1000,
    probe: () => EXPORT_PROBE,
    attempts: 3,
    copy: false,
  };
  return {
    md5: () => `hash-${++app.md5s}`,
    measure: () => MEASURED_DB[Math.min(app.measures++, MEASURED_DB.length - 1)],
    export: exportDeps,
  };
}

/** The context a row gets in this test: no output folder, a fake window, the injected helpers. */
function contextFor(page, injected) {
  return {
    page,
    outDir: undefined,
    downloadDir: 'C:\\scratch\\downloads',
    media: 'C:\\fixtures\\sample-audio.mp4',
    libraryDir: 'C:\\scratch\\library',
    projectTitle: 'T-A08 fake',
    allowClose: false,
    shot: async () => null,
    windowState: { get: async () => 'normal', set: async () => {} },
    export: injected.export,
    // The colour rows read the saved document (clip grades) through the matrix context.
    readDocument: async () => ({
      projectId: 'fake-project',
      document: {
        rootCompositionId: 'c',
        compositions: { c: { width: 1920, height: 1080 } },
        clipColorGrades: {},
      },
    }),
  };
}

function isProgrammingError(error) {
  // runParts wraps a part's mistake in its own Error and keeps the original as the cause.
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error?.cause instanceof TypeError ||
    error?.cause instanceof ReferenceError
  );
}

test('the fake page rejects a selector that is undefined, as a misspelled selector-table key reads', () => {
  const page = createFakePage();
  const selectors = { addButton: 'button.add' };
  assert.doesNotThrow(() => page.locator(selectors.addButton));
  assert.throws(() => page.locator(selectors.addButon), /page\.locator needs a string/u);
  assert.throws(() => page.getByRole(undefined), /page\.getByRole needs a string/u);
  assert.throws(() => page.locator('button').locator(undefined), /needs a string/u);
});

for (const row of LIVE_ROWS) {
  test(`${row.id} body runs against the fake page without a programming error`, async (t) => {
    const scripted = scriptedApp();
    const page = createFakePage({ answers: scripted.answer });
    const injected = injectedFor(scripted);
    let stoppedAt = 'the body finished';
    try {
      await row.run(page, contextFor(page, injected), injected);
    } catch (error) {
      stoppedAt = String(error?.message ?? error).split('\n')[0];
      if (isProgrammingError(error)) {
        const where =
          String(error.stack ?? '')
            .split('\n')[1]
            ?.trim() ?? '';
        assert.fail(`${row.id}: ${error.name}: ${error.message} (${where})`);
      }
    }
    t.diagnostic(`${row.id} made ${page.calls.length} page calls; stopped at: ${stoppedAt}`);
    // A body that refuses before it touches the page must say why (BLOCKED or NOT REACHABLE).
    if (page.calls.length === 0) assert.match(stoppedAt, /^(BLOCKED|NOT REACHABLE) /u);
  });
}

for (const row of PERSISTENCE_ROWS) {
  // Smoke coverage only: the fake page verifies row wiring and file-input calls, not package downloads or app state.
  test(`${row.id} body runs against the fake page without a programming error`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'a09-row-body-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const downloadDir = join(root, 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    const exportedPath = join(downloadDir, 'export.joyproject.json');
    const packageContents = JSON.stringify({
      media: [
        { asset: { displayName: 'h264-16x9-audio.mp4' }, status: 'embedded', dataBase64: 'eA==' },
      ],
    });
    const page = createFakePage({
      answers: ({ path, method, fn }) => {
        if (method === 'evaluate' && fn === 'readIds') {
          return {
            active: 'fake-project',
            title: 'A09 fake project',
            controlPlaneProjectId: 'fake-project',
            bindingCount: 1,
          };
        }
        if (method === 'evaluate' && fn === 'readTimeline') {
          return JSON.stringify({ id: 'fake-project', compositions: { c: { tracks: [] } } });
        }
        if (method === 'click' && path.includes('Export Editable Project')) {
          writeFileSync(exportedPath, packageContents, 'utf8');
          utimesSync(exportedPath, new Date(), new Date());
        }
        return undefined;
      },
    });
    let undone = false;
    const baseline = {
      id: 'fake-project',
      compositions: { c: { tracks: [] } },
    };
    const storedBaseline = { assets: {} };
    const overridden = {
      ...baseline,
      compositions: { c: { tracks: [{ clips: [{ id: 'new' }] }] } },
    };
    let stoppedAt = 'the body finished';
    try {
      await row.run(page, {
        editDocument: async () => {},
        fixtures: root,
        outDir: root,
        downloadDir,
        undo: async () => {
          undone = true;
        },
        async readDocument() {
          return {
            projectId: 'fake-project',
            storedDocument: storedBaseline,
            document:
              row.id === 'D-A09-05' &&
              !undone &&
              // The override is the second pick of the different video (the first one is the refused relink).
              page.calls.filter(
                (call) => call.includes('setInputFiles(') && call.includes('h264-16x9-silent.mp4'),
              ).length >= 2
                ? overridden
                : baseline,
          };
        },
        async restartApp() {
          return {
            page: createFakePage({
              answers: ({ method, fn }) => {
                if (method === 'evaluate' && fn === 'readIds') {
                  return {
                    active: 'fake-project',
                    title: 'A09 fake project',
                    controlPlaneProjectId: 'fake-project',
                    bindingCount: 1,
                  };
                }
                if (method === 'evaluate' && fn === 'readTimeline') {
                  return JSON.stringify({
                    id: 'fake-project',
                    compositions: { c: { tracks: [] } },
                  });
                }
                return undefined;
              },
            }),
          };
        },
        shot: async () => 'fake.png',
      });
    } catch (error) {
      stoppedAt = String(error?.message ?? error).split('\n')[0];
      if (isProgrammingError(error)) {
        assert.fail(`${row.id}: ${error.name}: ${error.message}`);
      }
    }
    t.diagnostic(`${row.id} made ${page.calls.length} page calls; stopped at: ${stoppedAt}`);
    if (row.id === 'D-A09-02') assert.match(stoppedAt, /^BLOCKED D-A09-02:/u);
    if (row.id === 'D-A09-03') {
      assert.ok(page.calls.some((call) => call.includes('.setInputFiles(')));
      assert.ok(page.calls.some((call) => call.includes('waitForFunction(')));
    }
    if (row.id === 'D-A09-04' || row.id === 'D-A09-05') {
      assert.ok(page.calls.some((call) => call.includes('setInputFiles')));
      assert.ok(page.calls.some((call) => call.includes('waitForFunction(')));
      assert.ok(page.calls.some((call) => call.includes('getByRole("button",{"name":"Review"')));
      assert.ok(
        page.calls.some((call) => call.includes('getByRole("dialog",{"name":"Missing media"')),
      );
      assert.ok(
        page.calls.some((call) => call.includes(`${row.id}`) && call.includes('missing-media')),
      );
    }
    if (row.id === 'D-A09-05') assert.equal(stoppedAt, 'the body finished');
    if (page.calls.length === 0) assert.match(stoppedAt, /^(BLOCKED|NOT REACHABLE) /u);
  });
}
