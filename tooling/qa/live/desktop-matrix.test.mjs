import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createBridge,
  createBridgeLog,
  executeRow,
  formatDefectEntry,
  normalizeDocument,
  readDocument,
  runCommandCycle,
  stableStringify,
} from './matrix-core.mjs';
import {
  IMPORT_FIXTURES,
  PROJECTS_IMPORT_ROWS,
  PROJECTS_IMPORT_ROWS_BY_ID,
} from './desktop-projects-import-steps.mjs';
import { PERSISTENCE_ROWS } from './desktop-persistence-steps.mjs';
import {
  NOT_REACHABLE_COMMANDS,
  TIMELINE_ROWS,
  TIMELINE_ROWS_BY_ID,
  countKeyframes,
  exerciseControls,
} from './desktop-timeline-steps.mjs';
import { MATRIX_IDS, MATRIX_ROWS, createMatrixContext } from './desktop-matrix-rows.mjs';
import { createFakePage } from './fake-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A fake app: a stored document behind `window.joyDesktop.invoke`, the editor's local storage,
 * and a page whose locators record clicks. `evaluate` runs the real function with fake globals.
 */
function createFakeApp({
  doc = { id: 'p', rootCompositionId: 'c', compositions: { c: { tracks: [] } } },
} = {}) {
  const world = {
    doc,
    revision: 1,
    undoStack: [],
    redoStack: [],
    clicks: [],
    fills: [],
    drags: [],
    pressed: new Set(),
    groups: [],
    values: {},
    textByKey: {},
    countByKey: {},
    bridgeReplies: {
      'desktop.asset-library.get-settings': { directory: 'C:\\scratch\\library' },
      'desktop.asset-library.get-catalog': { assets: [] },
    },
    boundProject: true,
  };
  const invoke = async (channel, payload) => {
    if (channel === 'desktop.media.project.document.get') {
      return {
        projectId: payload.projectId,
        revisionId: `r${world.revision}`,
        document: world.doc,
      };
    }
    if (channel in world.bridgeReplies) return world.bridgeReplies[channel];
    throw new Error(`unexpected channel ${channel}`);
  };
  const storage = {
    getItem(key) {
      if (key === 'joy-media.active-project.v1') return JSON.stringify({ projectId: 'ed-1' });
      if (key === 'joy-media.project-catalog.v1') {
        return JSON.stringify({
          projects: { 'ed-1': { title: 'Test', timelineProjectId: 'ed-1' } },
        });
      }
      if (key === 'joy-media.control-plane-project-bindings.v1' && world.boundProject) {
        return JSON.stringify({
          bindingsByOwner: {
            local: { 'ed-1': { editorProjectId: 'ed-1', controlPlaneProjectId: 'project-1' } },
          },
        });
      }
      return null;
    },
  };
  const edit = (next) => {
    world.undoStack.push(world.doc);
    world.redoStack = [];
    world.doc = next;
    world.revision += 1;
  };
  const locator = (key) => {
    const self = {
      first: () => self,
      last: () => self,
      nth: (n) => locator(`${key}#${n}`),
      or: () => self,
      filter: () => self,
      locator: (selector) => locator(`${key}>${selector}`),
      getByRole: (role, options) => locator(`${key}>${role}:${options?.name}`),
      getByLabel: (label) => locator(`${key}>label:${label}`),
      getByText: (text) => locator(`${key}>text:${text}`),
      async click() {
        world.clicks.push(key);
        const group = world.groups.find((members) => members.includes(key));
        if (group) {
          for (const member of group) world.pressed.delete(member);
          world.pressed.add(key);
        }
        world.onClick?.(key);
      },
      async hover() {},
      async setInputFiles(path) {
        world.uploads = [...(world.uploads ?? []), path];
      },
      async fill(value) {
        world.fills.push([key, value]);
        world.values[key] = value;
      },
      async press() {},
      async waitFor() {},
      async dragTo() {
        world.drags.push(key);
      },
      async isVisible() {
        return true;
      },
      async isEnabled() {
        return true;
      },
      async count() {
        return world.countByKey[key] ?? 1;
      },
      async getAttribute(name) {
        return name === 'aria-pressed'
          ? String(world.pressed.has(key))
          : (world.attrs?.[`${key}|${name}`] ?? null);
      },
      async inputValue() {
        return world.values[key] ?? '';
      },
      async innerText() {
        return world.textByKey[key] ?? '';
      },
      async boundingBox() {
        return { x: 0, y: 0, width: 100, height: 20 };
      },
      async selectOption(value) {
        world.values[key] = value;
      },
      async evaluateAll() {
        return world.optionsByKey?.[key] ?? [];
      },
    };
    return self;
  };
  const page = {
    world,
    getByRole: (role, options) => locator(`${role}:${options?.name}`),
    getByLabel: (label) => locator(`label:${label}`),
    getByText: (text) => locator(`text:${text}`),
    locator: (selector) => locator(selector),
    keyboard: { async press() {}, async down() {}, async up() {} },
    mouse: { async move() {}, async down() {}, async up() {}, async click() {} },
    async waitForTimeout() {},
    async waitForFunction() {
      return true;
    },
    async evaluate(fn, arg) {
      const previousWindow = globalThis.window;
      const previousStorage = globalThis.localStorage;
      globalThis.window = { joyDesktop: { invoke } };
      globalThis.localStorage = storage;
      try {
        return await fn(arg);
      } finally {
        globalThis.window = previousWindow;
        globalThis.localStorage = previousStorage;
      }
    },
  };
  return { world, page, edit, invoke };
}

