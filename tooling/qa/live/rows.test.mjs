import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { abandonedRow, restartAppOnto, runRows } from './rows.mjs';

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'live-rows-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a close failure fails the restart row and the rows after it are not run on the closed window', async (t) => {
  const outDir = scratchDir(t);
  const ran = [];
  const ctx = { outDir, shot: async () => null, page: 'old window' };
  const rows = [
    {
      id: 'D-A',
      area: 'first',
      run: async () => {
        ran.push('D-A');
        return 'fine';
      },
    },
    {
      id: 'D-B',
      area: 'restart',
      run: async () => {
        ran.push('D-B');
        await restartAppOnto(ctx, {
          close: async () => {
            throw new Error('the window did not answer the close request');
          },
          relaunch: async () => {
            ran.push('relaunch');
            return { page: 'new window' };
          },
        });
      },
    },
    {
      id: 'D-C',
      area: 'after',
      run: async () => {
        ran.push('D-C');
        return 'must not run';
      },
    },
    { id: 'D-D', area: 'later', run: async () => ran.push('D-D') },
  ];

  const outcomes = await runRows(rows, ctx);

  assert.deepEqual(ran, ['D-A', 'D-B']);
  assert.deepEqual(
    outcomes.map(({ result }) => [result.id, result.status]),
    [
      ['D-A', 'passed'],
      ['D-B', 'failed'],
      ['D-C', 'failed'],
      ['D-D', 'failed'],
    ],
  );
  assert.match(outcomes[2].result.message, /^not run: the app window did not close cleanly/u);
  assert.match(outcomes[2].result.message, /the window did not answer the close request/u);
  assert.equal(outcomes[2].result.screenshot, null);
  assert.match(outcomes[2].defect, /\| X-\?\?\? \| D-C \|/u);
  const saved = JSON.parse(readFileSync(join(outDir, 'D-D', 'result.json'), 'utf8'));
  assert.equal(saved.status, 'failed');
});

test('a relaunch failure marks the page lost and the row that asked for the restart fails', async () => {
  const ctx = { shot: async () => null, page: 'old window' };
  await assert.rejects(
    restartAppOnto(ctx, {
      close: async () => {},
      relaunch: async () => {
        throw new Error('the app exited before CDP became ready');
      },
    }),
    /exited before CDP/u,
  );
  assert.match(ctx.pageLost, /^the app did not start again after a restart/u);
  assert.equal(ctx.page, 'old window');
});

test('a clean restart returns the new session and leaves no page lost', async () => {
  const ctx = { page: 'old window', downloadDir: 'old downloads' };
  const session = await restartAppOnto(ctx, {
    close: async () => {},
    relaunch: async () => ({ page: 'new window', downloadDir: 'new downloads' }),
  });
  assert.deepEqual(session, { page: 'new window', downloadDir: 'new downloads' });
  assert.equal(ctx.page, 'new window');
  assert.equal(ctx.downloadDir, 'new downloads');
  assert.equal(ctx.pageLost, undefined);
});

test('an abandoned row names its reason, keeps its id and writes T-A16 defect text', () => {
  const { result, defect } = abandonedRow('D-080', 'the app window did not close cleanly');
  assert.equal(result.id, 'D-080');
  assert.equal(result.status, 'failed');
  assert.equal(result.message, 'not run: the app window did not close cleanly');
  assert.equal(result.ms, 0);
  assert.match(defect, /\| X-\?\?\? \| D-080 \|/u);
});
