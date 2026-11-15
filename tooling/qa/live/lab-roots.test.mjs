import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labRoots, PC_JOY_HASH } from './lab-roots.mjs';

test('defaults are the PC folders and the PC joy:// hash', () => {
  const lab = labRoots({});
  assert.equal(lab.root, 'C:\\jgp\\v111');
  assert.equal(lab.lockPath, 'C:\\jgp\\LOCK-app-run.txt');
  assert.equal(lab.fixtures, 'C:\\jgp\\v111\\fixtures');
  assert.equal(lab.evidence, 'C:\\jgp\\v111\\evidence');
  assert.equal(lab.scratch, 'C:\\jgp\\v111\\codex');
  assert.equal(lab.drops, 'C:\\jgp\\v111\\dnd');
  assert.equal(lab.expectedJoyHash, PC_JOY_HASH);
});

test('a second machine sets its own root, lock and hash through the environment', () => {
  const lab = labRoots({
    JOY_QA_ROOT: 'E:\\joy-media-1.1.1\\qa',
    JOY_QA_LOCK: 'E:\\joy-media-1.1.1\\qa\\LOCK.txt',
    JOY_QA_EXPECTED_JOY_HASH: 'ab12',
  });
  assert.equal(lab.fixtures, 'E:\\joy-media-1.1.1\\qa\\fixtures');
  assert.equal(lab.lockPath, 'E:\\joy-media-1.1.1\\qa\\LOCK.txt');
  assert.equal(lab.expectedJoyHash, 'AB12');
});

test('the word absent approves a machine that has no joy:// key', () => {
  assert.equal(labRoots({ JOY_QA_EXPECTED_JOY_HASH: 'absent' }).expectedJoyHash, '');
  assert.equal(labRoots({ JOY_QA_EXPECTED_JOY_HASH: 'ABSENT' }).expectedJoyHash, '');
});
