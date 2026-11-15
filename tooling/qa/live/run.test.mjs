import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from './run.mjs';

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
