import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKER, parseReleased, run } from './prune-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, '../../../');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-26T00:00:00Z');
const OLD = new Date(NOW - 45 * DAY);
const RECENT = new Date(NOW - 2 * DAY);
const RELEASED = 'a'.repeat(40);
const UNRELEASED_OLD = 'b'.repeat(40);
const UNRELEASED_RECENT = 'c'.repeat(40);

let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'prune-evidence-'));
  root = join(base, 'store');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), 'created by the owner\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Writes one retained run whose files all carry the given time. */
function writeRun(candidate: string, runName: string, when: Date): string {
  const dir = join(root, candidate, runName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'artifact-manifest.json');
  writeFileSync(file, '{"files":[]}\n');
  utimesSync(file, when, when);
  return dir;
}

function releasedFile(...shas: string[]): string {
  const file = join(base, 'released.txt');
  writeFileSync(file, `${shas.join('\n')}\n`);
  return file;
}

function prune(...extra: string[]) {
  return run([root, '--now', new Date(NOW).toISOString(), ...extra], {}, { now: NOW });
}

describe('pruning the durable evidence store', () => {
  it('refuses a store without the owner marker, and removes nothing', () => {
    rmSync(join(root, MARKER));
    const old = writeRun(UNRELEASED_OLD, '1-1-release-artifacts', OLD);

    expect(() => prune()).toThrow(/no JOY_EVIDENCE_STORE marker/u);
    expect(existsSync(old)).toBe(true);
  });

  it('refuses a root inside this checkout', () => {
    expect(() => run([join(checkout, 'test-output-not-a-store')], {}, { now: NOW })).toThrow(
      /outside the checkout/u,
    );
  });

  it('dry-run lists the old unreleased runs and deletes nothing', () => {
    const old = writeRun(UNRELEASED_OLD, '1-1-release-artifacts', OLD);

    const { report, exitCode } = prune();

    expect(exitCode).toBe(0);
    expect(report.mode).toBe('dry-run');
    expect(report.wouldPrune).toEqual([`${UNRELEASED_OLD}/1-1-release-artifacts`]);
    expect(report.pruned).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it('apply removes only old unreleased runs; released candidates, recent runs and top-level files stay', () => {
    const released = writeRun(RELEASED, '2-1-release-artifacts', OLD);
    const old = writeRun(UNRELEASED_OLD, '3-1-release-artifacts', OLD);
    const recent = writeRun(UNRELEASED_RECENT, '4-1-release-artifacts', RECENT);

    const { report } = prune('--apply', '--released', releasedFile(RELEASED));

    expect(report.mode).toBe('apply');
    expect(report.pruned).toEqual([`${UNRELEASED_OLD}/3-1-release-artifacts`]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(released)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(root, MARKER))).toBe(true);
    expect(readdirSync(root).sort()).toEqual(
      [MARKER, RELEASED, UNRELEASED_OLD, UNRELEASED_RECENT].sort(),
    );
  });

  it('keeps a run whose newest file is recent, even when its manifest is old', () => {
    const dir = writeRun(UNRELEASED_OLD, '5-1-release-artifacts', OLD);
    const receipt = join(dir, 'receipt.json');
    writeFileSync(receipt, '{}\n');
    utimesSync(receipt, RECENT, RECENT);

    const { report } = prune('--apply');

    expect(report.wouldPrune).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses the whole run when a symbolic link sits in the store, and removes nothing', () => {
    const old = writeRun(UNRELEASED_OLD, '6-1-release-artifacts', OLD);
    const outside = join(base, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, UNRELEASED_OLD, 'escape'), 'junction');

    expect(() => prune('--apply')).toThrow(/symbolic link/u);
    expect(existsSync(old)).toBe(true);
    expect(readFileSync(join(root, MARKER), 'utf8')).toContain('owner');
  });

  it('keeps the run count and bytes honest in the dry-run report', () => {
    writeRun(UNRELEASED_OLD, '7-1-release-artifacts', OLD);
    writeRun(UNRELEASED_OLD, '8-1-release-artifacts', OLD);

    const { report } = prune();

    expect(report.wouldPrune).toHaveLength(2);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.releasedCandidates).toBe(0);
  });

  it('validates the age and the released list before reading the store', () => {
    expect(() => prune('--older-than-days', '0')).toThrow(/whole number of days/u);
    expect(() => prune('--released', releasedFile('not-a-sha'))).toThrow(
      /not a full lowercase commit SHA/u,
    );
    expect(() => run([], {}, { now: NOW })).toThrow(/usage: prune-evidence/u);
  });
});

describe('released-candidate list', () => {
  it('accepts full lowercase SHAs and blank lines, and refuses anything else', () => {
    expect([...parseReleased(`${RELEASED}\n\n${UNRELEASED_OLD}\r\n`)]).toEqual([
      RELEASED,
      UNRELEASED_OLD,
    ]);
    expect(() => parseReleased('A'.repeat(40))).toThrow(/line 1/u);
    expect(() => parseReleased(`${RELEASED}\nabc123`)).toThrow(/line 2/u);
  });
});

describe('the gate never deletes evidence (D20)', () => {
  it('no workflow names the pruning utility', () => {
    const workflows = join(checkout, '.github', 'workflows');
    for (const name of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, name), 'utf8');
      expect(text, name).not.toContain('prune-evidence');
    }
  });
});
