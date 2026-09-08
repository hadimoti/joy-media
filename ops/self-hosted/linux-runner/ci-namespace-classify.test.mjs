import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRun, isSweepable } from './ci-namespace-classify.mjs';

test('classifyRun: the current run is never an orphan', () => {
  assert.equal(classifyRun({ status: 'current' }), 'current');
  assert.equal(isSweepable('current'), false);
});

test('classifyRun: an in-flight owning run is active and untouchable', () => {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    assert.equal(classifyRun({ status }), 'active');
  }
  assert.equal(isSweepable('active'), false);
});

test('classifyRun: only a completed owning run is a sweepable orphan', () => {
  assert.equal(classifyRun({ status: 'completed', conclusion: 'success' }), 'orphan');
  assert.equal(classifyRun({ status: 'completed', conclusion: 'cancelled' }), 'orphan');
  assert.equal(classifyRun({ status: 'completed', conclusion: 'failure' }), 'orphan');
  assert.equal(isSweepable('orphan'), true);
});

test('classifyRun: a 404 (run id unknown to the API) is quarantined, never swept', () => {
  assert.equal(classifyRun({ status: 'not-found' }), 'not-found');
  assert.equal(isSweepable('not-found'), false);
});

test('classifyRun: an unreadable status is unknown and untouchable', () => {
  assert.equal(classifyRun({ status: 'unknown', conclusion: 'http 500' }), 'unknown');
  assert.equal(classifyRun({}), 'unknown');
  assert.equal(classifyRun({ status: undefined }), 'unknown');
  assert.equal(classifyRun({ status: 'some-future-state' }), 'unknown');
  assert.equal(isSweepable('unknown'), false);
});

test('isSweepable: orphan is the only sweepable class', () => {
  assert.equal(isSweepable('unrecognized'), false);
  assert.equal(isSweepable('not-found'), false);
  assert.equal(isSweepable('active'), false);
  assert.equal(isSweepable('current'), false);
  assert.equal(isSweepable('unknown'), false);
  assert.equal(isSweepable('orphan'), true);
});