function makeContext(t, app) {
  const outDir = scratch(t);
  const log = createBridgeLog(join(outDir, 'bridge-replies.jsonl'));
  return {
    outDir,
    fixtures: 'C:\\jgp\\v111\\fixtures',
    libraryDir: 'C:\\scratch\\library',
    altLibraryDir: join(outDir, 'alt'),
    runTag: 'test',
    freshProjectEveryRow: false,
    bridge: createBridge(app.page, log),
    bridgeLogPath: join(outDir, 'bridge-replies.jsonl'),
    poll: { timeoutMs: 60, intervalMs: 5 },
    async shot(rowId, name) {
      return `${rowId}-${name}.png`;
    },
    async undo() {
      app.world.redoStack.push(app.world.doc);
      app.world.doc = app.world.undoStack.pop();
    },
    async redo() {
      app.world.undoStack.push(app.world.doc);
      app.world.doc = app.world.redoStack.pop();
    },
  };
}

test('stableStringify sorts keys and skips undefined; normalizeDocument ignores updatedAt', () => {
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] }),
    '{"a":[2,{"d":1}],"b":1}',
  );
  assert.equal(
    normalizeDocument({ id: 'x', updatedAt: 'one', tracks: [] }),
    normalizeDocument({ tracks: [], id: 'x', updatedAt: 'two' }),
  );
  assert.notEqual(normalizeDocument({ id: 'x' }), normalizeDocument({ id: 'y' }));
});

test('formatDefectEntry carries every T-A16 field and leaves the ID to CC', () => {
  const text = formatDefectEntry({
    foundBy: 'D-A05-60',
    title: 'Export fails',
    what: 'cannot resolve visual asset',
    expected: 'export finishes',
    severity: 'major',
    evidence: ['a.png'],
  });
  for (const field of [
    'ID: X-???',
    'Found by: D-A05-60',
    'What happens: cannot resolve visual asset',
    'Expected: export finishes',
    'Severity: major',
    'Owner agent:',
    'Branch:',
    'Status: open',
    'Retest result: not rerun',
    'Evidence: a.png',
  ]) {
    assert.ok(text.includes(field), `missing ${field}`);
  }
});

test('the bridge log keeps only media and asset-library channels and truncates long replies', (t) => {
  const file = join(scratch(t), 'bridge-replies.jsonl');
  const log = createBridgeLog(file, { now: () => 'T' });
  log.setLabel('step');
  assert.equal(log.record('desktop.window-close', {}, { ok: true, reply: 1 }), undefined);
  log.record('desktop.media.asset.register', { a: 1 }, { ok: true, reply: 'x'.repeat(9000) });
  log.record('desktop.asset-library.get-settings', {}, { ok: false, error: 'nope' }, 'ui');
  const lines = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].truncated, true);
  assert.equal(lines[0].step, 'step');
  assert.deepEqual([lines[1].ok, lines[1].origin, lines[1].reply], [false, 'ui', '"nope"']);
});

