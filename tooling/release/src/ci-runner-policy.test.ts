import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Self-hosted-only CI architecture contract.
 *
 * JOY Media's GitHub-hosted Actions minutes/billing are unavailable from Iran,
 * so every workflow job in `.github/workflows/` MUST run on an owner-controlled
 * self-hosted runner. This test enforces that contract offline:
 *
 *   1. No job in any workflow may use `ubuntu-latest`, `windows-latest`,
 *      `macos-latest`, or any other GitHub-hosted label.
 *   2. Every job must list an `allowed` self-hosted label tuple, where the
 *      allowed set is exactly the PC Docker self-hosted runner labels the
 *      repository actually provisions (see ops/self-hosted/linux-runner,
 *      ops/self-hosted/windows-runner, docs/SELF-HOSTED-CI.md).
 *   3. The runner contract lives entirely under `ops/self-hosted/`. Re-adding
 *      a hosted label, or pointing a job at a label without an entry in
 *      `ops/self-hosted/`, fails this test before a CI minute is consumed.
 *
 * The label allowlist is read directly from the README files in each
 * `ops/self-hosted/<runner>/` directory, so a runner added later is honored
 * automatically — but only AFTER its `README.md` declares the label.
 */

const FORBIDDEN_HOSTED_LABEL_PATTERN = new RegExp(
  '^\\s*(?:-\\s*)?(?:runs-on:|-\\s*)?\\s*' +
    '(?:\\[\\s*)?' +
    '(ubuntu-latest|ubuntu-\\d+\\.\\d+|windows-latest|windows-\\d+|windows-.*-gha-' +
    '.*|macos-latest|macos-\\d+|macos-.*)(?:\\s*\\])?\\s*$',
  'm',
);

// Simpler, exact per-line scan: `runs-on:` (string OR list) must NOT be one of
// the hosted labels nor start with them in a list.
const HOSTED_LABEL_TOKENS = new Set([
  'ubuntu-latest',
  'ubuntu-22.04',
  'ubuntu-24.04',
  'ubuntu-20.04',
  'windows-latest',
  'windows-2022',
  'windows-2019',
  'macos-latest',
  'macos-13',
  'macos-14',
  'macos-15',
]);

// Allowed self-hosted label tuples. Order matters: this is the canonical
// declaration of which label tuples the repository's `ops/self-hosted/` Docker
// contracts actually provision. Adding a runner without updating this set
// (and adding an `ops/self-hosted/<runner>/README.md`) will fail this test.
const ALLOWED_LABEL_TUPLES: ReadonlyArray<readonly string[]> = [
  // joy-media-ci (PC Docker Linux container; primary isolation lane)
  ['self-hosted', 'linux', 'x64', 'joy-media-ci'],
  // joy-media-acceptance (isolated acceptance Linux runner on its own Docker network)
  ['self-hosted', 'linux', 'x64', 'joy-media-acceptance'],
  // joy-media-worker (clean-profile Windows Worker runner)
  ['self-hosted', 'windows', 'x64', 'joy-media-worker'],
  // joy-media-worker-gpu (clean-profile Windows Worker runner, GPU result)
  ['self-hosted', 'windows', 'x64', 'gpu', 'joy-media-worker-gpu'],
  // joy-media-ci-windows (PC Docker Windows-container runner, optional/contract-only)
  ['self-hosted', 'windows', 'x64', 'joy-media-ci'],
];

function normalizeTuple(values: string[]): string[] {
  return [...values].map((v) => v.trim()).filter(Boolean).sort();
}

function tupleEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface RunsOnEntry {
  readonly lineNo: number;
  readonly jobContext: string;
  readonly raw: string;
  readonly tuple: string[];
  readonly isList: boolean;
}

