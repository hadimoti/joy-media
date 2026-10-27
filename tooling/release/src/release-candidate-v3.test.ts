// Policy for release-candidate-v3.yml, the single-pass gate on the development branch (decision D17, plan section 3.4). It pins the
// properties the design requires, and each property has a negative control: a mutated copy of the workflow that must be refused.
// The file is not the production gate, and these tests keep it from quietly becoming one. release-candidate-v2.yml is the
// production gate; its checksum is pinned here, so a change to it fails this file until the owner approves the change.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHAPES } from './create-readiness-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = join(resolve(HERE, '../../..'), '.github', 'workflows');
const V2_PATH = join(WORKFLOWS, 'release-candidate-v2.yml');
const V3_PATH = join(WORKFLOWS, 'release-candidate-v3.yml');
// The sha256 of release-candidate-v2.yml on proposal/d18-shadow-pair-2. v2 is the fallback gate, so any change to it must be deliberate
// and must update this pin with the owner's approval. The approved D18 infrastructure change (2026-10-27) edits the shadow evidence steps,
// the FFmpeg provisioning of node-contracts, and adds the shadow-evidence job. ci-artifact-policy.test.ts pins each release-deciding job
// byte for byte, so the release gate itself did not change.
const V2_SHA256 = 'ad683d7eefdc7aa5ad745ec3f634eabb8ee67b58a62167e7dfb0b2149ffe3c8f';
const yaml = createRequire(join(resolve(HERE, '../../..'), 'package.json'))('js-yaml') as {
  load(source: string): unknown;
};

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  needs?: string | string[];
  'runs-on'?: unknown;
  strategy?: unknown;
  steps?: Step[];
  env?: Record<string, string>;
  if?: string;
  outputs?: Record<string, string>;
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const FORBIDDEN_TRIGGERS = [
  'push',
  'pull_request',
  'pull_request_target',
  'workflow_run',
  'issue_comment',
  'schedule',
];
const PUBLISHING =
  /gh release|softprops|action-gh-release|git push|git tag|deploy|environment:|secrets\./iu;
// The v2 jobs that the merged v3 jobs replace. Their names are pinned below, and each v3 job runs on the runner its v2 jobs used.
const MERGED_FROM_V2: Record<string, string[]> = {
  'windows-candidate': ['windows-p0-real-services', 'windows-worker-clean'],
  'fixture-acceptance': ['acceptance-primary', 'prod-build-smoke'],
};
const SINGLE_PASS_LANES = SHAPES['single-pass'].lanes;
const SHARD_STRATEGY = { 'fail-fast': false, matrix: { shard: [1, 2, 3] } };

function needsOf(job: Job | undefined): string[] {
  return ([] as string[]).concat(job?.needs ?? []);
}

function stepsOf(workflow: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(workflow.jobs).flatMap(([job, value]) =>
    (value.steps ?? []).map((step) => ({ job, step })),
  );
}

/** A job builds the CLI after typecheck and before Vitest, so a build-gated test is collected and run against the same files. */
function bundleOrderFindings(steps: Step[]): string[] {
  const typecheck = steps.findIndex((step) => step.run?.includes('pnpm typecheck'));
  const bundle = steps.findIndex((step) =>
    step.run?.split('\n').includes('node apps/cli/scripts/bundle.mjs'),
  );
  const vitest = steps.findIndex((step) => step.run?.includes('vitest/vitest.mjs'));
  const findings: string[] = [];
  if (typecheck < 0 || bundle < typecheck)
    findings.push('the CLI bundle does not follow typecheck');
  if (bundle < 0 || vitest < bundle) findings.push('Vitest does not follow the CLI bundle');
  return findings;
}

/** The final gate reuses hosted-verify's typecheck result, so it emits the project references itself before the release gate builds. */
function gateEmitFindings(steps: Step[]): string[] {
  const emit = steps.findIndex((step) => step.run?.split('\n').includes('pnpm typecheck'));
  const gate = steps.findIndex((step) => step.run?.split('\n').includes('pnpm run release:gate'));
  const findings: string[] = [];
  if (gate < 0) findings.push('the job does not run the release gate');
  if (emit < 0 || (gate >= 0 && emit > gate))
    findings.push('the project references are not emitted before the release gate');
  return findings;
}