test('bridge.invoke logs the reply, and throws on a refusal after logging it', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  const reply = await ctx.bridge.invoke('desktop.asset-library.get-settings', {});
  assert.equal(reply.directory, 'C:\\scratch\\library');
  await assert.rejects(ctx.bridge.invoke('desktop.media.unknown', {}), /unexpected channel/u);
  assert.deepEqual(
    ctx.bridge.log.entries.map((entry) => entry.ok),
    [true, false],
  );
});

test('the in-page tap records UI calls and drainTap moves them into the log', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  // The tap wraps window.joyDesktop; the fake rebuilds window per evaluate, so keep one window.
  const window = { joyDesktop: { invoke: app.invoke } };
  const page = {
    async evaluate(fn, arg) {
      globalThis.window = window;
      try {
        return await fn(arg);
      } finally {
        delete globalThis.window;
      }
    },
  };
  const bridge = createBridge(page, ctx.bridge.log);
  assert.equal(await bridge.installTap(), true);
  globalThis.window = window;
  await window.joyDesktop.invoke('desktop.asset-library.get-catalog', {});
  delete globalThis.window;
  assert.equal(await bridge.drainTap(), 1);
  assert.equal(ctx.bridge.log.entries.at(-1).origin, 'ui');
});

test('readDocument finds the bridge project id from local storage, and blocks without one', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  const view = await readDocument(app.page, ctx.bridge);
  assert.equal(view.projectId, 'project-1');
  assert.equal(view.revisionId, 'r1');
  app.world.boundProject = false;
  await assert.rejects(
    readDocument(app.page, ctx.bridge),
    /^Error: BLOCKED: no bridge project id/u,
  );
});

const cycleDoc = (clips) => ({
  id: 'p',
  rootCompositionId: 'c',
  updatedAt: 'x',
  compositions: { c: { tracks: [{ id: 't1', clips }] } },
});

const cycleRow = (app, overrides = {}) => ({
  id: 'D-A06-TEST',
  command: 'timeline.duplicateClip',
  async act() {
    app.edit(
      cycleDoc([
        { id: 'a', startUs: 0 },
        { id: 'b', startUs: 10 },
      ]),
    );
  },
  check: () => undefined,
  ...overrides,
});

test('runCommandCycle does, checks, undoes and redoes through the bridge and writes four snapshots', async (t) => {
  const app = createFakeApp({ doc: cycleDoc([{ id: 'a', startUs: 0 }]) });
  const ctx = makeContext(t, app);
  const result = await runCommandCycle(cycleRow(app), app.page, ctx);
  assert.match(result.message, /timeline\.duplicateClip: done/u);
  assert.equal(result.evidence.length, 4);
  for (const path of result.evidence) assert.ok(existsSync(path), path);
  assert.deepEqual(
    ctx.bridge.log.entries
      .map((entry) => entry.step)
      .filter((step, index, all) => all.indexOf(step) === index),
    ['', 'D-A06-TEST do', 'D-A06-TEST undo', 'D-A06-TEST redo'],
  );
});

test('runCommandCycle fails when undo does not bring the document back', async (t) => {
  const app = createFakeApp({ doc: cycleDoc([{ id: 'a', startUs: 0 }]) });
  const ctx = makeContext(t, app);
  ctx.undo = async () => {};
  await assert.rejects(
    runCommandCycle(cycleRow(app), app.page, ctx),
    /undo did not bring the document back/u,
  );
});

test('runCommandCycle fails when redo loses the edit, and when the edit never reaches the bridge', async (t) => {
  const app = createFakeApp({ doc: cycleDoc([{ id: 'a', startUs: 0 }]) });
  const ctx = makeContext(t, app);
  ctx.redo = async () => {};
  await assert.rejects(
    runCommandCycle(cycleRow(app), app.page, ctx),
    /redo did not bring the edit back/u,
  );

  const idle = createFakeApp({ doc: cycleDoc([{ id: 'a', startUs: 0 }]) });
  const idleCtx = makeContext(t, idle);
  await assert.rejects(
    runCommandCycle(cycleRow(idle, { act: async () => {} }), idle.page, idleCtx),
    /document did not change on the bridge/u,
  );
});

test('runCommandCycle reports a check problem with the command name', async (t) => {
  const app = createFakeApp({ doc: cycleDoc([{ id: 'a', startUs: 0 }]) });
  const ctx = makeContext(t, app);
  await assert.rejects(
    runCommandCycle(cycleRow(app, { check: () => 'clips 1 -> 2, wanted +1' }), app.page, ctx),
    /timeline\.duplicateClip: clips 1 -> 2, wanted \+1/u,
  );
});

