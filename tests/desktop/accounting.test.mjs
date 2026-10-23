import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The accounting functions run only in the Windows lifecycle step, so this suite runs where
// Windows PowerShell exists. Exit 0 means the scenario passes, 1 means it fails, and 2 means the
// report is missing, malformed or lacks a required counter.
const skipReason = process.platform === 'win32' ? false : 'accounting runs under Windows PowerShell';
const driver = resolve(fileURLToPath(new URL('.', import.meta.url)), 'accounting-driver.ps1');

function accounting(kind, reportText) {
  const directory = mkdtempSync(join(tmpdir(), 'accounting-'));
  try {
    const report = join(directory, 'report.json');
    if (reportText !== undefined) writeFileSync(report, reportText);
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, '-Kind', kind, '-Report', report],
      { encoding: 'utf8' },
    );
    return result.status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const vitest = (overrides = {}) =>
  JSON.stringify({
    numTotalTests: 5,
    numPassedTests: 5,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    ...overrides,
  });
const playwright = (stats = {}) =>
  JSON.stringify({ stats: { expected: 5, unexpected: 0, skipped: 0, flaky: 0, ...stats } });

test('vitest: a clean report passes the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest()), 0);
});

test('vitest: a pending (skipped) case fails the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest({ numPendingTests: 1 })), 1);
});

test('vitest: a failed case fails the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest({ numFailedTests: 1 })), 1);
});

test('vitest: a todo case fails the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest({ numTodoTests: 1 })), 1);
});

test('vitest: a run with no passing case fails the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest({ numPassedTests: 0 })), 1);
});

test('vitest: a missing counter is an error, never a zero', { skip: skipReason }, () => {
  assert.equal(
    accounting('vitest', JSON.stringify({ numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numTodoTests: 0 })),
    2,
  );
  assert.equal(accounting('vitest', JSON.stringify({ numPassedTests: 5 })), 2);
});

test('vitest: a null counter is an error', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest({ numFailedTests: null })), 2);
});

test('vitest: a non-integer, negative or string counter is an error', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', vitest({ numFailedTests: 1.5 })), 2);
  assert.equal(accounting('vitest', vitest({ numPendingTests: -1 })), 2);
  assert.equal(accounting('vitest', vitest({ numPassedTests: '5' })), 2);
});

test('vitest: a missing report file is an error', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', undefined), 2);
});

test('vitest: an unreadable report is an error', { skip: skipReason }, () => {
  assert.equal(accounting('vitest', 'not json'), 2);
});

test('playwright: a clean report passes the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('playwright', playwright()), 0);
});

test('playwright: skipped, unexpected, flaky or empty runs fail the scenario', { skip: skipReason }, () => {
  assert.equal(accounting('playwright', playwright({ skipped: 1 })), 1);
  assert.equal(accounting('playwright', playwright({ unexpected: 1 })), 1);
  assert.equal(accounting('playwright', playwright({ flaky: 1 })), 1);
  assert.equal(accounting('playwright', playwright({ expected: 0 })), 1);
});

test('playwright: missing stats or counters are errors', { skip: skipReason }, () => {
  assert.equal(accounting('playwright', '{}'), 2);
  assert.equal(
    accounting('playwright', JSON.stringify({ stats: { expected: 5, unexpected: 0, flaky: 0 } })),
    2,
  );
});
