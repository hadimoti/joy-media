#!/usr/bin/env node
/* global Buffer, clearTimeout, performance, setTimeout */

import { spawn as defaultSpawn } from 'node:child_process';

/**
 * Small, dependency-free P3 budget primitives. The clock is injectable so the
 * admission and expiry rules can be tested without waiting in real time.
 */

const finiteNonNegative = (value, name) => {
  if (value === Infinity) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`p3-execution-budget: ${name} must be a non-negative number or Infinity`);
  }
  return value;
};

export function createP3ExecutionBudget({
  workBudgetMs = Infinity,
  cleanupReserveMs = 0,
  now = () => performance.now(),
  utcNow = () => new Date().toISOString(),
} = {}) {
  const work = finiteNonNegative(workBudgetMs, 'workBudgetMs');
  const reserve = finiteNonNegative(cleanupReserveMs, 'cleanupReserveMs');
  const startedAt = now();
  if (!Number.isFinite(startedAt))
    throw new Error('p3-execution-budget: clock returned a non-finite value');
  const deadlineAt = work === Infinity ? Infinity : startedAt + work;
  let terminal = null;

  const elapsedMs = () => Math.max(0, now() - startedAt);
  const remainingMs = () => (deadlineAt === Infinity ? Infinity : Math.max(0, deadlineAt - now()));
  const canStart = (stageBudgetMs) => {
    const stage = finiteNonNegative(stageBudgetMs, 'stageBudgetMs');
    return remainingMs() >= stage + reserve;
  };
  const terminate = (reason = 'deadline') => {
    if (terminal !== null) return false;
    terminal = { reason: String(reason), elapsedMs: elapsedMs(), utc: utcNow() };
    return true;
  };

  return Object.freeze({
    startedAt,
    deadlineAt,
    workBudgetMs: work,
    cleanupReserveMs: reserve,
    elapsedMs,
    remainingMs,
    canStart,
    isExpired: () => terminal !== null || remainingMs() <= 0,
    isTerminated: () => terminal !== null,
    terminal: () => terminal,
    expire: () => terminate('deadline'),
    cancel: (reason = 'cancelled') => terminate(reason),
    progress: ({ candidateSha, runId, runAttempt, pass, caseId = null, phase, result = null }) => ({
      candidateSha,
      runId,
      runAttempt,
      pass,
      caseId,
      phase,
      elapsedMs: elapsedMs(),
      deadlineMs: work,
      result,
      utc: utcNow(),
    }),
  });
}

/** Keep both the beginning and the most recent diagnostic tail. */
export function createBoundedOutput(maxBytes = 64 * 1024) {
  if (!Number.isInteger(maxBytes) || maxBytes < 2) {
    throw new Error('p3-execution-budget: maxBytes must be an integer >= 2');
  }
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let truncated = false;

  return Object.freeze({
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      let remainder = bytes;
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        const headPart = bytes.subarray(0, room);
        head = Buffer.concat([head, headPart]);
        remainder = bytes.subarray(headPart.length);
      } else {
        remainder = bytes;
      }
      if (remainder.length > 0) {
        truncated = true;
        tail = Buffer.concat([tail, remainder]).subarray(-tailLimit);
      }
    },
    text() {
      const marker = truncated ? Buffer.from('\n[… output capped …]\n') : Buffer.alloc(0);
      return Buffer.concat([head, marker, tail]).toString('utf8');
    },
    byteLength() {
      return head.length + tail.length;
    },
  });
}

/**
 * Run one owned child with a real deadline. The caller supplies its proven
 * process-tree terminator (the harness uses real-service-teardown.mjs), which
 * keeps this helper testable without granting it arbitrary process authority.
 */
export function runOwnedP3Process(
  file,
  args,
  {
    budget,
    terminate,
    stageBudgetMs,
    spawnFn = defaultSpawn,
    spawnOptions = {},
    input,
    maxOutputBytes = 64 * 1024,
    onProgress,
  } = {},
) {
  if (!budget || typeof budget.remainingMs !== 'function')
    throw new Error('p3-execution-budget: budget is required');
  if (typeof terminate !== 'function')
    throw new Error('p3-execution-budget: terminate callback is required');
  const remainingSnapshot = budget.remainingMs();
  const reserve = budget.cleanupReserveMs;
  const stage = stageBudgetMs ?? Math.max(0, remainingSnapshot - reserve);
  if (stageBudgetMs === undefined) {
    if (remainingSnapshot < stage + reserve) {
      return Promise.reject(
        new Error('p3-execution-budget: stage plus cleanup reserve does not fit'),
      );
    }
  } else if (!budget.canStart(stage)) {
    return Promise.reject(
      new Error('p3-execution-budget: stage plus cleanup reserve does not fit'),
    );
  }
  const stdout = createBoundedOutput(maxOutputBytes);
  const stderr = createBoundedOutput(maxOutputBytes);
  const child = spawnFn(file, args, {
    ...spawnOptions,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let timer;
  let settled = false;
  let terminating = false;
  const report = (phase, result = null) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, result, elapsedMs: budget.elapsedMs(), deadlineMs: budget.workBudgetMs });
    } catch {
      // Progress is diagnostic; a logger failure must not interrupt ownership.
    }
  };
  report('child-started');

  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error) {
        error.stdout = stdout.text();
        error.stderr = stderr.text();
        reject(error);
      } else resolve(result);
    };
    const onTimeout = async () => {
      if (settled || terminating) return;
      terminating = true;
      budget.expire();
      report('deadline', 'FAIL');
      let termination;
      try {
        termination = await terminate(child);
      } catch (error) {
        termination = { state: 'terminator-error', error: String(error) };
      }
      const error = new Error(`P3 child exceeded ${stage}ms work deadline`);
      error.code = 'P3_DEADLINE';
      error.termination = termination;
      finish(error);
    };
    child.stdout?.on('data', (chunk) => stdout.append(chunk));
    child.stderr?.on('data', (chunk) => stderr.append(chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (terminating) return;
      if (code === 0) {
        report('child-finished', 'PASS');
        finish(null, {
          code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
        });
      } else {
        report('child-finished', 'FAIL');
        const error = new Error(`command ${file} exited with ${code ?? signal ?? 'unknown'}`);
        error.code = code;
        error.signal = signal;
        finish(error);
      }
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
    if (Number.isFinite(stage)) timer = setTimeout(onTimeout, stage);
  });
}