test('executeRow: pass writes no defect; fail writes defect text and a file; blocked and not-reachable write none', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  const base = { title: 'A row', expected: 'it works', severity: 'blocker' };

  const passed = await executeRow(
    { ...base, id: 'R-1', run: async () => ({ message: 'ok', evidence: ['e.png'] }) },
    app.page,
    ctx,
  );
  assert.deepEqual(
    [passed.status, passed.message, passed.evidence, passed.defect],
    ['passed', 'ok', ['e.png'], undefined],
  );

  const failed = await executeRow(
    {
      ...base,
      id: 'R-2',
      run: async () => {
        throw new Error('boom');
      },
    },
    app.page,
    ctx,
  );
  assert.equal(failed.status, 'failed');
  assert.match(failed.defect, /Found by: R-2/u);
  assert.match(failed.defect, /Severity: blocker/u);
  assert.equal(readFileSync(join(ctx.outDir, 'R-2', 'defect.md'), 'utf8'), failed.defect);

  const blocked = await executeRow(
    {
      ...base,
      id: 'R-3',
      run: async () => {
        throw new Error('BLOCKED R-3: no fixture');
      },
    },
    app.page,
    ctx,
  );
  assert.deepEqual([blocked.status, blocked.defect], ['blocked', undefined]);

  const unreachable = await executeRow(
    {
      ...base,
      id: 'R-4',
      run: async () => {
        throw new Error('NOT-REACHABLE x: no UI');
      },
    },
    app.page,
    ctx,
  );
  assert.deepEqual([unreachable.status, unreachable.defect], ['not-reachable', undefined]);
  assert.ok(failed.ms >= 0 && typeof failed.screenshot === 'string');
});

test('row tables: unique ids in the T-A05, T-A06 and T-A09 ranges, each with a title and run function', () => {
  const ids = [...PROJECTS_IMPORT_ROWS, ...TIMELINE_ROWS, ...PERSISTENCE_ROWS].map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(MATRIX_IDS.toSorted(), ids.toSorted());
  for (const row of PROJECTS_IMPORT_ROWS) assert.match(row.id, /^D-A05-\d{2}$/u);
  for (const row of TIMELINE_ROWS) assert.match(row.id, /^D-A06-\d{2}$/u);
  for (const row of PERSISTENCE_ROWS) assert.match(row.id, /^D-A09-\d{2}$/u);
  for (const row of Object.values(MATRIX_ROWS)) {
    assert.ok(row.title && typeof row.run === 'function', row.id);
    assert.ok(['blocker', 'major', 'minor'].includes(row.severity), row.id);
  }
});

test('createMatrixContext screenshots on its real page', async (t) => {
  const page = createFakePage();
  const outDir = scratch(t);
  const ctx = createMatrixContext({
    page,
    outDir,
    libraryDir: join(outDir, 'lib'),
    runId: 'abcdef123456',
  });
  await ctx.shot('D-A05-01', 'probe');
  assert.ok(page.calls.some((call) => call.startsWith('page.screenshot(')));
});

test('every command of commands.ts SpikeCommand has a cycle row or is listed as not reachable', () => {
  const source = readFileSync(join(repoRoot, 'packages', 'commands', 'src', 'commands.ts'), 'utf8');
  const union = source.slice(
    source.indexOf('export type SpikeCommand ='),
    source.indexOf('export type SpikeCommandType'),
  );
  const commands = [...union.matchAll(/type: '([^']+)'/gu)].map((match) => match[1]);
  assert.equal(
    commands.length,
    29,
    `commands.ts:196-227 lists 29 commands, found ${commands.length}`,
  );
  const covered = new Set(TIMELINE_ROWS.filter((row) => row.act).map((row) => row.command));
  for (const command of commands) {
    const rowCount = Number(covered.has(command)) + Number(command in NOT_REACHABLE_COMMANDS);
    assert.equal(
      rowCount,
      1,
      `${command} must be in exactly one of the cycle rows and NOT_REACHABLE_COMMANDS`,
    );
  }
  for (const command of [...covered, ...Object.keys(NOT_REACHABLE_COMMANDS)]) {
    assert.ok(commands.includes(command), `${command} is not a SpikeCommand`);
  }
});

