import { describe, expect, it } from 'vitest';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Explicit CI runner placement contract.
 *
 * Hosted jobs are permitted only for explicitly listed workflow/job pairs.
 * Every other job must use an allowlisted self-hosted label tuple. This test
 * enforces the exact split offline:
 *
 *   1. Only explicitly listed jobs may use `ubuntu-24.04` or `windows-2025`;
 *      all other hosted labels are forbidden.
 *   2. Every other job must list an `allowed` self-hosted label tuple, where the
 *      allowed set is exactly the tuples declared by the repository's runner
 *      contracts.
 *   3. Re-adding a hosted label elsewhere, or pointing a job at a label without
 *      an entry in `ops/self-hosted/`, fails this test.
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
  'windows-2025',
  'windows-2022',
  'windows-2019',
  'macos-latest',
  'macos-13',
  'macos-14',
  'macos-15',
]);

const APPROVED_HOSTED_RUNNERS: ReadonlyMap<
  string,
  ReadonlyMap<string, readonly string[]>
> = new Map([
  [
    join(WORKFLOWS_DIR, 'release-candidate-v2.yml'),
    new Map([
      ['validate-candidate', ['ubuntu-24.04']],
      ['node-contracts', ['ubuntu-24.04']],
      ['editor-web-bundle', ['ubuntu-24.04']],
      ['acceptance-responsive', ['ubuntu-24.04']],
    ]),
  ],
  [
    join(WORKFLOWS_DIR, 'ci-dev.yml'),
    new Map([
      ['static-and-unit', ['ubuntu-24.04']],
      ['worker-package', ['windows-2025']],
      ['browser', ['ubuntu-24.04']],
      ['development-verification-summary', ['ubuntu-24.04']],
    ]),
  ],
]);

interface ParsedWorkflow {
  readonly on?: unknown;
  readonly jobs?: unknown;
  readonly permissions?: unknown;
}

interface YamlParser {
  load(source: string): unknown;
}

interface WorkflowJob {
  readonly 'runs-on'?: unknown;
}

function loadYamlParser(): YamlParser {
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  const packageEntry = readdirSync(store).find((entry) => entry.startsWith('js-yaml@'));
  if (!packageEntry) throw new Error('js-yaml is not available in the installed node_modules');
  const requireFromYaml = createRequire(
    join(store, packageEntry, 'node_modules', 'js-yaml', 'package.json'),
  );
  return requireFromYaml('js-yaml') as YamlParser;
}

