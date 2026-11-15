import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedRootsOf, refuseProtectedFile } from './driver.mjs';
import { runParts } from './rows.mjs';
import { createMediaState, importMediaRow } from './run.mjs';

const HOME = 'C:\\Users\\Owner';

test('the lock file and the app log may not lie in an owner folder', () => {
  for (const bad of [
    'C:\\Users\\Owner\\Documents\\JOY Projects\\qa.lock',
    'C:\\Users\\Owner\\.joy-media\\app.log',
    'C:\\Users\\Owner\\joy-media-assets\\x.lock',
    'C:\\Users\\Owner\\Desktop\\lock.txt',
    'C:\\Users\\Owner\\AppData\\Local\\Programs\\JOY Media\\resources\\lock.txt',
  ]) {
    assert.throws(() => refuseProtectedFile(bad, 'app lock', HOME), /protected owner folder/u, bad);
  }
});

test('a lock file in a scratch folder is allowed', () => {
  assert.doesNotThrow(() => refuseProtectedFile('E:\\qa\\LOCK-app-run.txt', 'app lock', HOME));
  assert.doesNotThrow(() => refuseProtectedFile('C:\\jgp\\LOCK-app-run.txt', 'app lock', HOME));
});

test('the protected folders list names the data home and the project folder', () => {
  const roots = protectedRootsOf(HOME, 'C:\\Users\\Owner\\AppData\\Local\\Programs\\JOY Media');
  assert.ok(roots.includes('C:\\Users\\Owner\\.joy-media'));
  assert.ok(roots.includes('C:\\Users\\Owner\\Documents\\JOY Projects'));
});

test('D-002 after setup does not import again, but it must find the asset in the library', async () => {
  const state = createMediaState();
  state.imported = true;
  const calls = [];
  await importMediaRow(
    state,
    async () => calls.push('import'),
    async () => calls.push('verify'),
  );
  assert.deepEqual(calls, ['verify']);
  await assert.rejects(
    importMediaRow(
      state,
      async () => calls.push('import'),
      async () => {
        throw new Error('asset card not found');
      },
    ),
    /asset card not found/u,
  );
});

test('a mistake in a script part (TypeError) stays visible as the cause of the part failure', async () => {
  await assert.rejects(
    runParts('X', 'checks', ['a', 'b'], async (item) => {
      if (item === 'b') return undefinedFunction(); // eslint-disable-line no-undef
      return 'ok';
    }),
    (error) => error.cause instanceof ReferenceError,
  );
});