/** Every rule the v3 workflow must keep. Returns the violations; an empty list means the workflow is clean. */
function v3Violations(source: string): string[] {
  const workflow = yaml.load(source) as Workflow;
  const violations: string[] = [];
  const triggers = Object.keys(workflow.on);
  if (triggers.join(',') !== 'workflow_dispatch')
    violations.push(`triggers must be workflow_dispatch only: ${triggers.join(',')}`);
  for (const forbidden of FORBIDDEN_TRIGGERS)
    if (triggers.includes(forbidden)) violations.push(`forbidden trigger ${forbidden}`);
  if (
    JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read', actions: 'read' })
  ) {
    violations.push('permissions must be contents: read and actions: read, as in v2');
  }
  if (!String(workflow.concurrency?.group ?? '').startsWith('release-candidate-v3-'))
    violations.push('concurrency group must be release-candidate-v3-*');
  if (workflow.concurrency?.['cancel-in-progress'] !== false)
    violations.push('concurrency must not cancel an in-progress gate');

  for (const { job, step } of stepsOf(workflow)) {
    if (
      step.uses?.startsWith('actions/checkout@') &&
      step.with?.ref !== '${{ env.CANDIDATE_SHA }}'
    ) {
      violations.push(`${job}: checkout must pin the exact candidate SHA`);
    }
    if (step.run !== undefined) {
      for (const line of step.run.split('\n')) {
        if (/vitest(?:\.mjs)? run\b/u.test(line) && !line.includes('--retry=0'))
          violations.push(`${job}: vitest run without --retry=0`);
        if (/playwright test\b/u.test(line) && !line.includes('--retries=0'))
          violations.push(`${job}: playwright test without --retries=0`);
      }
      if (PUBLISHING.test(step.run))
        violations.push(`${job}: a step names a publishing or deployment command`);
    }
    if (PUBLISHING.test(JSON.stringify(step.with ?? {})))
      violations.push(`${job}: a step input names a publishing action`);
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (JSON.stringify(job.strategy ?? {}).includes('"pass"'))
      violations.push(`${name}: a pass matrix remains`);
    if (PUBLISHING.test(JSON.stringify(job.env ?? {})))
      violations.push(`${name}: env names a publishing action`);
  }
  if (
    /matrix\.pass|two-pass|both isolated|two exact passes/u.test(source.replace(/^#.*$/gmu, ''))
  ) {
    violations.push('the workflow still refers to two passes');
  }
  const attemptGuard = (workflow.jobs['validate-candidate']?.steps ?? []).some(
    (step) => step.run?.includes('test "$GITHUB_RUN_ATTEMPT" = \'1\'') === true,
  );
  if (!attemptGuard) violations.push('validate-candidate must refuse any attempt other than 1');

  // The Vitest suite runs in three shards, each of them a real shard of 3.
  if (
    JSON.stringify(workflow.jobs['hosted-verify-shard']?.strategy) !==
    JSON.stringify(SHARD_STRATEGY)
  )
    violations.push('hosted-verify-shard must run shards 1, 2 and 3 of 3, and no other set');
  if (
    !(workflow.jobs['hosted-verify-shard']?.steps ?? []).some(
      (step) => step.run?.includes('--shard=${{ matrix.shard }}/3') === true,
    )
  )
    violations.push('hosted-verify-shard must run its own Vitest shard of 3');
  if (
    (workflow.jobs['linux-real-services']?.steps ?? []).some(
      (step) => step.run?.includes('verify:ci') === true,
    )
  )
    violations.push('linux-real-services must not run verify:ci; hosted-verify runs it once');

  // The acceptance runner's order, the Windows lane's runner, and the gate's lanes.
  if (needsOf(workflow.jobs['fixture-acceptance']).includes('windows-candidate'))
    violations.push('fixture-acceptance must not depend on the Windows lane');
  if (
    JSON.stringify(workflow.jobs['windows-candidate']?.['runs-on']) !==
    JSON.stringify(v2.jobs['windows-worker-clean']?.['runs-on'])
  )
    violations.push('windows-candidate must run on the Windows runner v2 uses');
  if (
    JSON.stringify(workflow.jobs['fixture-acceptance']?.['runs-on']) !==
    JSON.stringify(v2.jobs['acceptance-primary']?.['runs-on'])
  )
    violations.push('fixture-acceptance must run on the acceptance runner v2 uses');
  if (
    JSON.stringify([...needsOf(workflow.jobs['gate-summary'])].sort()) !==
    JSON.stringify([...SINGLE_PASS_LANES].sort())
  )
    violations.push('the gate must need exactly the eight single-pass lanes');

  const gateSteps = workflow.jobs['gate-summary']?.steps ?? [];
  const restore = gateSteps.find(
    (step) => step.name === 'Restore and bind the single evidence pass',
  );
  const readiness = gateSteps.find(
    (step) => step.name === 'Build source-bound readiness evidence from the single-pass results',
  );
  if (restore?.env?.EVIDENCE_TOPOLOGY !== 'single-pass')
    violations.push('the evidence restore must read the single-pass topology');
  if (readiness?.env?.READINESS_TOPOLOGY !== 'single-pass')
    violations.push('the readiness record must be built as single-pass');
  const release = gateSteps.find((step) => step.name === 'Evaluate source-bound release gate');
  if (release?.env?.JOY_RELEASE_SCOPE !== 'release')
    violations.push('the final gate must evaluate the release scope, not a per-pass scope');
  if (release?.env?.JOY_RELEASE_HOSTED_VERIFY_REPORT === undefined)
    violations.push('the final gate must read the hosted-verify report');
  if (release?.env?.JOY_RELEASE_HOSTED_VERIFY_SHA256 === undefined)
    violations.push('the final gate must check the hosted-verify report digest');
  const hostedDownload = gateSteps.find(
    (step) => step.name === 'Download the hosted-verify report that this run uploaded',
  );
  if (
    !String(hostedDownload?.with?.name ?? '').includes(
      '${{ github.run_id }}-${{ github.run_attempt }}',
    )
  )
    violations.push('the hosted-verify report must be downloaded from this run only');
  // The collection runs in the shards' database environment, so the list and the execution agree on database-gated suites.
  const shardDb = workflow.jobs['hosted-verify-shard']?.env?.JOY_TEST_DATABASE_URL;
  const prepareDb = workflow.jobs['hosted-prepare']?.env?.JOY_TEST_DATABASE_URL;
  if (shardDb === undefined || prepareDb !== shardDb)
    violations.push(
      'hosted-prepare must collect the list in the same database environment as the shards',
    );
  if (
    (workflow.jobs['hosted-verify']?.steps ?? []).some(
      (step) =>
        step.run?.includes('install --frozen-lockfile') === true ||
        step.run?.startsWith('pnpm') === true,
    )
  )
    violations.push('hosted-verify must merge only; it installs no dependencies');
  const rsJob = workflow.jobs['real-service-acceptance'];
  if (
    JSON.stringify(needsOf(rsJob)) !== JSON.stringify(['validate-candidate']) ||
    rsJob?.env?.JOY_MEDIA_CI_WINDOWS_EVIDENCE !== 'deferred'
  )
    violations.push(
      'real-service-acceptance must not wait for the Windows lane; its Windows check is deferred to the gate',
    );
  for (const name of ['fixture-acceptance', 'p3-real-services']) {
    const condition = String(workflow.jobs[name]?.if ?? '');
    if (
      !condition.includes('always()') ||
      !condition.includes("needs.validate-candidate.result == 'success'")
    )
      violations.push(name + ' must run after upstream failures, so one run reports every failure');
  }
  if (
    JSON.stringify(needsOf(workflow.jobs['acceptance-responsive'])) !==
    JSON.stringify(['validate-candidate'])
  )
    violations.push('acceptance-responsive must depend only on validation');
  const janitorStep = (workflow.jobs['p3-real-services']?.steps ?? []).find((step) =>
    String(step.name ?? '').startsWith('CI namespace janitor'),
  );
  if (janitorStep?.env?.GITHUB_TOKEN === undefined)
    violations.push('p3-real-services janitor must receive the GitHub token');
  const teardownRuns = (workflow.jobs['windows-candidate']?.steps ?? [])
    .map((step) => step.run ?? '')
    .join('\n');
  if (teardownRuns.includes('joy-worker.exe\'" -ErrorAction SilentlyContinue'))
    violations.push('the Windows teardown must fail closed when process inspection fails');
  const summaryStep = gateSteps.find((step) =>
    step.name?.startsWith('Write the shadow run summary'),
  );
  if (!String(summaryStep?.run ?? '').startsWith('set -euo pipefail'))
    violations.push('the shadow run summary must fail when a builder fails');
  for (const job of ['linux-real-services', 'windows-candidate']) {
    const runs = (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? '').join('\n');
    if (!runs.includes('vitest.p0-v3.config.ts') || runs.includes('--config vitest.p0.config.ts'))
      violations.push(
        job +
          ' must run the v3 P0 config (vitest.p0-v3.config.ts), which clears the inherited projects',
      );
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'gate-summary') continue;
    if (job.steps?.some((step) => step.env?.JOY_RELEASE_SCOPE === 'pass') === true)
      violations.push(`${name}: a per-pass release gate remains`);
  }
  return violations;
}

const V2 = readFileSync(V2_PATH, 'utf8');
const V3 = readFileSync(V3_PATH, 'utf8');
const v3 = yaml.load(V3) as Workflow;
const v2 = yaml.load(V2) as Workflow;

/** A mutated copy must differ from the file, so a control that matched nothing cannot pass for a refusal. */
function mutate(from: string, to: string): string {
  const mutated = V3.replace(from, to);
  expect(mutated, `the mutation target was not found: ${from.slice(0, 60)}`).not.toBe(V3);
  return mutated;
}

describe('release-candidate-v3 policy (single-pass, development branch)', () => {
  it('holds every rule for the file as written', () => {
    expect(v3Violations(V3)).toEqual([]);
  });

  it('keeps the production gate, v2, byte-identical to the pinned checksum', () => {
    expect(createHash('sha256').update(V2).digest('hex')).toBe(V2_SHA256);
    expect(v2.name).toBe('release-candidate-v2');
    expect(v2.on).toEqual(v3.on);
  });

  it('is named and keyed separately from the production gate', () => {
    expect(v3.name).toBe('release-candidate-v3');
  });

  it('gives the final gate exactly the eight single-pass lanes, each once, and each lane has a job', () => {
    expect(SINGLE_PASS_LANES).toHaveLength(8);
    expect([...needsOf(v3.jobs['gate-summary'])].sort()).toEqual([...SINGLE_PASS_LANES].sort());
    for (const lane of SINGLE_PASS_LANES) expect(v3.jobs[lane], lane).toBeDefined();
  });

  it('accounts for every v2 release lane: kept under its name, or merged into a v3 lane', () => {
    for (const [merged, replaced] of Object.entries(MERGED_FROM_V2)) {
      expect(v3.jobs[merged], merged).toBeDefined();
      for (const name of replaced) expect(v2.jobs[name], `v2 job ${name}`).toBeDefined();
    }
    const kept = [
      'node-contracts',
      'linux-real-services',
      'real-service-acceptance',
      'acceptance-responsive',
      'p3-real-services',
    ];
    for (const name of kept) expect(v3.jobs[name], name).toBeDefined();
    const covered = new Set([...Object.values(MERGED_FROM_V2).flat(), ...kept]);
    for (const lane of SHAPES['two-pass'].lanes) {
      expect(covered.has(lane), `v2 lane ${lane} is neither kept nor merged`).toBe(true);
    }
  });

  it('runs the Vitest suite in three parallel shards on hosted Ubuntu, each with retries off', () => {
    const shard = v3.jobs['hosted-verify-shard'];
    expect(shard['runs-on']).toBe('ubuntu-24.04');
    expect(shard.strategy).toEqual(SHARD_STRATEGY);
    const runLines = (shard.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .filter((line) => /vitest(?:\.mjs)? run\b/u.test(line));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain('--retry=0');
    expect(runLines[0]).toContain('--shard=${{ matrix.shard }}/3');
  });

  it('merges the three shards in one job that checks their coverage against the collection', () => {
    expect(needsOf(v3.jobs['hosted-verify'])).toEqual(
      expect.arrayContaining(['validate-candidate', 'hosted-verify-shard', 'hosted-prepare']),
    );
    const steps = v3.jobs['hosted-verify'].steps ?? [];
    const merge = steps.find((step) => step.run?.includes('hosted-verify.mjs merge'));
    expect(merge?.run).toContain('--list test-output/hosted-verify/prep/list.json');
    const prepare = v3.jobs['hosted-prepare'].steps ?? [];
    expect(prepare.some((step) => step.run?.includes('vitest/vitest.mjs list --json'))).toBe(true);
  });

  it.each(['hosted-prepare', 'hosted-verify-shard'])(
    '%s builds the CLI fonts before Vitest can collect a build-gated test',
    (job) => {
      expect(bundleOrderFindings(v3.jobs[job].steps ?? [])).toEqual([]);
    },
  );

  it('positive control: a job that collects before the CLI bundle, or without one, is flagged', () => {
    const collectsFirst: Step[] = [
      { run: 'pnpm typecheck' },
      { run: 'node node_modules/vitest/vitest.mjs list --json' },
      { run: 'set -euo pipefail\nnode apps/cli/scripts/bundle.mjs' },
    ];
    expect(bundleOrderFindings(collectsFirst)).toEqual(['Vitest does not follow the CLI bundle']);
    const withoutBundle: Step[] = [
      { run: 'pnpm typecheck' },
      { run: 'node node_modules/vitest/vitest.mjs list --json' },
    ];
    expect(bundleOrderFindings(withoutBundle)).toEqual([
      'the CLI bundle does not follow typecheck',
      'Vitest does not follow the CLI bundle',
    ]);
  });

  it('the final gate emits the project references before it runs the release gate', () => {
    expect(gateEmitFindings(v3.jobs['gate-summary'].steps ?? [])).toEqual([]);
  });

  it('positive control: a final gate that evaluates without the typecheck emit is flagged', () => {
    const defective: Step[] = [
      { run: 'pnpm install --frozen-lockfile' },
      { run: 'set -euo pipefail\npnpm run release:gate' },
    ];
    expect(gateEmitFindings(defective)).toEqual([
      'the project references are not emitted before the release gate',
    ]);
  });

  it('runs the static gates the final gate used to rerun once here, and keeps the production audit', () => {
    const steps = v3.jobs['hosted-prepare'].steps ?? [];
    expect(steps.some((step) => step.run?.includes('hosted-verify.mjs commands'))).toBe(true);
    expect(steps.some((step) => step.run === 'pnpm run audit:prod')).toBe(true);
  });

  it("writes the shadow run summary from this run's own files, as the single-pass topology", () => {
    const steps = v3.jobs['gate-summary'].steps ?? [];
    const summary = steps.find((step) => step.name?.startsWith('Write the shadow run summary'));
    expect(summary?.run).toContain('ci-v3-run-inputs.mjs');
    expect(summary?.run).toContain('--topology single-pass');
    expect(summary?.run).toContain('ci-v3-run-summary.mjs');
    expect(summary?.run).toContain('--hosted test-output/hosted-verify/report.json');
  });

  it('publishes the hosted-verify report digest as its one job output, so the gate can check the file', () => {
    expect(Object.keys(v3.jobs['hosted-verify'].outputs ?? {})).toEqual(['report_sha256']);
  });

  it('chains the acceptance runner in the design order: real-service, fixture, P3, then the gate', () => {
    expect(needsOf(v3.jobs['fixture-acceptance'])).toContain('real-service-acceptance');
    expect(needsOf(v3.jobs['p3-real-services'])).toContain('fixture-acceptance');
    expect(needsOf(v3.jobs['real-service-acceptance'])).not.toContain('fixture-acceptance');
  });

  it('keeps the fixture acceptance job off the Windows lane, so it does not wait for Windows directly', () => {
    expect(needsOf(v3.jobs['fixture-acceptance'])).not.toContain('windows-candidate');
  });

  it('has an acyclic job graph', () => {
    const state: Record<string, number> = {};
    let cyclic = false;
    const visit = (name: string): void => {
      if (state[name] === 1) cyclic = true;
      if (state[name] === 2 || cyclic) return;
      state[name] = 1;
      for (const dependency of needsOf(v3.jobs[name])) visit(dependency);
      state[name] = 2;
    };
    for (const name of Object.keys(v3.jobs)) visit(name);
    expect(cyclic).toBe(false);
  });

  it('reads one pass through its topology, for the readiness record and for the evidence restore', () => {
    const steps = v3.jobs['gate-summary'].steps ?? [];
    const restore = steps.find((step) => step.name === 'Restore and bind the single evidence pass');
    const readiness = steps.find(
      (step) => step.name === 'Build source-bound readiness evidence from the single-pass results',
    );
    expect(restore?.env?.EVIDENCE_TOPOLOGY).toBe('single-pass');
    expect(readiness?.env?.READINESS_TOPOLOGY).toBe('single-pass');
    expect(restore?.env?.WINDOWS_EVIDENCE_1_B64).toBeDefined();
    expect(restore?.env?.WINDOWS_EVIDENCE_2_B64).toBeUndefined();
  });

  it('publishes one Windows evidence output from the merged Windows job, and no second one', () => {
    const outputs = v3.jobs['windows-candidate'] as unknown as { outputs?: Record<string, string> };
    expect(Object.keys(outputs.outputs ?? {})).toEqual(['evidence1']);
  });

  it('runs the Windows P0 lane, the CLI suite and the installed lifecycle in one job, with one build', () => {
    const steps = v3.jobs['windows-candidate'].steps ?? [];
    const runs = steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('vitest.p0-v3.config.ts');
    expect(runs).toContain('run --retry=0 apps/cli/src --no-file-parallelism');
    expect(runs).toContain('tests/desktop/windows-lifecycle.ps1');
    // One checkout and one dependency install in the merged Windows job.
    expect(steps.filter((step) => step.uses?.startsWith('actions/checkout@'))).toHaveLength(1);
    expect(steps.filter((step) => step.run?.includes('install --frozen-lockfile'))).toHaveLength(1);
    // One exact lifecycle pass: the pass matrix is gone and the only pass is pass 1.
    expect(runs).toContain("foreach ($pass in @('1'))");
    expect(runs).not.toContain("'2'");
  });

  it('runs the fixture acceptance suite and the production bundle smoke in one job, with one build', () => {
    const steps = v3.jobs['fixture-acceptance'].steps ?? [];
    expect(steps.filter((step) => step.run === 'pnpm build')).toHaveLength(1);
    expect(steps.filter((step) => step.uses?.startsWith('actions/checkout@'))).toHaveLength(1);
    const runs = steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('r2-p3-shipping-export-acceptance.spec.ts');
    expect(runs).toContain('measure-entry-bundle.mjs');
    expect(runs).toContain('authenticated-smoke.spec.ts');
  });

  it('keeps the merged jobs on the runners v2 used for the lanes they replace', () => {
    expect(v3.jobs['windows-candidate']['runs-on']).toEqual(
      v2.jobs['windows-worker-clean']['runs-on'],
    );
    expect(v3.jobs['windows-candidate']['runs-on']).toEqual(
      v2.jobs['windows-p0-real-services']['runs-on'],
    );
    expect(v3.jobs['fixture-acceptance']['runs-on']).toEqual(
      v2.jobs['acceptance-primary']['runs-on'],
    );
    expect(v3.jobs['hosted-verify']['runs-on']).toEqual(v2.jobs['validate-candidate']['runs-on']);
  });

  it('runs every Vitest and Playwright invocation with retries disabled, and keeps every v2 test command', () => {
    const normalize = (line: string): string =>
      line
        .replace(/\$\{\{ matrix\.pass \}\}/gu, '1')
        .replace(/ --retr(?:y|ies)=0/gu, '')
        // The v2 shadow evidence flags (D18) only write each lane's Vitest report. They do not change which tests run.
        .replace(
          / --reporter=default --reporter=json --outputFile\.json=test-output\/shadow-v2\/[\w.-]+\.json/gu,
          '',
        )
        .replace(/\s+/gu, ' ')
        .trim();
    const testCommands = (workflow: Workflow): Set<string> =>
      new Set(
        stepsOf(workflow).flatMap(({ step }) =>
          (step.run ?? '')
            .split('\n')
            .filter((line) => /vitest(?:\.mjs)? run\b|playwright test\b/u.test(line))
            .map(normalize),
        ),
      );
    const fromV2 = testCommands(v2);
    const fromV3 = testCommands(v3);
    // The shard command is the one new test command: v3 splits the Vitest suite across three shards, and the merge proves the
    // shards cover the collection. Every test command v2 runs must still run in v3.
    for (const command of fromV2) {
      // The P0 lane's config is the one deliberate rename: v3 runs its own P0 config (see the rule above).
      const renamed = command.replace('vitest.p0.config.ts', 'vitest.p0-v3.config.ts');
      expect(fromV3.has(command) || fromV3.has(renamed), command).toBe(true);
    }
    const shardNormalized = normalize(
      'node node_modules/vitest/vitest.mjs run --retry=0 --shard=${{ matrix.shard }}/3 --reporter=default --reporter=json --outputFile.json=test-output/hosted-verify/shard-${{ matrix.shard }}.json',
    );
    expect(fromV3.has(shardNormalized)).toBe(true);
    expect(fromV3.size).toBeGreaterThan(fromV2.size);
  });

  it('does not publish, tag, merge or deploy anywhere in the workflow', () => {
    for (const { job, step } of stepsOf(v3)) {
      expect(PUBLISHING.test(JSON.stringify(step)), job).toBe(false);
    }
  });

  it('keeps the static gates and the audit out of the real-service lane, so they run once', () => {
    const steps = v3.jobs['linux-real-services'].steps ?? [];
    expect(steps.some((step) => step.run?.includes('verify:ci'))).toBe(false);
  });

  it('runs the real-service acceptance once, without a per-pass gate', () => {
    const steps = v3.jobs['real-service-acceptance'].steps ?? [];
    expect(steps.some((step) => step.env?.JOY_RELEASE_SCOPE === 'pass')).toBe(false);
    expect(steps.some((step) => step.run === 'pnpm run release:gate')).toBe(false);
  });

  it('keeps the single-pass lane list that the readiness builder and the gate share', () => {
    expect(SINGLE_PASS_LANES).toEqual([
      'hosted-verify',
      'node-contracts',
      'linux-real-services',
      'windows-candidate',
      'real-service-acceptance',
      'fixture-acceptance',
      'acceptance-responsive',
      'p3-real-services',
    ]);
  });

  it("collects the list in the shards' database environment, so a database-gated suite is listed as it runs", () => {
    expect(v3.jobs['hosted-prepare'].env?.JOY_TEST_DATABASE_URL).toBe(
      v3.jobs['hosted-verify-shard'].env?.JOY_TEST_DATABASE_URL,
    );
    expect(v3.jobs['hosted-prepare'].services?.postgres).toBeDefined();
  });

  it('merges without installing dependencies, so the merge runs on the shards and collection alone', () => {
    const steps = v3.jobs['hosted-verify'].steps ?? [];
    expect(steps.some((step) => step.run?.includes('install --frozen-lockfile'))).toBe(false);
    expect(steps.some((step) => step.run?.startsWith('pnpm'))).toBe(false);
  });

  it('starts real-service acceptance without the Windows lane, with the Windows check deferred to the gate', () => {
    expect(needsOf(v3.jobs['real-service-acceptance'])).toEqual(['validate-candidate']);
    expect(v3.jobs['real-service-acceptance'].env?.JOY_MEDIA_CI_WINDOWS_EVIDENCE).toBe('deferred');
    const names = (v3.jobs['real-service-acceptance'].steps ?? []).map((step) => step.name ?? '');
    expect(names.some((name) => name.startsWith('Bind Windows evidence'))).toBe(false);
  });

  it('keeps fixture acceptance and P3 running after an upstream failure, so one run reports every failure', () => {
    for (const name of ['fixture-acceptance', 'p3-real-services']) {
      expect(String(v3.jobs[name].if), name).toContain('always()');
    }
  });

  it('runs both P0 lanes with the v3 P0 config, and never with the config v2 uses', () => {
    for (const job of ['linux-real-services', 'windows-candidate']) {
      const runs = (v3.jobs[job].steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(runs, job).toContain('vitest.p0-v3.config.ts');
      expect(runs, job).not.toContain('--config vitest.p0.config.ts');
    }
  });

  it('fails the Windows teardown when process inspection fails, and writes the summary with errors enabled', () => {
    const teardown = (v3.jobs['windows-candidate'].steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    expect(teardown).not.toContain('joy-worker.exe\'" -ErrorAction SilentlyContinue');
    const summary = (v3.jobs['gate-summary'].steps ?? []).find((step) =>
      String(step.name).startsWith('Write the shadow run summary'),
    );
    expect(summary?.run?.startsWith('set -euo pipefail')).toBe(true);
  });

  it('keeps the v3 coverage receipts with the final evidence, and verifies their checksums', () => {
    const steps = v3.jobs['gate-summary'].steps ?? [];
    const keep = steps.find((step) =>
      String(step.name).startsWith('Retain the v3 coverage receipts'),
    );
    expect(keep?.run).toContain('v3-receipts/hosted-verify-report.json');
    expect(keep?.run).toContain('sha256sum v3-receipts/*');
    const verify = steps.find(
      (step) => step.name === 'Verify retained final source-bound release evidence',
    );
    expect(verify?.run).toContain('sha256sum -c v3-receipts.sha256');
  });

  describe('negative controls: each mutated copy must be refused', () => {
    const asYaml = (edit: (workflow: Workflow) => void): string => {
      const workflow = yaml.load(V3) as Workflow;
      edit(workflow);
      return (yaml as unknown as { dump(value: unknown): string }).dump(workflow);
    };

    it("refuses a collection that runs without the shards' database environment", () => {
      const mutated = asYaml((workflow) => {
        delete workflow.jobs['hosted-prepare'].env;
      });
      expect(v3Violations(mutated).join(';')).toMatch(/same database environment as the shards/u);
    });

    it('refuses a merge job that installs dependencies again', () => {
      const mutated = asYaml((workflow) => {
        workflow.jobs['hosted-verify'].steps?.push({
          name: 'Install',
          run: 'pnpm install --frozen-lockfile',
        });
      });
      expect(v3Violations(mutated).join(';')).toMatch(/merge only/u);
    });

    it('refuses real-service acceptance that waits for the Windows lane again', () => {
      const mutated = asYaml((workflow) => {
        workflow.jobs['real-service-acceptance'].needs = [
          'validate-candidate',
          'windows-candidate',
        ];
      });
      expect(v3Violations(mutated).join(';')).toMatch(/must not wait for the Windows lane/u);
    });

    it('refuses a real-service lane that checks the Windows file inside the pass', () => {
      const mutated = asYaml((workflow) => {
        delete workflow.jobs['real-service-acceptance'].env?.JOY_MEDIA_CI_WINDOWS_EVIDENCE;
      });
      expect(v3Violations(mutated).join(';')).toMatch(/must not wait for the Windows lane/u);
    });

    it('refuses fixture acceptance that stops after an upstream failure', () => {
      const mutated = asYaml((workflow) => {
        delete workflow.jobs['fixture-acceptance'].if;
      });
      expect(v3Violations(mutated).join(';')).toMatch(/one run reports every failure/u);
    });

    it('refuses an acceptance-responsive job that depends on the Linux or Windows lanes again', () => {
      const mutated = asYaml((workflow) => {
        workflow.jobs['acceptance-responsive'].needs = [
          'validate-candidate',
          'linux-real-services',
        ];
      });
      expect(v3Violations(mutated).join(';')).toMatch(/depend only on validation/u);
    });

    it('refuses a P3 janitor without the token that classifies other runs', () => {
      const mutated = asYaml((workflow) => {
        const janitor = (workflow.jobs['p3-real-services'].steps ?? []).find((step) =>
          String(step.name ?? '').startsWith('CI namespace janitor'),
        );
        if (janitor) delete janitor.env;
      });
      expect(v3Violations(mutated).join(';')).toMatch(/must receive the GitHub token/u);
    });

    it('refuses a Windows teardown that ignores a failed process inspection', () => {
      const mutated = mutate(
        'Get-CimInstance Win32_Process -Filter "Name=\'joy-worker.exe\'" -ErrorAction Stop',
        'Get-CimInstance Win32_Process -Filter "Name=\'joy-worker.exe\'" -ErrorAction SilentlyContinue',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/fail closed when process inspection fails/u);
    });

    it('refuses a shadow summary that does not fail when a builder fails', () => {
      const mutated = mutate(
        'set -euo pipefail\n          mkdir -p test-output/ci-v3',
        'set -uo pipefail\n          mkdir -p test-output/ci-v3',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/must fail when a builder fails/u);
    });

    it("refuses a P0 lane that runs the config v2 uses, which inherits the default suite's projects", () => {
      const mutated = mutate('--config vitest.p0-v3.config.ts', '--config vitest.p0.config.ts');
      expect(v3Violations(mutated).join(';')).toMatch(/must run the v3 P0 config/u);
    });
    it('refuses a pass matrix brought back', () => {
      const mutated = mutate(
        '  p3-real-services:\n',
        '  p3-real-services:\n    strategy:\n      matrix:\n        pass: [1, 2]\n',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/pass matrix remains/u);
    });

    it('refuses a Vitest shard run without --retry=0', () => {
      const mutated = mutate(
        'run --retry=0 --shard=${{ matrix.shard }}/3',
        'run --shard=${{ matrix.shard }}/3',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/vitest run without --retry=0/u);
    });

    it('refuses a Vitest shard run that is not a shard of 3', () => {
      const mutated = mutate(
        'run --retry=0 --shard=${{ matrix.shard }}/3 --reporter=default --reporter=json',
        'run --retry=0 --reporter=json',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/must run its own Vitest shard of 3/u);
    });

    it('refuses a shard matrix that runs only two of the three shards', () => {
      const mutated = mutate('        shard: [1, 2, 3]', '        shard: [1, 2]');
      expect(v3Violations(mutated).join(';')).toMatch(/shards 1, 2 and 3 of 3/u);
    });

    it('refuses a Playwright test without --retries=0', () => {
      const mutated = mutate(
        'pnpm exec playwright test --retries=0 \\\n            tests/e2e/authenticated-smoke.spec.ts',
        'pnpm exec playwright test \\\n            tests/e2e/authenticated-smoke.spec.ts',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/playwright test without --retries=0/u);
    });

    it('refuses a publishing command in a step', () => {
      const mutated = mutate(
        '      - name: Verify final-gate teardown',
        '      - name: Publish\n        run: gh release create v9\n      - name: Verify final-gate teardown',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/publishing or deployment/u);
    });

    it('refuses a push trigger, which would run the gate without a human request', () => {
      const mutated = mutate(
        'on:\n  workflow_dispatch:',
        'on:\n  push:\n    branches: [main]\n  workflow_dispatch:',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/forbidden trigger push/u);
    });

    it('refuses a checkout that does not pin the exact candidate SHA', () => {
      const mutated = mutate(
        '          ref: ${{ env.CANDIDATE_SHA }}\n          fetch-depth: 1\n          persist-credentials: false\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22\n      - name: Validate immutable candidate input',
        '          ref: main\n          fetch-depth: 1\n          persist-credentials: false\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22\n      - name: Validate immutable candidate input',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/pin the exact candidate SHA/u);
    });

    it('refuses the removal of the re-run guard', () => {
      const mutated = mutate('test "$GITHUB_RUN_ATTEMPT" = \'1\' ||', 'true ||');
      expect(v3Violations(mutated).join(';')).toMatch(/refuse any attempt other than 1/u);
    });

    it('refuses a readiness record built without the single-pass topology', () => {
      const mutated = mutate('          READINESS_TOPOLOGY: single-pass\n', '');
      expect(v3Violations(mutated).join(';')).toMatch(
        /readiness record must be built as single-pass/u,
      );
    });

    it('refuses an evidence restore that reads the two-pass folder', () => {
      const mutated = mutate('          EVIDENCE_TOPOLOGY: single-pass\n', '');
      expect(v3Violations(mutated).join(';')).toMatch(
        /evidence restore must read the single-pass topology/u,
      );
    });

    it('refuses a final gate that does not read the hosted-verify report', () => {
      const mutated = mutate(
        '          JOY_RELEASE_HOSTED_VERIFY_REPORT: test-output/hosted-verify/report.json\n',
        '',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/must read the hosted-verify report/u);
    });

    it('refuses a final gate that does not check the hosted-verify report digest', () => {
      const mutated = mutate(
        '          JOY_RELEASE_HOSTED_VERIFY_SHA256: ${{ needs.hosted-verify.outputs.report_sha256 }}\n',
        '',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/check the hosted-verify report digest/u);
    });

    it('refuses a hosted-verify report that is not downloaded from this run', () => {
      const mutated = mutate(
        'name: joy-media-hosted-verify-report-${{ github.run_id }}-${{ github.run_attempt }}-${{ inputs.candidate_sha }}\n          path: test-output/hosted-verify-incoming',
        'name: joy-media-hosted-verify-report-latest\n          path: test-output/hosted-verify-incoming',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/downloaded from this run only/u);
    });

    it('refuses a per-pass release gate brought back into a lane', () => {
      const mutated = mutate(
        '      - name: Retain real-service evidence (durable, redacted, checksum-verified)',
        '      - name: Per-pass gate\n        env:\n          JOY_RELEASE_SCOPE: pass\n        run: pnpm run release:gate\n      - name: Retain real-service evidence (durable, redacted, checksum-verified)',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/per-pass release gate remains/u);
    });

    it('refuses a fixture acceptance job that depends on the Windows lane directly', () => {
      const mutated = mutate(
        '    needs: [validate-candidate, real-service-acceptance]\n    if:',
        '    needs: [validate-candidate, real-service-acceptance, windows-candidate]\n    if:',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/must not depend on the Windows lane/u);
    });

    it('refuses a gate that drops one lane from its needs context', () => {
      const mutated = mutate(
        '        hosted-verify,\n        node-contracts,\n        linux-real-services,\n        windows-candidate,\n        real-service-acceptance,\n        fixture-acceptance,\n        acceptance-responsive,\n        p3-real-services,\n      ]',
        '        node-contracts,\n        linux-real-services,\n        windows-candidate,\n        real-service-acceptance,\n        fixture-acceptance,\n        acceptance-responsive,\n        p3-real-services,\n      ]',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/exactly the eight single-pass lanes/u);
    });

    it('refuses a Windows job moved to a runner v2 does not use for Windows', () => {
      const mutated = mutate(
        '    runs-on: [self-hosted, windows, x64, joy-media-worker-docker]\n    needs: [validate-candidate, editor-web-bundle]',
        '    runs-on: windows-latest\n    needs: [validate-candidate, editor-web-bundle]',
      );
      expect(v3Violations(mutated).join(';')).toMatch(
        /windows-candidate must run on the Windows runner v2 uses/u,
      );
    });

    it('refuses a verify:ci run left in the real-service lane, which would repeat the hosted static gates', () => {
      const mutated = mutate(
        '          pnpm run build\n          # The self-hosted-CI harness',
        '          pnpm run verify:ci\n          # The self-hosted-CI harness',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/must not run verify:ci/u);
    });
  });
});