const yamlParser = loadYamlParser();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflow(workflowPath: string): ParsedWorkflow {
  const parsed = yamlParser.load(readFileSync(workflowPath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${workflowPath} must parse to a YAML mapping`);
  return parsed as ParsedWorkflow;
}

function workflowTriggers(workflow: ParsedWorkflow, workflowPath: string): Record<string, unknown> {
  if (!isRecord(workflow.on)) throw new Error(`${workflowPath} must declare workflow triggers`);
  return workflow.on;
}

function isMainOnlyPush(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.branches)) return false;
  return (
    value.branches.length === 1 &&
    value.branches[0] === 'main' &&
    value['branches-ignore'] === undefined &&
    value.tags === undefined &&
    value['tags-ignore'] === undefined
  );
}

function hasSelfHostedRunner(job: WorkflowJob): boolean {
  if (typeof job['runs-on'] === 'string') return job['runs-on'] === 'self-hosted';
  return Array.isArray(job['runs-on']) && job['runs-on'].includes('self-hosted');
}

function assertCiDevTrustPolicy(workflowsDir: string): void {
  const workflowPath = join(workflowsDir, 'ci-dev.yml');
  const source = readFileSync(workflowPath, 'utf8');
  const workflow = parseWorkflow(workflowPath);
  if (/self-hosted/i.test(source)) throw new Error('ci-dev.yml must not mention self-hosted');
  if (/\bsecrets\./i.test(source)) throw new Error('ci-dev.yml must not reference secrets');
  if (!isRecord(workflow.permissions) || workflow.permissions.contents !== 'read') {
    throw new Error('ci-dev.yml must set top-level permissions contents: read');
  }
}

function assertWorkflowTrustInvariants(workflowsDir: string): void {
  assertCiDevTrustPolicy(workflowsDir);
  const allowedSelfHostedTriggers = new Set(['workflow_dispatch', 'push']);
  const forbiddenTriggers = new Set(['pull_request_target', 'workflow_run', 'issue_comment']);

  for (const fileName of readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort()) {
    const workflowPath = join(workflowsDir, fileName);
    const workflow = parseWorkflow(workflowPath);
    const triggers = workflowTriggers(workflow, workflowPath);
    const triggerNames = Object.keys(triggers);

    for (const trigger of forbiddenTriggers) {
      if (triggerNames.includes(trigger)) {
        throw new Error(`${fileName} uses forbidden workflow trigger ${trigger}`);
      }
    }
    if (Object.hasOwn(triggers, 'push') && !isMainOnlyPush(triggers.push)) {
      throw new Error(`${fileName} push trigger must be restricted to main`);
    }

    if (!isRecord(workflow.jobs)) continue;
    for (const [jobName, jobValue] of Object.entries(workflow.jobs)) {
      if (!isRecord(jobValue) || !hasSelfHostedRunner(jobValue as WorkflowJob)) continue;
      const unsupportedTriggers = triggerNames.filter(
        (trigger) => !allowedSelfHostedTriggers.has(trigger),
      );
      if (unsupportedTriggers.length > 0) {
        throw new Error(
          `${fileName} job ${jobName} uses self-hosted runners with unsupported triggers: ` +
            unsupportedTriggers.join(', '),
        );
      }
    }
  }
}

function withMutatedWorkflowCopy(
  workflowFile: string,
  mutate: (source: string) => string,
  check: (workflowsDir: string) => void,
): void {
  const tempBase = resolve(tmpdir());
  const tempRoot = resolve(mkdtempSync(join(tempBase, 'ci-runner-policy-')));
  if (!tempRoot.startsWith(`${tempBase}${sep}`)) {
    throw new Error('temporary workflow copy must stay inside the system temp directory');
  }
  const workflowsDir = join(tempRoot, 'workflows');
  try {
    cpSync(WORKFLOWS_DIR, workflowsDir, { recursive: true });
    const workflowPath = join(workflowsDir, workflowFile);
    writeFileSync(workflowPath, mutate(readFileSync(workflowPath, 'utf8')));
    check(workflowsDir);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// Allowed self-hosted label tuples. Order matters: this is the canonical
// declaration of which label tuples the repository's `ops/self-hosted/` Docker
// contracts actually provision. Adding a runner without updating this set
// (and adding an `ops/self-hosted/<runner>/README.md`) will fail this test.
const ALLOWED_LABEL_TUPLES: ReadonlyArray<readonly string[]> = [
  // joy-media-ci (PC Docker Linux container; primary isolation lane)
  ['self-hosted', 'linux', 'x64', 'joy-media-ci'],
  // joy-media-acceptance (isolated acceptance Linux runner with its own volume)
  ['self-hosted', 'linux', 'x64', 'joy-media-acceptance'],
  // joy-media-worker-docker (Windows-container Worker/release lane)
  ['self-hosted', 'windows', 'x64', 'joy-media-worker-docker'],
  // A future GPU-capable Windows-container lane must remain explicitly named
  // and must not reuse a host-direct label.
  ['self-hosted', 'windows', 'x64', 'gpu', 'joy-media-worker-gpu-docker'],
];

function normalizeTuple(values: string[]): string[] {
  return [...values]
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
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
  let currentJobContext = '(workflow-level)';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const jobHeader = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (jobHeader) {
      currentJobContext = jobHeader[1];
      continue;
    }
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
        jobContext: jobKey || currentJobContext,
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
        jobContext: jobKey || currentJobContext,
        raw: remainder,
        tuple: inner
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean),
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
        jobContext: jobKey || currentJobContext,
        raw: collected.join(','),
        tuple: collected,
        isList: true,
      });
      i = j - 1;
    }
  }
  return entries;
}

function findJobBlock(workflowText: string, jobName: string): string {
  const lines = workflowText.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z0-9-]+:\s*$/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function assertReleaseCandidateWorkflowTriggers(workflowText: string): void {
  const parsed: unknown = yamlParser.load(workflowText);
  const triggers = isRecord(parsed) && isRecord(parsed.on) ? Object.keys(parsed.on) : [];
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
    throw new Error('release-candidate-v2.yml must use workflow_dispatch as its only trigger');
  }
}

function assertReleaseCandidateConcurrency(workflowText: string): void {
  const lines = workflowText.split(/\r?\n/);
  const concurrencyIndex = lines.findIndex((line) => line === 'concurrency:');
  if (concurrencyIndex < 0) throw new Error('release-candidate-v2.yml must declare concurrency');

  const blockLines: string[] = [];
  for (let i = concurrencyIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== '' && !/^[ \t]/.test(line)) break;
    blockLines.push(line);
  }
  const block = blockLines.join('\n');
  const groups = [...block.matchAll(/^ {2}group:\s*(.*?)\s*$/gm)].map((match) => match[1]);
  const cancellation = [...block.matchAll(/^ {2}cancel-in-progress:\s*(.*?)\s*$/gm)].map(
    (match) => match[1],
  );

  if (
    groups.length !== 1 ||
    groups[0] !== 'release-candidate-v2-${{ inputs.candidate_sha }}' ||
    cancellation.length !== 1 ||
    cancellation[0] !== 'false'
  ) {
    throw new Error(
      'release-candidate-v2 concurrency must use the candidate SHA group and cancel-in-progress: false',
    );
  }
}

function findWindowsDockerJobBlocks(workflowText: string): string[] {
  const lines = workflowText.split(/\r?\n/);
  const blocks: string[] = [];
  let jobStart = -1;

  const flush = (end: number) => {
    if (jobStart < 0) return;
    const block = lines.slice(jobStart, end).join('\n');
    if (block.includes('runs-on: [self-hosted, windows, x64, joy-media-worker-docker]')) {
      blocks.push(block);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      flush(i);
      jobStart = i;
    }
  }
  flush(lines.length);
  return blocks;
}

function findRunStepBlocks(jobBlock: string): string[] {
  const lines = jobBlock.split(/\r?\n/);
  const blocks: string[] = [];
  let stepStart = -1;

  const flush = (end: number) => {
    if (stepStart >= 0) blocks.push(lines.slice(stepStart, end).join('\n'));
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{6}-\s+/.test(lines[i])) {
      flush(i);
      stepStart = i;
    }
  }
  flush(lines.length);
  return blocks;
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

describe('CI runner placement contract', () => {
  const workflows = listWorkflowFiles();
  expect(workflows.length).toBeGreaterThan(0);

  const declaredLabels = readSelfHostedRunnerLabels();
  // Merge the canonical contract (hand-curated, repo-policy) with the union of
  // labels declared by `ops/self-hosted/*/README.md`. The combined set is the
  // allowlist a workflow job's `runs-on` tuple must match.
  const allowed = new Set<string>();
  for (const tuple of ALLOWED_LABEL_TUPLES) allowed.add(tuple.join('|'));
  for (const tuple of declaredLabels) allowed.add(tuple.join('|'));

  describe('workflow trust invariants', () => {
    it('accepts the unmodified workflow set', () => {
      expect(() => assertWorkflowTrustInvariants(WORKFLOWS_DIR)).not.toThrow();
    });

    it('rejects pull_request on a self-hosted workflow', () => {
      withMutatedWorkflowCopy(
        'ci.yml',
        (source) =>
          source.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n'),
        (workflowsDir) => {
          expect(() => assertWorkflowTrustInvariants(workflowsDir)).toThrow(
            /self-hosted runners with unsupported triggers/,
          );
        },
      );
    });

    it('rejects a self-hosted label in ci-dev.yml', () => {
      withMutatedWorkflowCopy(
        'ci-dev.yml',
        (source) =>
          source.replace(
            'runs-on: ubuntu-24.04',
            'runs-on: [self-hosted, linux, x64, joy-media-ci]',
          ),
        (workflowsDir) => {
          expect(() => assertWorkflowTrustInvariants(workflowsDir)).toThrow(
            /ci-dev.yml must not mention self-hosted/,
          );
        },
      );
    });

    it('rejects pull_request_target in any workflow', () => {
      withMutatedWorkflowCopy(
        'ci-dev.yml',
        (source) =>
          source.replace(
            '  workflow_dispatch:\n',
            '  pull_request_target:\n  workflow_dispatch:\n',
          ),
        (workflowsDir) => {
          expect(() => assertWorkflowTrustInvariants(workflowsDir)).toThrow(
            /uses forbidden workflow trigger pull_request_target/,
          );
        },
      );
    });
  });

  it('declares at least one self-hosted runner contract under ops/self-hosted/', () => {
    expect(declaredLabels.length).toBeGreaterThan(0);
  });

  it('runs media-export browser jobs on the isolated fixture-only acceptance runner', () => {
    const workflowPath = join(WORKFLOWS_DIR, 'release-candidate-v2.yml');
    const workflow = readFileSync(workflowPath, 'utf8');

    const runnerLocalSettings = [
      'JOY_MEDIA_CI_ACCEPTANCE_WORKER',
      'JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND',
      'JOY_MEDIA_CI_EVIDENCE_ROOT',
      'JOY_MEDIA_CI_DATABASE_URL',
      'JOY_MEDIA_CI_S3_ENDPOINT',
      'JOY_MEDIA_CI_S3_ACCESS_KEY',
      'JOY_MEDIA_CI_S3_SECRET_KEY',
      'JOY_MEDIA_CI_S3_SECRET_ACCESS_KEY',
      'JOY_MEDIA_CI_S3_HEALTHCHECK_URL',
      'JOY_MEDIA_OPENCLI_PROFILE',
    ];

    for (const jobName of ['acceptance-primary', 'prod-build-smoke']) {
      const job = findJobBlock(workflow, jobName);
      expect(job, `${jobName} must exist in the release workflow`).not.toBe('');
      expect(job).toContain('runs-on: [self-hosted, linux, x64, joy-media-acceptance]');
      expect(job).toContain('JOY_MEDIA_CI_ACCEPTANCE_PROFILE: fixture-only');
      expect(job).toContain('pnpm exec playwright install chromium');
      expect(job).not.toContain('pnpm exec playwright install --with-deps chromium');
      for (const setting of runnerLocalSettings) {
        expect(job, `${jobName} must clear runner-local ${setting}`).toMatch(
          new RegExp(`^\\s+${setting}: ''$`, 'm'),
        );
      }
    }
  });

  it.each(workflows)('forbids hosted runner labels in %s', (workflowPath) => {
    const text = readFileSync(workflowPath, 'utf8');
    const entriesByLine = new Map(findRunsOnEntries(text).map((entry) => [entry.lineNo, entry]));
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
      const entry = entriesByLine.get(i + 1);
      const approvedTuple = entry
        ? APPROVED_HOSTED_RUNNERS.get(workflowPath)?.get(entry.jobContext)
        : undefined;
      if (approvedTuple) {
        expect(entry?.tuple).toEqual(approvedTuple);
        continue;
      }
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

  for (const [workflowPath, hostedJobs] of APPROVED_HOSTED_RUNNERS) {
    it.each([...hostedJobs.keys()])(
      `${workflowPath}: hosted job %s enables Corepack before pnpm use`,
      (jobName) => {
        const text = readFileSync(workflowPath, 'utf8');
        const job = findJobBlock(text, jobName);
        expect(job, `hosted job ${jobName} must exist in ${workflowPath}`).not.toBe('');
        if (!/\bpnpm\s/.test(job)) return;
        expect(job, `hosted job ${jobName} must enable the pinned pnpm executable`).toContain(
          'corepack enable pnpm',
        );
      },
    );
  }

  it.each(workflows)(
    'every job in %s targets an allowed self-hosted Docker label',
    (workflowPath) => {
      const text = readFileSync(workflowPath, 'utf8');
      const entries = findRunsOnEntries(text);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        const approvedHostedTuple = APPROVED_HOSTED_RUNNERS.get(workflowPath)?.get(
          entry.jobContext,
        );
        if (approvedHostedTuple) {
          expect(entry.tuple).toEqual(approvedHostedTuple);
          continue;
        }
        const sorted = normalizeTuple(entry.tuple);
        const key = sorted.join('|');
        expect(
          allowed.has(key),
          [
            `runs-on tuple ${JSON.stringify(entry.tuple)} on line ${entry.lineNo}`,
            `(${entry.jobContext}) in ${workflowPath}`,
            `is not in the allowed self-hosted Docker label set or the exact hosted-job allowlist.`,
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
          `runs-on tuple on line ${entry.lineNo} (${entry.jobContext}) in ${workflowPath} must begin with "self-hosted" unless it matches the exact hosted-job allowlist; got ${JSON.stringify(entry.tuple)}`,
        ).toBe('self-hosted');
      }
      const observedHostedJobs = entries
        .filter((entry) => !entry.tuple.includes('self-hosted'))
        .map((entry) => [entry.jobContext, entry.tuple]);
      const expectedHostedJobs = [...(APPROVED_HOSTED_RUNNERS.get(workflowPath)?.entries() ?? [])];
      expect(observedHostedJobs).toEqual(expectedHostedJobs);
    },
  );

  it.each(workflows)(
    'Windows Docker jobs use the shell provided by the Windows runner image in %s',
    (workflowPath) => {
      const text = readFileSync(workflowPath, 'utf8');
      const jobs = findWindowsDockerJobBlocks(text);
      if (jobs.length === 0) return;

      // Dockerfile.windows intentionally provides Windows PowerShell 5.1 only;
      // `shell: pwsh` would fail before the first job command is evaluated.
      for (const job of jobs) {
        expect(job).not.toMatch(/^\s*shell:\s*pwsh\s*$/m);
        const runSteps = findRunStepBlocks(job).filter((step) =>
          /^(?:\s{6}-\s+run:|\s{8}run:)/m.test(step),
        );
        expect(runSteps.length).toBeGreaterThan(0);
        for (const step of runSteps) {
          expect(
            step,
            'every command step in the Windows Docker job must declare Windows PowerShell explicitly',
          ).toMatch(/^\s{8}shell:\s*powershell\s*$/m);
        }
      }
    },
  );

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

  it('release-candidate-v2 uses workflow_dispatch as its only trigger', () => {
    const workflow = readFileSync(join(WORKFLOWS_DIR, 'release-candidate-v2.yml'), 'utf8');
    expect(() => assertReleaseCandidateWorkflowTriggers(workflow)).not.toThrow();
  });

  it('release-candidate-v2 rejects extra triggers in temporary workflow copies', () => {
    const extraTriggers = [
      '  push:\n    branches: [main]\n',
      '  push: { branches: [main] }\n',
      '  push: # extra trigger\n',
      '# column-0 comment\n  push:\n',
    ];
    for (const extraTrigger of extraTriggers) {
      withMutatedWorkflowCopy(
        'release-candidate-v2.yml',
        (source) => {
          const mutated = source.replace(
            'on:\n  workflow_dispatch:\n',
            `on:\n${extraTrigger}  workflow_dispatch:\n`,
          );
          if (mutated === source) throw new Error('trigger mutation target was not found');
          return mutated;
        },
        (workflowsDir) => {
          const workflow = readFileSync(join(workflowsDir, 'release-candidate-v2.yml'), 'utf8');
          expect(() => assertReleaseCandidateWorkflowTriggers(workflow)).toThrow(
            /workflow_dispatch as its only trigger/,
          );
        },
      );
    }
  });

  it('release-candidate-v2 concurrency is candidate-scoped and does not cancel in progress', () => {
    const workflow = readFileSync(join(WORKFLOWS_DIR, 'release-candidate-v2.yml'), 'utf8');
    expect(() => assertReleaseCandidateConcurrency(workflow)).not.toThrow();
  });

  it('release-candidate-v2 rejects cancel-in-progress true in a temporary workflow copy', () => {
    withMutatedWorkflowCopy(
      'release-candidate-v2.yml',
      (source) => {
        const mutated = source.replace('  cancel-in-progress: false', '  cancel-in-progress: true');
        if (mutated === source) throw new Error('cancel-in-progress mutation target was not found');
        return mutated;
      },
      (workflowsDir) => {
        const workflow = readFileSync(join(workflowsDir, 'release-candidate-v2.yml'), 'utf8');
        expect(() => assertReleaseCandidateConcurrency(workflow)).toThrow(
          /cancel-in-progress: false/,
        );
      },
    );
  });

  it('Windows release candidate build has a 30-to-60 minute timeout', () => {
    const workflow = readFileSync(join(WORKFLOWS_DIR, 'release-candidate-v2.yml'), 'utf8');
    const job = findJobBlock(workflow, 'windows-worker-clean');
    const buildStep = findRunStepBlocks(job).find((step) =>
      /^ {6}- name: Build frozen Windows desktop, CLI, and Worker candidate$/m.test(step),
    );
    expect(buildStep, 'the named Windows candidate build step must exist').toBeDefined();

    const timeoutValues = [
      ...(buildStep ?? '').matchAll(/^ {8}timeout-minutes:\s*(\d+)\s*$/gm),
    ].map((match) => Number(match[1]));
    expect(timeoutValues).toHaveLength(1);
    expect(timeoutValues[0]).toBeGreaterThanOrEqual(30);
    expect(timeoutValues[0]).toBeLessThanOrEqual(60);
  });
});