test('every fixture the import rows name is in the T-A04 manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'tooling', 'qa', 'fixtures', 'manifest.json'), 'utf8'),
  );
  const files = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (typeof value.file === 'string') files.add(value.file);
      Object.values(value).forEach(walk);
    }
  };
  walk(manifest);
  for (const fixture of IMPORT_FIXTURES) assert.ok(files.has(fixture.file), fixture.file);
  assert.ok(IMPORT_FIXTURES.some((fixture) => fixture.file.endsWith('.webm')));
  assert.ok(IMPORT_FIXTURES.some((fixture) => fixture.file.endsWith('.m4a')));
});

test('D-A05-02 switches the grid and list views through the page', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  app.world.groups.push(['button:Grid view', 'button:List view']);
  app.world.pressed.add('button:Grid view');
  app.world.counts = {};
  // goToProjects needs the New project tile visible: the fake says everything is visible.
  const result = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-02'], app.page, ctx);
  assert.equal(result.status, 'passed', result.message);
  assert.deepEqual(
    app.world.clicks.filter((key) => key.includes('view')),
    ['button:List view', 'button:Grid view'],
  );
});

test('D-A05-02 fails when the list view never becomes pressed', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  const result = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-02'], app.page, ctx);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /List view did not become the pressed view/u);
  assert.match(result.defect, /Found by: D-A05-02/u);
});

test('D-A05-06 imports a fixture, and fails when the catalog does not list it', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  // importThroughLeftPanel waits on the file name through the fake, which accepts everything.
  app.world.bridgeReplies['desktop.asset-library.get-catalog'] = {
    assets: [{ displayName: 'h264-16x9-audio.mp4' }],
  };
  const passed = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-06'], app.page, ctx);
  assert.equal(passed.status, 'passed', passed.message);
  app.world.bridgeReplies['desktop.asset-library.get-catalog'] = { assets: [] };
  const failed = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-06'], app.page, ctx);
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /get-catalog does not list h264-16x9-audio\.mp4/u);
});

test('D-A05-60 fails with the known "cannot resolve visual asset" message and passes on a clean export', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  app.world.textByKey['.export-toast'] = 'Export failed: cannot resolve visual asset';
  const failed = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-60'], app.page, ctx);
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /known failure still present/u);
  assert.match(failed.defect, /Export the sample project/u);
  app.world.textByKey['.export-toast'] = 'Completed — export.mp4 verified';
  const passed = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-60'], app.page, ctx);
  assert.equal(passed.status, 'passed', passed.message);
});

test('D-A05-50 logs each bridge channel it names', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  const result = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID['D-A05-50'], app.page, ctx);
  assert.equal(result.status, 'passed', result.message);
  const logged = readFileSync(ctx.bridgeLogPath, 'utf8');
  for (const channel of ['get-settings', 'get-catalog', 'project.document.get'])
    assert.ok(logged.includes(channel));
});

test('D-A05-04 and D-A05-05 are blocked until a project was created', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  for (const id of ['D-A05-04', 'D-A05-05']) {
    const result = await executeRow(PROJECTS_IMPORT_ROWS_BY_ID[id], app.page, ctx);
    assert.equal(result.status, 'blocked', id);
  }
});

test('every not-reachable command row reports not-reachable with its reason, and no defect', async (t) => {
  const app = createFakeApp();
  const ctx = makeContext(t, app);
  const rows = TIMELINE_ROWS.filter((row) => row.command in NOT_REACHABLE_COMMANDS);
  assert.equal(rows.length, Object.keys(NOT_REACHABLE_COMMANDS).length);
  for (const row of rows) {
    const result = await executeRow(row, app.page, ctx);
    assert.equal(result.status, 'not-reachable', row.id);
    assert.ok(result.message.includes(NOT_REACHABLE_COMMANDS[row.command]));
    assert.equal(result.defect, undefined);
  }
});

