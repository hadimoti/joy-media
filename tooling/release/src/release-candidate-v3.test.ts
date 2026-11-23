import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHAPES } from './create-readiness-evidence.mjs';
import { SINGLE_PASS_LANES } from './ci-v3-run-summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = join(resolve(HERE, '../../..'), '.github', 'workflows');
const V3_PATH = join(WORKFLOWS, 'release-candidate-v3.yml');
const yaml = createRequire(join(resolve(HERE, '../../..'), 'package.json'))('js-yaml') as {
  load(source: string): unknown;
};

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  'runs-on'?: unknown;
  strategy?: unknown;
  services?: Record<string, unknown>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  if?: string;
  steps?: Step[];
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const V3 = readFileSync(V3_PATH, 'utf8');
const v3 = yaml.load(V3) as Workflow;
const RETIRED_LANES = ['linux-real-services', 'real-service-acceptance', 'p3-real-services'];
// The gate-summary needs list is the single lane list. Both readiness modules take their copy from SINGLE_PASS_LANES.
const FINAL_NEEDS = [...SINGLE_PASS_LANES];

function needsOf(job: Job | undefined): string[] {
  return ([] as string[]).concat(job?.needs ?? []);
}

function stepsOf(workflow: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(workflow.jobs).flatMap(([job, value]) =>
    (value.steps ?? []).map((step) => ({ job, step })),
  );
}

