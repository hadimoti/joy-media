import assert from 'node:assert/strict';
import test from 'node:test';
import { TIMELINE_DND_LIVE_ROWS, TIMELINE_DND_SCRIPTED_ROWS } from './timeline-dnd-h04-rows.mjs';

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