test('D-A06-15 runs the whole cycle through a fake editor: add a track, undo, redo', async (t) => {
  const base = {
    id: 'p',
    rootCompositionId: 'c',
    compositions: { c: { tracks: [{ id: 't1', clips: [{ id: 'a', startUs: 0 }] }] } },
  };
  const app = createFakeApp({ doc: base });
  const ctx = makeContext(t, app);
  app.world.onClick = (key) => {
    if (key === 'button:Add video track') {
      app.edit({
        ...base,
        compositions: { c: { tracks: [...base.compositions.c.tracks, { id: 't2', clips: [] }] } },
      });
    }
  };
  const result = await executeRow(TIMELINE_ROWS_BY_ID['D-A06-15'], app.page, ctx);
  assert.equal(result.status, 'passed', result.message);
  assert.equal(result.evidence.length, 4);
});

test('D-A06-15 fails with defect text when Add video track changes nothing', async (t) => {
  const base = {
    id: 'p',
    rootCompositionId: 'c',
    compositions: { c: { tracks: [{ id: 't1', clips: [{ id: 'a', startUs: 0 }] }] } },
  };
  const app = createFakeApp({ doc: base });
  const ctx = makeContext(t, app);
  const result = await executeRow(TIMELINE_ROWS_BY_ID['D-A06-15'], app.page, ctx);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /timeline\.addTrack: the document did not change on the bridge/u);
  assert.match(result.defect, /Found by: D-A06-15/u);
});

test('countKeyframes counts keyframes at any depth', () => {
  assert.equal(
    countKeyframes({ a: { keyframes: [1, 2] }, b: [{ c: { keyframes: [3] } }], keyframes: 'no' }),
    3,
  );
  assert.equal(countKeyframes(null), 0);
});

test('exerciseControls changes number controls, and throws when a control loses the value or none exist', async () => {
  const input = (value, keeps = true) => {
    let current = value;
    return {
      isVisible: async () => true,
      isEnabled: async () => true,
      inputValue: async () => String(current),
      getAttribute: async () => '100',
      fill: async (next) => {
        if (keeps) current = Number(next);
      },
      press: async () => {},
    };
  };
  const pageWith = (numbers) => ({
    locator: () => ({
      locator: (selector) => {
        const empty = { count: async () => 0 };
        if (selector !== 'input[type="number"]') return empty;
        return { count: async () => numbers.length, nth: (index) => numbers[index] };
      },
    }),
  });
  const lines = await exerciseControls(pageWith([input(5), input(10)]));
  assert.deepEqual(lines, ['number 1: 5 -> 6', 'number 2: 10 -> 11']);
  await assert.rejects(
    exerciseControls(pageWith([input(5, false)])),
    /number control 1 kept 5, would not change either way/u,
  );
  await assert.rejects(exerciseControls(pageWith([])), /no control to change/u);
});

test('exerciseControls goes the other way when a control clamps at an undeclared limit', async () => {
  let current = 100;
  const clamped = {
    isVisible: async () => true,
    isEnabled: async () => true,
    inputValue: async () => String(current),
    getAttribute: async () => null,
    fill: async (next) => {
      current = Math.min(100, Number(next));
    },
    press: async () => {},
  };
  const page = {
    locator: () => ({
      locator: (selector) =>
        selector === 'input[type="number"]'
          ? { count: async () => 1, nth: () => clamped }
          : { count: async () => 0 },
    }),
  };
  assert.deepEqual(await exerciseControls(page), ['number 1: 100 -> 99']);
});

test('exerciseControls fails a control that lands on some other value', async () => {
  let current = 10;
  const wrong = {
    isVisible: async () => true,
    isEnabled: async () => true,
    inputValue: async () => String(current),
    getAttribute: async () => null,
    fill: async () => {
      current = 50;
    },
    press: async () => {},
  };
  const page = {
    locator: () => ({
      locator: (selector) =>
        selector === 'input[type="number"]'
          ? { count: async () => 1, nth: () => wrong }
          : { count: async () => 0 },
    }),
  };
  await assert.rejects(exerciseControls(page), /number control 1 kept 50, wanted 11/u);
});

test('normalizeDocument treats a false track flag as no flag (Lock then Undo leaves locked: false)', () => {
  const doc = (track) => ({ rootCompositionId: 'c', compositions: { c: { tracks: [track] } } });
  assert.equal(
    normalizeDocument(doc({ id: 't' })),
    normalizeDocument(doc({ id: 't', locked: false, muted: false, solo: false })),
  );
  assert.notEqual(
    normalizeDocument(doc({ id: 't' })),
    normalizeDocument(doc({ id: 't', locked: true })),
  );
});
