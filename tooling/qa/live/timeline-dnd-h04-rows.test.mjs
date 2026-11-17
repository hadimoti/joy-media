import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const ids = ['D-H01', 'D-H02', 'D-H06', 'D-H07', 'D-H08', 'D-H10'];
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

function makeH04Fake(t, id) {
  const root = mkdtempSync(join(tmpdir(), 'joy-h04-row-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures);
  const media = join(fixtures, 'fixture-video.mp4');
  writeFileSync(media, 'fake fixture bytes for a readable media path');
  writeFileSync(join(fixtures, 'picture-1080.jpg'), 'distinct picture fixture bytes');
  writeFileSync(join(fixtures, 'audio-stereo.wav'), 'distinct audio fixture bytes');
  const clips =
    id === 'D-H01' ? [{ id: 'seed', assetId: 'seed-asset', trackId: 'track-1', startUs: 0 }] : [];
  const drops = [];
  let locked = false;
  const page = createFakePage({
    answers: ({ method, path, fn }) => {
      if (method === 'inputValue' && path.includes('Timeline zoom')) return '1';
      if (method === 'evaluateAll' && path.includes('asset-card-name'))
        return ['ویدیو-تست.wav', 'فيديو-اختبار.jpg'];
      if (method === 'getAttribute' && path.includes('Lock ')) {
        return locked ? 'true' : null;
      }
      if (method === 'click' && path.includes('Lock ')) locked = true;
      if (method === 'evaluate' && fn === 'readEditorSnapshot') {
        return { clips: clips.map((clip) => ({ id: clip.id, trackId: clip.trackId })) };
      }
      return undefined;
    },
  });
  page.context = () => ({
    async newCDPSession() {
      return {
        async send(method, payload) {
          if (method !== 'Input.dispatchDragEvent') return {};
          drops.push(payload);
          if (payload.type !== 'drop') return {};
          const isLockedDrop = id === 'D-H01' && payload.data.files.length > 0;
          const isInvalid =
            id === 'D-H07' && payload.data.files.some((file) => file.endsWith('.mp4'));
          if (isLockedDrop || isInvalid) return {};
          const targetUs = Math.round((payload.x - 10) * 1_000_000);
          for (const [index, file] of payload.data.files.entries()) {
            clips.push({
              id: `clip-${clips.length + 1}`,
              assetId: `asset-${resolve(file).split(/[\\/]/u).at(-1)}`,
              trackId: 'track-1',
              startUs: targetUs + index * 1_000_000,
            });
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
    bridge: {
      async invoke() {
        return { assets: [{ displayName: 'fixture-video.mp4' }] };
      },
    },
    async readDocument() {
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
  return { page, ctx, drops };
}

test('each implemented T-H04 row body runs against a fake page', async (t) => {
  for (const id of ['D-H01', 'D-H02', 'D-H06', 'D-H07', 'D-H08', 'D-H10']) {
    const { page, ctx, drops } = makeH04Fake(t, id);
    const message = await TIMELINE_DND_H04_ROWS_BY_ID[id].run(page, ctx);
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
    if (id === 'D-H07') {
      assert.ok(page.calls.some((call) => call.includes('.toast-message')));
    }
    if (id === 'D-H08') {
      const droppedPaths = drops.flatMap((payload) => payload.data.files);
      assert.ok(droppedPaths.some((path) => path.includes('ویدیو-تست.wav')));
      assert.ok(droppedPaths.some((path) => path.includes('فيديو-اختبار.jpg')));
      assert.ok(page.calls.some((call) => call.includes('.asset-card-name')));
    }
    if (id === 'D-H06') assert.ok(page.calls.some((call) => call.includes('.asset-card-name')));
    if (id === 'D-H10') assert.ok(page.calls.some((call) => call.includes('.timeline-lane')));
    if (id === 'D-H10') assert.match(message, /one media record/u);
    assert.ok(drops.length >= 3, `${id} did not dispatch CDP drag events`);
    for (const payload of drops) {
      assert.equal(payload.data.dragOperationsMask, 1);
      assert.deepEqual(payload.data.items, []);
      assert.ok(payload.data.files.every((file) => resolve(file) === file));
    }
  }
});
