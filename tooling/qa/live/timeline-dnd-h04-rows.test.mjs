import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { TIMELINE_DND_LIVE_ROWS, TIMELINE_DND_SCRIPTED_ROWS } from './timeline-dnd-h04-rows.mjs';
import { createFakePage } from './fake-page.mjs';
import {
  TIMELINE_DND_H04_ROWS,
  TIMELINE_DND_H04_ROWS_BY_ID,
} from './timeline-dnd-h04-scripted-rows.mjs';
import { MATRIX_IDS, MATRIX_ROWS } from './desktop-matrix-rows.mjs';

test('T-H04 scripted edge rows cover the card cases in order', () => {
  assert.deepEqual(
    TIMELINE_DND_SCRIPTED_ROWS.map(({ id }) => id),
    Array.from({ length: 10 }, (_, index) => `D-H${String(index + 1).padStart(2, '0')}`),
  );
  for (const row of TIMELINE_DND_SCRIPTED_ROWS) assert.ok(row.scenario.length > 0, row.id);
});

test('T-H04 live rows cover Explorer and desktop drops on every requested surface', () => {
  assert.deepEqual(
    TIMELINE_DND_LIVE_ROWS.map(({ id }) => id),
    ['L-H04-1', 'L-H04-2', 'L-H04-3', 'L-H04-4'],
  );
  for (const row of TIMELINE_DND_LIVE_ROWS) {
    assert.match(row.scenario, /timeline, Monitor, and Media panel/u, row.id);
  }
  assert.match(TIMELINE_DND_LIVE_ROWS[3].scenario, /remove it/u);
});

test('the implemented T-H04 rows are registered in the desktop runner in task-card order', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `D-H${String(index + 1).padStart(2, '0')}`);
  assert.deepEqual(
    TIMELINE_DND_H04_ROWS.map(({ id }) => id),
    ids,
  );
  assert.deepEqual(Object.keys(TIMELINE_DND_H04_ROWS_BY_ID), ids);
  for (const id of ids) {
    assert.ok(MATRIX_IDS.includes(id), `${id} is missing from MATRIX_IDS`);
    assert.equal(MATRIX_ROWS[id], TIMELINE_DND_H04_ROWS_BY_ID[id]);
    assert.equal(typeof MATRIX_ROWS[id].run, 'function');
  }
});

function timeoutError() {
  const error = new Error('Timeout 8000ms exceeded.');
  error.name = 'TimeoutError';
  return error;
}

/**
 * A fake app for one T-H04 row. Options:
 * - `dropEffect`: what a CDP drop does: `clip` (a timeline clip), `card` (a Media card only) or `none`.
 * - `seedClips`, `cards`: the clips and Media cards that exist before the row starts.
 * - `noToast`: the rejection toast never shows.
 * - `importCardMissing`: an import through the Media dialog never makes a card.
 * - `mangleNames`: the app shows Unicode names with `?` in place of the non-ASCII letters.
 * - `mutateOnImport`: the import changes the source file.
 * - `readError`: `ctx.readDocument()` throws (before the drop, or after it with `readErrorAfterDrop`).
 */