describe('release-candidate-v3 workflow', () => {
  it('keeps the manual, read-only, non-cancelling workflow boundary', () => {
    expect(v3.name).toBe('release-candidate-v3');
    expect(Object.keys(v3.on)).toEqual(['workflow_dispatch']);
    expect(v3.permissions).toEqual({ contents: 'read' });
    expect(v3.concurrency.group).toBe('release-candidate-v3-${{ inputs.candidate_sha }}');
    expect(v3.concurrency['cancel-in-progress']).toBe(false);
  });

  it('removes the retired service lanes and pins the final summary to every active job', () => {
    for (const lane of RETIRED_LANES) {
      expect(v3.jobs[lane]).toBeUndefined();
      expect(V3).not.toContain(`${lane},`);
    }
    expect(SINGLE_PASS_LANES).toEqual([
      'validate-candidate',
      'hosted-verify',
      'node-contracts',
      'editor-web-bundle',
      'windows-candidate',
      'checksums',
      'offline-packaged-smoke',
      'fixture-acceptance',
      'acceptance-responsive',
      'site-build',
    ]);
    expect(needsOf(v3.jobs['gate-summary']).sort()).toEqual([...FINAL_NEEDS].sort());
    for (const lane of FINAL_NEEDS) expect(v3.jobs[lane], lane).toBeDefined();
    expect(v3.jobs['gate-summary'].steps?.map((step) => step.run ?? '').join('\n')).toContain(
      "'validate-candidate,hosted-verify,node-contracts,editor-web-bundle,windows-candidate,checksums,offline-packaged-smoke,fixture-acceptance,acceptance-responsive,site-build'",
    );
  });

  it('keeps the readiness modules lane lists equal to the gate-summary needs, in the workflow order', () => {
    // The workflow's needs list is written in this order; the two readiness modules must name the same lanes in it.
    const workflowOrder = [
      'validate-candidate',
      'hosted-verify',
      'node-contracts',
      'editor-web-bundle',
      'windows-candidate',
      'checksums',
      'offline-packaged-smoke',
      'fixture-acceptance',
      'acceptance-responsive',
      'site-build',
    ];
    expect(needsOf(v3.jobs['gate-summary'])).toEqual(workflowOrder);
    expect(SINGLE_PASS_LANES).toEqual(workflowOrder);
    expect(SHAPES['single-pass'].lanes).toEqual(workflowOrder);
  });

  it('uses only repository-approved self-hosted Linux labels', () => {
    for (const [name, job] of Object.entries(v3.jobs)) {
      expect(job['runs-on'], name).toEqual(
        name === 'fixture-acceptance'
          ? ['self-hosted', 'linux', 'x64', 'joy-media-acceptance']
          : ['self-hosted', 'linux', 'x64', 'joy-media-ci'],
      );
    }
  });

  it('runs on the non-root Linux runner with preinstalled system tools', () => {
    for (const [name, job] of Object.entries(v3.jobs)) {
      expect.soft(job.services, name).toBeUndefined();
    }
    const commands = stepsOf(v3)
      .map(({ step }) => step.run ?? '')
      .join('\n');
    expect.soft(commands).not.toMatch(/--with-deps|\bsudo\b|\bapt-get\b/u);
    const nodeContracts = (v3.jobs['node-contracts'].steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    expect(nodeContracts).toContain(
      'pnpm exec vitest run --retry=0 apps/cli/src --no-file-parallelism',
    );
    expect(nodeContracts).not.toContain('usdc-invoice-ledger.pg.test.ts');
  });

  it('checks out the source candidate for build/test jobs and receipt commit for receipt jobs', () => {
    const receiptJobs = new Set(['checksums', 'windows-candidate', 'offline-packaged-smoke']);
    for (const { job, step } of stepsOf(v3)) {
      if (!step.uses?.startsWith('actions/checkout@')) continue;
      expect(step.with?.ref, job).toBe(
        receiptJobs.has(job) ? '${{ github.sha }}' : '${{ env.CANDIDATE_SHA }}',
      );
    }
    for (const job of receiptJobs) {
      const checkout = v3.jobs[job].steps?.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with?.['fetch-depth'], job).toBe(job === 'checksums' ? 1 : 0);
    }
  });

  it('keeps the exact candidate and first-attempt guard in the validation job', () => {
    const steps = v3.jobs['validate-candidate'].steps ?? [];
    const run = steps.map((step) => step.run ?? '').join('\n');
    expect(run).toContain('^[0-9a-f]{40}$');
    expect(run).toContain('resolved_sha="$(git rev-parse HEAD)"');
    expect(run).toContain('"$resolved_sha" == "$CANDIDATE_SHA"');
    expect(run).toContain('test "$GITHUB_RUN_ATTEMPT" = \'1\'');
  });

  it('runs the three Vitest shards and verifies exact coverage against the collected list', () => {
    const shard = v3.jobs['hosted-verify-shard'];
    expect(shard.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3] } });
    const shardSteps = shard.steps ?? [];
    const shardTypecheck = shardSteps.findIndex((step) => step.run === 'pnpm typecheck');
    const shardTests = shardSteps.findIndex((step) =>
      step.run?.includes('--retry=0 --shard=${{ matrix.shard }}/3'),
    );
    expect(shardTypecheck).toBeGreaterThanOrEqual(0);
    expect(shardTypecheck).toBeLessThan(shardTests);
    const prepare = v3.jobs['hosted-prepare'];
    expect(prepare.env).toEqual(shard.env);
    const prepareSteps = prepare.steps ?? [];
    const collect = prepareSteps.findIndex((step) => step.run?.includes('vitest.mjs list --json'));
    const staticChecks = prepareSteps.findIndex((step) =>
      step.run?.includes('hosted-verify.mjs commands'),
    );
    expect(staticChecks).toBeGreaterThanOrEqual(0);
    expect(staticChecks).toBeLessThan(collect);
    expect(prepareSteps.some((step) => step.run === 'pnpm run audit:prod')).toBe(true);
    const verify = v3.jobs['hosted-verify'];
    expect(needsOf(verify)).toEqual(
      expect.arrayContaining(['validate-candidate', 'hosted-verify-shard', 'hosted-prepare']),
    );
    expect((verify.steps ?? []).some((step) => step.run?.includes('hosted-verify.mjs merge'))).toBe(
      true,
    );
    expect(verify.outputs).toEqual({ report_sha256: '${{ steps.report.outputs.report_sha256 }}' });
    const upload = verify.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toContain('${{ github.run_id }}-${{ github.run_attempt }}');
    expect(upload?.with?.name).toContain('${{ inputs.candidate_sha }}');
  });

  it('runs the real local-only release gate on the candidate, without launching the app', () => {
    const job = v3.jobs['windows-candidate'];
    expect(needsOf(job)).toEqual(['validate-candidate', 'checksums']);
    const steps = job.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with?.ref).toBe('${{ github.sha }}');
    const gateStep = steps.find((step) => step.run?.includes('pnpm release:gate:local'));
    expect(gateStep?.name).toBe(
      'Run the local release gate on the candidate (this step fails when the gate exits non-zero)',
    );
    expect(gateStep?.run).toContain('set -euo pipefail');
    expect(gateStep?.run).toContain('pnpm release:gate:local --candidate="$CANDIDATE_SHA"');
    // The candidate reaches the script only through the quoted shell variable, never as ${{ inputs.* }} in the script text.
    expect(gateStep?.env?.CANDIDATE_SHA).toBe('${{ inputs.candidate_sha }}');
    expect(gateStep?.run).not.toContain('${{');
    expect(steps.some((step) => step.run?.includes('pnpm install --frozen-lockfile'))).toBe(true);
    const install = steps.findIndex((step) => step.run?.includes('pnpm install --frozen-lockfile'));
    expect(install).toBeLessThan(steps.indexOf(gateStep as Step));
    const report = steps.find((step) => step.run?.includes('test-output/release-gate/report.json'));
    expect(report?.if).toBe('always()');
    // The report step prints each check's status in upper case, so a waived lifecycle shows as WAIVED.
    expect(report?.run).toContain('check.status.toUpperCase()');
    const run = steps.map((step) => step.run ?? '').join('\n');
    expect(run).not.toMatch(/Start-Process|electron\s/u);
    expect(run).not.toContain('testSummary: { collected: 1');
    expect(run).not.toContain("profile: 'local-only'");
  });

  it('verifies the evidence file list and binds the checksums to the committed receipt', () => {
    const job = v3.jobs.checksums;
    const run = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('candidate_files_dir="$evidence_root/$CANDIDATE_SHA/candidate-files"');
    expect(run).toContain('tooling/release/src/checksums.ts verify --dir');
    expect(run).toContain('docs/release/attended/$CANDIDATE_SHA/SHA256SUMS.txt');
    expect(run).toContain('cmp "$candidate_files_dir/SHA256SUMS.txt"');
    // The runner's duty is stated in the workflow, and the job fails closed without it.
    expect(V3).toContain('$JOY_MEDIA_CI_EVIDENCE_ROOT/<candidate sha>/candidate-files');
    expect(V3).toContain('fails closed when that folder is missing');
    expect(run).toContain('candidate files are missing from the evidence store');
    const windowsSteps = v3.jobs['windows-candidate'].steps ?? [];
    const stage = windowsSteps.findIndex((step) => step.run?.includes('cp -a'));
    const gate = windowsSteps.findIndex((step) => step.run?.includes('pnpm release:gate:local'));
    expect(stage).toBeGreaterThanOrEqual(0);
    expect(stage).toBeLessThan(gate);
    expect(windowsSteps[stage]?.run).toContain('cp -a "$candidate_files_dir/." "$release_dir/"');
    expect(windowsSteps[stage]?.run).toContain('checksums.ts verify --dir "$release_dir"');
    expect(windowsSteps[stage]?.run).toContain(
      'cmp "$release_dir/SHA256SUMS.txt" "$committed_sums"',
    );
    expect(job.steps?.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(
      false,
    );
  });

  it('runs the existing offline-smoke receipt validator on the committed receipt', () => {
    const job = v3.jobs['offline-packaged-smoke'];
    expect(needsOf(job)).toEqual(['validate-candidate', 'checksums']);
    const run = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('tooling/release/src/check-offline-smoke.ts');
    expect(run).toContain('docs/release/attended/$CANDIDATE_SHA/offline-smoke.json');
    expect(run).toContain('docs/release/attended/$CANDIDATE_SHA/SHA256SUMS.txt');
    expect(run).toContain('--artifact joy-media-setup.exe');
    expect(run).toContain('--window-start');
    expect(run).toContain('--window-end');
  });

  it('builds and tests apps/site on the exact candidate', () => {
    const run = (v3.jobs['site-build'].steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('pnpm --filter @joy-media/site build');
    expect(run).toContain('pnpm exec vitest run --retry=0 apps/site');
    expect(run).toContain(
      'pnpm exec playwright test --retries=0 --config playwright.site.config.ts',
    );
  });

  it('runs the CLI humanized render benchmark in fixture acceptance', () => {
    const run = (v3.jobs['fixture-acceptance'].steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    expect(run).toContain('apps/cli/src/humanized/render-benchmark.e2e.test.ts');
    expect(needsOf(v3.jobs['fixture-acceptance'])).toEqual(['validate-candidate']);
    expect(run).toContain('pnpm exec playwright test --retries=0');
    expect(run).toContain('measure-entry-bundle.mjs');
    expect(run).toContain(
      'pnpm --fail-if-no-match --filter @joy-media/test-control-plane exec tsx ../../tooling/e2e-server.ts',
    );
    // The production-bundle smoke names only specs that exist; the deleted authenticated-smoke spec must not come back.
    expect(run).not.toContain('authenticated-smoke.spec.ts');
    expect(run).toContain('tests/e2e/wp32-real-project-journey.spec.ts');
    expect(run).toContain('tests/e2e/golden-path.spec.ts');
    expect(
      v3.jobs['fixture-acceptance'].steps?.some(
        (step) => step.name === 'Verify fixture-acceptance teardown',
      ),
    ).toBe(true);
  });

  it('keeps all six responsive acceptance checkpoints on the exact candidate', () => {
    const run = (v3.jobs['acceptance-responsive'].steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    for (const profile of [
      'desktop-compact',
      'desktop-minimum',
      'desktop-1280',
      'desktop-1440',
      'desktop-1581',
      'desktop-1920',
    ]) {
      expect(run).toContain(profile);
    }
    expect(run).toContain('assert-playwright-titles.mjs');
    const titles = [...run.matchAll(/^\s*'([^']+)'\s*$/gmu)].map((match) => match[1]!);
    const specPaths = [...run.matchAll(/tests\/e2e\/[\w.-]+\.spec\.ts/gu)].map((match) => match[0]);
    const specs = specPaths.map((path) =>
      readFileSync(join(resolve(HERE, '../../..'), path), 'utf8'),
    );
    const selector = /^\s*grep_re='([^']+)'/mu.exec(run)?.[1];
    expect(titles).toHaveLength(3);
    expect(selector).toBeDefined();
    for (const title of titles) {
      expect(
        specs.some((source) => source.includes(`test('${title}'`)),
        title,
      ).toBe(true);
      expect(title).toMatch(new RegExp(selector!, 'u'));
    }
    expect(
      v3.jobs['acceptance-responsive'].steps?.some(
        (step) => step.name === 'Verify acceptance teardown',
      ),
    ).toBe(true);
  });

  it('names only Playwright spec files that exist in the repository', () => {
    const named = [...V3.matchAll(/tests\/e2e\/[\w.-]+\.spec\.ts/gu)].map((match) => match[0]);
    expect(named.length).toBeGreaterThan(0);
    for (const spec of new Set(named)) {
      expect(existsSync(join(resolve(HERE, '../../..'), spec)), spec).toBe(true);
    }
  });

  it('does not include publishing, tagging, deployment or merge commands', () => {
    const runs = stepsOf(v3)
      .map(({ step }) => step.run ?? '')
      .join('\n');
    expect(runs).not.toMatch(/gh release|git push|git tag|\bdeploy\b/iu);
  });

  it('runs test commands without retries and keeps an acyclic job graph', () => {
    for (const { job, step } of stepsOf(v3)) {
      if (step.run === undefined) continue;
      for (const line of step.run.split('\n')) {
        if (/vitest(?:\.mjs)? run\b/u.test(line)) expect(line, job).toContain('--retry=0');
        if (/playwright test\b/u.test(line)) expect(line, job).toContain('--retries=0');
      }
    }
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

  it('contains no old previous-release pin', () => {
    expect(V3).not.toMatch(/v1\.0\.[0-9]+/u);
  });
});
