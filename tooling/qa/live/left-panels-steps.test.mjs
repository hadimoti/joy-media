import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEFT_PANEL_ROWS,
  mediaHasAudio,
  readNodeLabels,
  readOptionValues,
  readNodeTexts,
} from './left-panels-steps.mjs';

test('the left-panel matrix has one row for each required action', () => {
  assert.deepEqual(
    LEFT_PANEL_ROWS.map((row) => row.id),
    ['D-065', 'D-066', 'D-067', 'D-068', 'D-069'],
  );
});

test('audio fixture detection excludes silent files', () => {
  assert.equal(mediaHasAudio('sample-audio.mp4'), true);
  assert.equal(mediaHasAudio('sample-audio-silent.mp4'), false);
  assert.equal(mediaHasAudio('picture.png'), false);
});

test('page readers preserve text, accessible names and selected option values', () => {
  const nodes = [
    { textContent: ' Title ', getAttribute: () => 'Add title' },
    { textContent: ' Caption ', getAttribute: () => 'Add caption' },
  ];
  assert.deepEqual(readNodeTexts(nodes), ['Title', 'Caption']);
  assert.deepEqual(readNodeLabels(nodes), ['Add title', 'Add caption']);
  assert.deepEqual(readOptionValues({ options: [{ value: '' }, { value: 'clip-1' }] }), ['clip-1']);
});
