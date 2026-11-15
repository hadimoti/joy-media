import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaState, ensureMediaInProject, importMediaRow, parseArgs } from './run.mjs';

function mediaSteps(calls) {
  return {
    importMedia: async () => calls.push('import'),
    placeOnTimeline: async () => calls.push('place'),
  };
}

test('the --media fixture is imported once and placed once, by the setup or the first row that needs it', async () => {
  const calls = [];
  const state = createMediaState();
  await ensureMediaInProject(state, mediaSteps(calls));
  await ensureMediaInProject(state, mediaSteps(calls));
  assert.deepEqual(calls, ['import', 'place']);
});

test('after the D-002 import row succeeds, a monitor row places the clip but does not import it again', async () => {
  const calls = [];
  const state = createMediaState();
  await importMediaRow(state, async () => calls.push('import'));
  assert.equal(state.imported, true);
  assert.equal(state.onTimeline, false);
  await ensureMediaInProject(state, mediaSteps(calls));
  assert.deepEqual(calls, ['import', 'place']);
});

test('a failed D-002 import does not mark the fixture as imported', async () => {
  const state = createMediaState();
  await assert.rejects(
    importMediaRow(state, async () => {
      throw new Error('the file dialog did not open');
    }),
    /dialog did not open/u,
  );
  assert.equal(state.imported, false);
});

test('the setup placement counts as imported, so a monitor row does not import the fixture again', async () => {
  const calls = [];
  const state = createMediaState();
  await ensureMediaInProject(state, mediaSteps(calls));
  calls.length = 0;
  await ensureMediaInProject(state, mediaSteps(calls));
  assert.deepEqual(calls, []);
});

test('the live runner accepts the T-A07 and T-A08 matrix rows', () => {
  const options = parseArgs(['--tests', 'D-057,D-065,D-071,D-080', '--app', 'C:\\jgp\\unpacked']);
  assert.deepEqual(options.testIds, ['D-057', 'D-065', 'D-071', 'D-080']);
});

test('the D-07 prefix expands every T-A08 shortcut and workspace row', () => {
  const options = parseArgs(['--tests', 'D-07*', '--app', 'C:\\jgp\\unpacked']);
  assert.ok(options.testIds.includes('D-071'));
  assert.ok(options.testIds.includes('D-072'));
  assert.ok(options.testIds.includes('D-079'));
  assert.ok(!options.testIds.includes('D-080'));
});

test('the D-002 row does not import a fixture that setup already imported', async () => {
  const state = createMediaState();
  const calls = [];
  await ensureMediaInProject(state, {
    importMedia: async () => calls.push('import'),
    placeOnTimeline: async () => calls.push('place'),
  });
  await importMediaRow(state, async () => calls.push('import again'));
  assert.deepEqual(calls, ['import', 'place']);
});