function makeH04Fake(t, id, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'joy-h04-row-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures);
  const media = join(fixtures, 'fixture-video.mp4');
  writeFileSync(media, 'fake fixture bytes for a readable media path');
  writeFileSync(join(fixtures, 'picture-1080.jpg'), 'distinct picture fixture bytes');
  writeFileSync(join(fixtures, 'audio-stereo.wav'), 'distinct audio fixture bytes');
  const {
    dropEffect = ['D-H02', 'D-H10'].includes(id) ? 'clip' : 'none',
    seedClips = id === 'D-H01'
      ? [{ id: 'seed', assetId: 'seed-asset', trackId: 'track-1', startUs: 0 }]
      : [],
    cards = [],
    noToast = false,
    importCardMissing = false,
    mangleNames = false,
    mutateOnImport = false,
    readError,
    readErrorAfterDrop = false,
    clipDurationUs = 0,
  } = options;
  const clips = seedClips.map((clip) => ({ ...clip }));
  const cardNames = [...cards];
  const drops = [];
  const imports = [];
  let dropped = false;
  let locked = false;
  const shownName = (name) => (mangleNames ? name.replace(/[^ -~]/gu, '?') : name);
  const page = createFakePage({
    answers: ({ method, path, fn, args: argList }) => {
      if (method === 'inputValue' && path.includes('Timeline zoom')) return '1';
      // The Media tab is already the open one, so the helper does not walk the View menu.
      if (method === 'getAttribute' && path.includes('data-feature-tool')) return 'true';
      if (method === 'getAttribute' && path.includes('Lock ')) return locked ? 'true' : null;
      if (method === 'click' && path.includes('Lock ')) locked = true;
      if (method === 'evaluate' && fn === 'readEditorSnapshot') {
        return { clips: clips.map((clip) => ({ id: clip.id, trackId: clip.trackId })) };
      }
      // The fixture rows use one card name at a time, so the count of all cards is the count of that name.
      if (method === 'count' && path.includes('asset-card-name')) return cardNames.length;
      if (method === 'evaluateAll' && path.includes('asset-card-name')) return cardNames.slice();
      if (method === 'setInputFiles' && path.includes('Media file')) {
        const file = argList[0];
        imports.push(file);
        if (mutateOnImport) {
          chmodSync(file, 0o644);
          appendFileSync(file, 'changed');
        }
        if (!importCardMissing) cardNames.push(shownName(basename(file)));
        return undefined;
      }
      // The import helper waits for the imported file's card (its name as typed, not as shown).
      if (method === 'waitFor' && path.startsWith('locator(".asset-card",')) {
        const last = imports.at(-1);
        if (last === undefined || !cardNames.includes(basename(last))) throw timeoutError();
        return undefined;
      }
      if (method === 'waitFor' && path.includes('toast-message') && noToast) throw timeoutError();
      return undefined;
    },
  });
  page.context = () => ({
    async newCDPSession() {
      return {
        async send(method, payload) {
          if (method !== 'Input.dispatchDragEvent') return {};
          page.calls.push(`CDP.${method}(${payload.type})`);
          drops.push(payload);
          if (payload.type !== 'drop') return {};
          dropped = true;
          if (dropEffect === 'card') {
            for (const file of payload.data.files) cardNames.push(shownName(basename(file)));
          }
          if (dropEffect === 'clip') {
            const targetUs = Math.round((payload.x - 10) * 1_000_000);
            for (const [index, file] of payload.data.files.entries()) {
              clips.push({
                id: `clip-${clips.length + 1}`,
                assetId: `asset-${basename(file)}`,
                trackId: 'track-1',
                startUs: targetUs + index * 1_000_000,
                durationUs: clipDurationUs,
              });
            }
          }
          return {};
        },
        async detach() {},
      };
    },
  });
  const ctx = {
    outDir: root,
    fixtures,
    media,
    runTag: 'fake',
    clipWaitMs: 300,
    bridge: {
      async invoke() {
        return { assets: [{ displayName: 'fixture-video.mp4' }] };
      },
    },
    async readDocument() {
      if (readError !== undefined && (!readErrorAfterDrop || dropped)) throw readError;
      return {
        document: {
          rootCompositionId: 'root',
          compositions: {
            root: { tracks: [{ id: 'track-1', clips: clips.map((clip) => ({ ...clip })) }] },
          },
        },
      };
    },
  };
  return { page, ctx, drops, imports, cardNames, clips };
}

const run = (id, page, ctx) => TIMELINE_DND_H04_ROWS_BY_ID[id].run(page, ctx);

/** The row must fail as a defect or harness error: its message is not the BLOCKED verdict. */
function assertNotBlocked(error) {
  assert.doesNotMatch(error.message, /^BLOCKED/u, error.message);
  return true;
}