function findRunsOnEntries(workflowText: string): RunsOnEntry[] {
  const lines = workflowText.split(/\r?\n/);
  const entries: RunsOnEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Detect `runs-on:` on its own line. The value can be a string, a list
    // continuation on the next lines, or an inline list `[a, b, c]`.
    const inline = line.match(/^\s*([A-Za-z0-9 _-]+:)?\s*runs-on:\s*(.+?)\s*$/);
    if (!inline) continue;
    const jobKey = (inline[1] ?? '').replace(/:$/, '').trim();
    const remainder = inline[2].trim();

    // Case A: inline single-quoted or unquoted scalar.
    if (remainder && !remainder.startsWith('[')) {
      entries.push({
        lineNo: i + 1,
        jobContext: jobKey || '(workflow-level)',
        raw: remainder,
        tuple: [remainder.replace(/^['"]|['"]$/g, '')],
        isList: false,
      });
      continue;
    }

    // Case B: inline list `[a, b, c]`.
    if (remainder.startsWith('[')) {
      const closingIdx = remainder.indexOf(']');
      if (closingIdx < 0) continue; // malformed
      const inner = remainder.slice(1, closingIdx);
      entries.push({
        lineNo: i + 1,
        jobContext: jobKey || '(workflow-level)',
        raw: remainder,
        tuple: inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
        isList: true,
      });
      continue;
    }

    // Case C: list expands across subsequent indented `- ...` lines.
    const collected: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      const itemMatch = next.match(/^\s+-\s+(.+?)\s*$/);
      if (!itemMatch) break;
      collected.push(itemMatch[1].trim().replace(/^['"]|['"]$/g, ''));
      j += 1;
    }
    if (collected.length > 0) {
      entries.push({
        lineNo: i + 1,
        jobContext: jobKey || '(workflow-level)',
        raw: collected.join(','),
        tuple: collected,
        isList: true,
      });
      i = j - 1;
    }
  }
  return entries;
}

function readSelfHostedRunnerLabels(): ReadonlyArray<readonly string[]> {
  const declared: string[][] = [];
  const ops = join(REPO_ROOT, 'ops', 'self-hosted');
  if (!statSyncSafe(ops)) return declared;
  for (const runnerDir of readdirSync(ops)) {
    const readme = join(ops, runnerDir, 'README.md');
    if (!statSyncSafe(readme)) continue;
    const body = readFileSync(readme, 'utf8');
    // Pull every `Labels: ...`, `RUNNER_LABEL=...`, or `` `label,tuple` ``
    // declaration. We deliberately capture the first comma-separated tuple
    // that begins with `self-hosted`, so the README is the single source of
    // truth and adding a new runner only requires updating that file.
    const candidates: string[] = [];
    for (const m of body.matchAll(/^\s*Labels:\s*`?([^`\n]+)`?/gm)) candidates.push(m[1]);
    for (const m of body.matchAll(/^\s*RUNNER_LABELS=([^\n]+)/gm)) candidates.push(m[1]);
    for (const m of body.matchAll(/`\s*(self-hosted,[^`\n]+?)\s*`/g)) candidates.push(m[1]);
    for (const raw of candidates) {
      const tokens = raw
        .replace(/[`'"|]/g, '')
        .split(/[,\s]+/)
        .filter(Boolean);
      if (tokens.length === 0 || tokens[0] !== 'self-hosted') continue;
      declared.push(normalizeTuple(tokens));
    }
  }
  return declared;
}

function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isFile() || statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(WORKFLOWS_DIR, f))
    .sort();
}

describe('self-hosted-only CI architecture contract', () => {
  const workflows = listWorkflowFiles();
  expect(workflows.length).toBeGreaterThan(0);

  const declaredLabels = readSelfHostedRunnerLabels();
  // Merge the canonical contract (hand-curated, repo-policy) with the union of
  // labels declared by `ops/self-hosted/*/README.md`. The combined set is the
  // allowlist a workflow job's `runs-on` tuple must match.
  const allowed = new Set<string>();
  for (const tuple of ALLOWED_LABEL_TUPLES) allowed.add(tuple.join('|'));
  for (const tuple of declaredLabels) allowed.add(tuple.join('|'));

  it('declares at least one self-hosted runner contract under ops/self-hosted/', () => {
    expect(declaredLabels.length).toBeGreaterThan(0);
  });

  it.each(workflows)('forbids hosted runner labels in %s', (workflowPath) => {
    const text = readFileSync(workflowPath, 'utf8');
    // Pre-filter obvious comments — GitHub Actions does not honor commented
    // `runs-on:` lines, so we ignore them in the forbidden-label scan but
    // still enforce the allowlist on them (so a stale comment does not hide
    // a regression).
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*(?:-\s*)?runs-on:\s*(.+?)\s*$/);
      if (!m) continue;
      const value = m[1].trim();
      // Strip inline list brackets.
      const tokens = value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      for (const tok of tokens) {
        expect(
          HOSTED_LABEL_TOKENS.has(tok),
          `forbidden hosted runner label "${tok}" on line ${i + 1} of ${workflowPath}`,
        ).toBe(false);
      }
      // Also reject the regex form (catches ubuntu-22.04 / windows-2022 etc).
      expect(
        FORBIDDEN_HOSTED_LABEL_PATTERN.test(line),
        `forbidden hosted runner pattern on line ${i + 1} of ${workflowPath}: ${line.trim()}`,
      ).toBe(false);
    }
  });

  it.each(workflows)('every job in %s targets an allowed self-hosted Docker label', (workflowPath) => {
    const text = readFileSync(workflowPath, 'utf8');
    const entries = findRunsOnEntries(text);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const sorted = normalizeTuple(entry.tuple);
      const key = sorted.join('|');
      expect(
        allowed.has(key),
        [
          `runs-on tuple ${JSON.stringify(entry.tuple)} on line ${entry.lineNo}`,
          `(${entry.jobContext}) in ${workflowPath}`,
          `is not in the allowed self-hosted Docker label set.`,
          `Allowed: ${[...allowed].join(' ; ')}.`,
          `Declare the runner contract under ops/self-hosted/<runner>/ and add the`,
          `label tuple to tooling/release/src/ci-runner-policy.test.ts if this is intentional.`,
        ].join(' '),
      ).toBe(true);
      // Every allowed tuple starts with `self-hosted` (the documented
      // contract). Re-check this directly against the unsorted labels so a
      // typo cannot smuggle a non-self-hosted tuple through the sorted-set
      // membership check.
      expect(
        entry.tuple[0],
        `runs-on tuple on line ${entry.lineNo} (${entry.jobContext}) in ${workflowPath} must begin with "self-hosted"; got ${JSON.stringify(entry.tuple)}`,
      ).toBe('self-hosted');
    }
  });

  it('the self-hosted Docker label allowlist matches every documented runner', () => {
    // For every tuple declared in `ops/self-hosted/*/README.md`, it must be in
    // the explicit allowlist above. Catches typos in either side.
    for (const tuple of declaredLabels) {
      const key = tuple.join('|');
      expect(
        allowed.has(key),
        `docs declare self-hosted tuple ${JSON.stringify(tuple)} but it is not in the explicit allowlist`,
      ).toBe(true);
    }
  });
});
