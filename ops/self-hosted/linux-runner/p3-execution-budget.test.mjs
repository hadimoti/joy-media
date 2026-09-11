/* global Buffer, process */

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createP3ExecutionBudget,
  createBoundedOutput,
  runOwnedP3Process,
} from './p3-execution-budget.mjs';
import { terminateProcessTree } from './real-service-teardown.mjs';

describe('createP3ExecutionBudget', () => {
  it('uses a monotonic clock for elapsed, remaining, and admission', () => {
    let tick = 100;
    const budget = createP3ExecutionBudget({
      workBudgetMs: 1_000,
      cleanupReserveMs: 200,
      now: () => tick,
      utcNow: () => '2026-09-11T06:00:00.000Z',
    });
    tick = 700;
    expect(budget.elapsedMs()).toBe(600);
    expect(budget.remainingMs()).toBe(400);
    expect(budget.canStart(200)).toBe(true);
    expect(budget.canStart(201)).toBe(false);
    tick = 1_200;
    expect(budget.isExpired()).toBe(true);
  });

  it('expires and cancels exactly once while retaining a terminal record', () => {
    let tick = 0;
    const budget = createP3ExecutionBudget({
      workBudgetMs: 50,
      now: () => tick,
      utcNow: () => '2026-09-11T06:00:00.000Z',
    });
    tick = 50;
    expect(budget.expire()).toBe(true);
    expect(budget.cancel('late-cancel')).toBe(false);
    expect(budget.terminal()).toEqual({
      reason: 'deadline',
      elapsedMs: 50,
      utc: '2026-09-11T06:00:00.000Z',
    });
  });

  it('emits only redacted progress fields', () => {
    const budget = createP3ExecutionBudget({ workBudgetMs: 500, now: () => 10 });
    expect(
      budget.progress({
        candidateSha: 'a'.repeat(40),
        runId: '12',
        runAttempt: '1',
        pass: '2',
        caseId: 'editorial-clean/reels-1080',
        phase: 'started',
        result: null,
        secret: 'must-not-appear',
      }),
    ).toMatchObject({
      candidateSha: 'a'.repeat(40),
      runId: '12',
      runAttempt: '1',
      pass: '2',
      caseId: 'editorial-clean/reels-1080',
      phase: 'started',
      elapsedMs: 0,
      deadlineMs: 500,
    });
  });
});

describe('createBoundedOutput', () => {
  it('retains bounded beginning and ending diagnostics without duplication', () => {
    const output = createBoundedOutput(10);
    output.append('abcdefgh');
    output.append('ijklmnop');
    const text = output.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      10 + Buffer.byteLength('\n[… output capped …]\n'),
    );
    expect(text.startsWith('abcde')).toBe(true);
    expect(text.endsWith('mnop')).toBe(true);
  });
});

describe('runOwnedP3Process', () => {
  it('settles a successful owned child once and returns bounded output', async () => {
    const budget = createP3ExecutionBudget({ workBudgetMs: 2_000, cleanupReserveMs: 100 });
    const result = await runOwnedP3Process(
      process.execPath,
      ['-e', "process.stdout.write('child-ok')"],
      {
        budget,
        stageBudgetMs: 1_000,
        terminate: async () => ({ state: 'not-needed' }),
        spawnFn: spawn,
        maxOutputBytes: 64,
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('child-ok');
    expect(budget.isTerminated()).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'terminates a child that ignores TERM at the deadline and preserves diagnostics',
    async () => {
      const budget = createP3ExecutionBudget({ workBudgetMs: 80, cleanupReserveMs: 20 });
      let progress = [];
      await expect(
        runOwnedP3Process(
          process.execPath,
          [
            '-e',
            "process.stdout.write('begin'); process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'),10)",
          ],
          {
            budget,
            terminate: (child) =>
              terminateProcessTree(child, { graceMs: 30, killMs: 500, pollMs: 10 }),
            maxOutputBytes: 32,
            onProgress: (event) => progress.push(event),
          },
        ),
      ).rejects.toMatchObject({ code: 'P3_DEADLINE' });
      expect(budget.isTerminated()).toBe(true);
      expect(progress.map((event) => event.phase)).toContain('deadline');
    },
  );
});