test('each implemented T-H04 row body runs against a fake page', async (t) => {
  for (const id of ['D-H01', 'D-H02', 'D-H06', 'D-H07', 'D-H08', 'D-H10']) {
    const { page, ctx, drops, imports } = makeH04Fake(t, id);
    const message = await run(id, page, ctx);
    assert.ok(
      message.includes(
        id === 'D-H07'
          ? 'rejected'
          : id === 'D-H08'
            ? 'preserved'
            : id === 'D-H01'
              ? 'refused'
              : id === 'D-H06'
                ? 'read-only'
                : id === 'D-H10'
                  ? 'created clips'
                  : 'started at',
      ),
      `${id}: ${message}`,
    );
    if (id === 'D-H06' || id === 'D-H08') {
      // Through the Media import dialog, not a CDP drop.
      assert.equal(drops.length, 0, `${id} dispatched a CDP drop`);
      assert.ok(imports.length > 0, `${id} did not import through the Media dialog`);
      continue;
    }
    if (id === 'D-H10') assert.match(message, /one media record/u);
    assert.ok(drops.length >= 3, `${id} did not dispatch CDP drag events`);
    for (const payload of drops) {
      assert.equal(payload.data.dragOperationsMask, 1);
      assert.deepEqual(payload.data.items, []);
      assert.ok(payload.data.files.every((file) => resolve(file) === file));
    }
  }
});

test('D-H08 passes through the Media dialog when both Unicode names are kept', async (t) => {
  const { page, ctx, drops, imports } = makeH04Fake(t, 'D-H08');
  const message = await run('D-H08', page, ctx);
  assert.match(message, /preserved/u);
  assert.equal(drops.length, 0);
  assert.ok(imports.some((path) => path.includes('ویدیو-تست.wav')));
  assert.ok(imports.some((path) => path.includes('فيديو-اختبار.jpg')));
});

test('D-H08 is a defect, not blocked, when Media shows a mangled name', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H08', { mangleNames: true });
  await assert.rejects(run('D-H08', page, ctx), (error) => {
    assertNotBlocked(error);
    assert.match(error.message, /^Media does not show ویدیو-تست\.wav after the import/u);
    return true;
  });
});

test('D-H06 imports a read-only file through the Media dialog and leaves it unchanged', async (t) => {
  const { page, ctx, imports } = makeH04Fake(t, 'D-H06');
  const message = await run('D-H06', page, ctx);
  assert.match(message, /read-only .* is in Media; its size and modified time stayed unchanged/u);
  assert.equal(imports.length, 1);
  assert.ok(imports[0].includes('D-H06'), imports[0]);
});

test('D-H06 is a defect, not blocked, when the file never appears in Media', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H06', { importCardMissing: true });
  await assert.rejects(run('D-H06', page, ctx), (error) => {
    assert.equal(error.name, 'TimeoutError');
    return assertNotBlocked(error);
  });
});

test('D-H06 fails when the import changes the source file', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H06', { mutateOnImport: true });
  await assert.rejects(run('D-H06', page, ctx), (error) => {
    assertNotBlocked(error);
    assert.match(error.message, /read-only source changed: size/u);
    return true;
  });
});

test('D-H02 passes when the dropped clip lands at the requested time', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H02');
  const message = await run('D-H02', page, ctx);
  assert.match(message, /started at 2000000 us \(requested 2000000 us\)/u);
});

test('D-H02 is blocked only when the clip wait times out and no card appears', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H02', { dropEffect: 'none' });
  await assert.rejects(run('D-H02', page, ctx), (error) => {
    assert.match(
      error.message,
      /^BLOCKED D-H02: needs a real mouse drag from Explorer \(attended\)/u,
    );
    assert.match(error.message, /preload\.cjs:62, 93-102/u);
    return true;
  });
});

test('D-H02 does not pass on a clip that was already there (baseline)', async (t) => {
  const seedClips = [{ id: 'old', assetId: 'old-asset', trackId: 'track-1', startUs: 0 }];
  const { page, ctx } = makeH04Fake(t, 'D-H02', { dropEffect: 'none', seedClips });
  await assert.rejects(run('D-H02', page, ctx), (error) => {
    assert.match(error.message, /^BLOCKED D-H02/u);
    return true;
  });
});

test('D-H02 is a defect, not blocked, when a card appears but no clip is made', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H02', { dropEffect: 'card' });
  await assert.rejects(run('D-H02', page, ctx), (error) => {
    assertNotBlocked(error);
    assert.match(
      error.message,
      /reached Media \(a new fixture-video\.mp4 card\) but made no clip/u,
    );
    return true;
  });
});

