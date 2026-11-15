import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EFFECTS_LOOKS_ROWS,
  pickOtherValue,
  readControlKind,
  readInputRange,
} from './effects-looks-steps.mjs';

test('the effects and Looks matrix rows cover add/change/remove and all four Look actions', () => {
  assert.deepEqual(
    EFFECTS_LOOKS_ROWS.map((row) => row.id),
    ['D-057', 'D-058', 'D-070'],
  );
});

test('the chosen effect or Look control value is different and within its range', () => {
  const range = { min: 0, max: 1, step: 0.1, value: 0.2 };
  const chosen = pickOtherValue(range);
  assert.notEqual(chosen, range.value);
  assert.ok(chosen >= range.min && chosen <= range.max);
  assert.equal(readInputRange({ min: '1', max: '5', step: '0.5', value: '2' }).value, 2);
  assert.equal(readControlKind({ tagName: 'SELECT', type: 'select-one' }), 'select');
});
