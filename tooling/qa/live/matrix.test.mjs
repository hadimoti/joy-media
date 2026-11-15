import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACTION_CHECKS,
  MENU_SPEC,
  paletteSpec,
  parseShortcutAlternatives,
  SHORTCUT_ACTIONS,
} from './actions.mjs';
import { LIVE_ROWS, T_A07_ROWS, T_A08_ROWS } from './matrix.mjs';
import { createFakePage } from './fake-page.mjs';
import { runRow, writeRowEvidence } from './rows.mjs';
import { openMenuGroup, pressChord, readEditorSnapshot } from './ui-steps.mjs';

test('T-A07 registers every effects, looks, text, caption, audio and template matrix row', () => {
  assert.deepEqual(
    T_A07_ROWS.map((row) => row.id),
    ['D-057', 'D-058', 'D-065', 'D-066', 'D-067', 'D-068', 'D-069', 'D-070'],
  );
  assert.ok(T_A07_ROWS.every((row) => typeof row.run === 'function'));
});

test('T-A08 registers palette, shortcuts, five workspace cases, saved layout and recent processes', () => {
  assert.deepEqual(
    T_A08_ROWS.map((row) => row.id),
    ['D-071', 'D-072', 'D-073', 'D-074', 'D-075', 'D-076', 'D-077', 'D-078', 'D-079', 'D-080'],
  );
  assert.ok(T_A08_ROWS.every((row) => typeof row.run === 'function'));
});

test('the live runner registry contains both task rows without duplicate IDs', () => {
  const ids = LIVE_ROWS.map((row) => row.id);
  assert.ok(T_A07_ROWS.every((row) => ids.includes(row.id)));
  assert.ok(T_A08_ROWS.every((row) => ids.includes(row.id)));
  assert.equal(new Set(ids).size, ids.length);
});

test('each menu action has a check and the palette lists each action once', () => {
  const menuIds = MENU_SPEC.flatMap((group) => group.items.map((item) => item.id));
  for (const id of menuIds)
    assert.equal(typeof ACTION_CHECKS[id], 'function', `${id} has no check`);
  const paletteIds = paletteSpec().map((item) => item.id);
  assert.equal(new Set(paletteIds).size, paletteIds.length);
  assert.deepEqual(paletteIds, [...new Set(menuIds)]);
});

test('shortcut labels expand into every individual key chord', () => {
  assert.deepEqual(parseShortcutAlternatives('Home / End'), ['Home', 'End']);
  assert.deepEqual(parseShortcutAlternatives('Shift+← / Shift+→'), ['Shift+←', 'Shift+→']);
  assert.deepEqual(parseShortcutAlternatives('Alt+← ↑ → ↓ (Monitor picture)'), [
    'Alt+←',
    'Alt+↑',
    'Alt+→',
    'Alt+↓',
  ]);
  assert.deepEqual(parseShortcutAlternatives('[ / ] (Monitor picture)'), ['[', ']']);
});

test('every app shortcut-reference action has a state check', () => {
  const source = readFileSync(
    new URL('../../../apps/editor-web/src/keyboard-shortcuts.ts', import.meta.url),
    'utf8',
  );
  const labels = [...source.matchAll(/action:\s*'([^']+)'/gu)].map((match) => match[1]);
  assert.ok(labels.length > 0);
  for (const label of labels) assert.ok(SHORTCUT_ACTIONS.has(label), `${label} has no state check`);
});

test('editor snapshots report missing Monitor focus as false', () => {
  const original = globalThis.document;
  globalThis.document = {
    activeElement: {
      closest: () => null,
      tagName: 'BODY',
      getAttribute: () => null,
      className: '',
    },
    fullscreenElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  try {
    assert.equal(readEditorSnapshot().monitorFocus, false);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test('the matrix steps use the recording fake page without launching Electron', async () => {
  const calls = [];
  const page = createFakePage({
    answers: ({ method, fn }) => {
      if (method === 'evaluate' && fn === 'readOpenMenu') {
        return { open: true, group: 'File', items: [] };
      }
      return undefined;
    },
  });
  await openMenuGroup(page, 'File');
  await pressChord(page, 'Ctrl+Z');
  assert.ok(page.calls.some((call) => call.includes('click')));
  assert.ok(page.calls.includes('keyboard.press("Control+KeyZ")'));
  assert.deepEqual(calls, []);
});

test('a fake driver row writes result.json and a failed row gets T-A16 defect text', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'a07-row-test-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const page = createFakePage();
  const outcome = await runRow(
    {
      id: 'D-TEST',
      area: 'fake page',
      expected: 'the scripted action works',
      run: async (fake) => {
        await fake.getByRole('button', { name: 'Run' }).click();
        throw new Error('the scripted action failed');
      },
    },
    { page, outDir, shot: async () => null },
  );
  writeRowEvidence(outDir, outcome);
  const result = JSON.parse(readFileSync(join(outDir, 'D-TEST', 'result.json'), 'utf8'));
  const defect = readFileSync(join(outDir, 'D-TEST', 'defect.txt'), 'utf8');
  assert.equal(result.status, 'failed');
  assert.match(defect, /\| X-\?\?\? \| D-TEST \|/u);
  assert.ok(page.calls.some((call) => call.includes('name":"Run"')));
});