test('D-H02 rethrows a read failure during the clip wait instead of reporting blocked', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H02', {
    dropEffect: 'none',
    readError: new Error('IPC down'),
    readErrorAfterDrop: true,
  });
  await assert.rejects(run('D-H02', page, ctx), (error) => {
    assertNotBlocked(error);
    assert.equal(error.message, 'IPC down');
    return true;
  });
});

test('D-H07 is blocked only when neither a message nor a card appears', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H07', { noToast: true });
  await assert.rejects(run('D-H07', page, ctx), (error) => {
    assert.match(
      error.message,
      /^BLOCKED D-H07: needs a real mouse drag from Explorer \(attended\)/u,
    );
    return true;
  });
});

test('D-H07 is a defect, not blocked, when a card appears without a rejection message', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H07', { noToast: true, dropEffect: 'card' });
  await assert.rejects(run('D-H07', page, ctx), (error) => {
    assertNotBlocked(error);
    assert.match(error.message, /added to Media without a rejection message/u);
    return true;
  });
});

test('D-H07 rethrows a read failure instead of reporting blocked', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H07', {
    noToast: true,
    readError: new Error('document unreadable'),
  });
  await assert.rejects(run('D-H07', page, ctx), (error) => {
    assertNotBlocked(error);
    assert.equal(error.message, 'document unreadable');
    return true;
  });
});

test('D-H01 waits for the visible lock control and confirmed locked state before dropping', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H01');
  await run('D-H01', page, ctx);

  const headerHover = page.calls.findIndex(
    (call) => call.includes('timeline-track-header') && call.includes('.hover('),
  );
  const lockVisibleWait = page.calls.findIndex(
    (call) => call.includes('Lock ') && call.includes('.waitFor('),
  );
  const lockClick = page.calls.findIndex(
    (call) => call.includes('Lock ') && call.includes('.click('),
  );
  const pressedWait = page.calls.findIndex((call) => call.includes('.waitForFunction('));
  const dropIndex = page.calls.findIndex((call) => call.includes('Input.dispatchDragEvent'));

  assert.ok(headerHover >= 0, 'the row did not hover the seeded track header');
  assert.ok(lockVisibleWait > headerHover, 'the row did not wait for the lock control after hover');
  assert.ok(pressedWait > lockClick, 'the row did not wait for aria-pressed after locking');
  assert.ok(dropIndex > pressedWait, 'the row dispatched the file drop before confirming the lock');
});

test('D-H01 is blocked only when the simulated drop shows neither the refusal nor a card/clip', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H01', { noToast: true, dropEffect: 'none' });
  await assert.rejects(run('D-H01', page, ctx), (error) => {
    assert.match(
      error.message,
      /^BLOCKED D-H01: needs a real mouse drag from Explorer \(attended\)/u,
    );
    return true;
  });
});

test('D-H04 checks the full ten-minute duration when the drop reaches the app', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H04', {
    dropEffect: 'clip',
    clipDurationUs: 600_000_000,
  });
  const message = await run('D-H04', page, ctx);
  assert.match(message, /600000000 us/u);
});

test('D-H04 is blocked when the synthetic drop reaches neither Media nor the timeline', async (t) => {
  const { page, ctx } = makeH04Fake(t, 'D-H04', { dropEffect: 'none' });
  await assert.rejects(run('D-H04', page, ctx), (error) => {
    assert.match(
      error.message,
      /^BLOCKED D-H04: needs a real mouse drag from Explorer \(attended\)/u,
    );
    return true;
  });
});

test('D-H03, D-H05, and D-H09 report their attended-drop limits as BLOCKED', async (t) => {
  for (const id of ['D-H03', 'D-H05', 'D-H09']) {
    const { page, ctx } = makeH04Fake(t, id);
    await assert.rejects(
      () => run(id, page, ctx),
      (error) => {
        assert.match(error.message, new RegExp(`^BLOCKED ${id}:`, 'u'));
        assert.match(error.message, /Explorer|being copied|missing-media/iu);
        return true;
      },
    );
  }
});
