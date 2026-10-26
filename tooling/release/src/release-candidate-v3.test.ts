// Policy for release-candidate-v3.yml, the single-pass gate on the development branch (decision D17). It pins the
// properties the design (docs/plans/2026-10-26-ci-v3-design.md) requires, and each property has a negative control: a
// mutated copy of the workflow that must be refused. The file is not the production gate, and these tests keep it from
// quietly becoming one.
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

function needsOf(job: Job): string[] {
  return ([] as string[]).concat(job.needs ?? []);
}

function stepsOf(workflow: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(workflow.jobs).flatMap(([job, value]) =>
    (value.steps ?? []).map((step) => ({ job, step })),
  );
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
  return violations;
}

const V2 = readFileSync(V2_PATH, 'utf8');
const V3 = readFileSync(V3_PATH, 'utf8');
const v3 = yaml.load(V3) as Workflow;
const v2 = yaml.load(V2) as Workflow;

describe('release-candidate-v3 policy (single-pass, development branch)', () => {
  it('holds every rule for the file as written', () => {
    expect(v3Violations(V3)).toEqual([]);
  });

  it('is named and keyed separately from the production gate, which stays v2', () => {
    expect(v3.name).toBe('release-candidate-v3');
    expect(v2.name).toBe('release-candidate-v2');
    expect(v2.on).toEqual(v3.on);
  });

  it('runs the nine release lanes, each once, and its gate waits for every one of them', () => {
    const lanes = SHAPES['single-pass'].lanes;
    expect(lanes).toHaveLength(9);
    expect([...needsOf(v3.jobs['gate-summary'] as Job)].sort()).toEqual([...lanes].sort());
    expect([...lanes].sort()).toEqual([...SHAPES['two-pass'].lanes].sort());
    for (const lane of lanes) expect(v3.jobs[lane], lane).toBeDefined();
  });

  it('chains the acceptance runner in the design order: real-service, fixture, P3, then the gate', () => {
    expect(needsOf(v3.jobs['acceptance-primary'] as Job)).toContain('real-service-acceptance');
    expect(needsOf(v3.jobs['prod-build-smoke'] as Job)).toContain('acceptance-primary');
    expect(needsOf(v3.jobs['p3-real-services'] as Job)).toContain('prod-build-smoke');
    expect(needsOf(v3.jobs['real-service-acceptance'] as Job)).not.toContain('acceptance-primary');
  });

  it('has an acyclic job graph', () => {
    const state: Record<string, number> = {};
    let cyclic = false;
    const visit = (name: string): void => {
      if (state[name] === 1) cyclic = true;
      if (state[name] === 2 || cyclic) return;
      state[name] = 1;
      for (const dependency of needsOf(v3.jobs[name] as Job)) visit(dependency);
      state[name] = 2;
    };
    for (const name of Object.keys(v3.jobs)) visit(name);
    expect(cyclic).toBe(false);
  });

  it('reads one pass through its topology, for the readiness record and for the evidence restore', () => {
    const gate = v3.jobs['gate-summary'];
    const steps = gate.steps ?? [];
    const restore = steps.find((step) => step.name === 'Restore and bind the single evidence pass');
    const readiness = steps.find(
      (step) => step.name === 'Build source-bound readiness evidence from the single-pass results',
    );
    expect(restore?.env?.EVIDENCE_TOPOLOGY).toBe('single-pass');
    expect(readiness?.env?.READINESS_TOPOLOGY).toBe('single-pass');
    expect(restore?.env?.WINDOWS_EVIDENCE_1_B64).toBeDefined();
    expect(restore?.env?.WINDOWS_EVIDENCE_2_B64).toBeUndefined();
  });

  it('publishes one Windows evidence output, the single pass, and no second one', () => {
    const outputs = v3.jobs['windows-worker-clean'] as unknown as {
      outputs?: Record<string, string>;
    };
    expect(Object.keys(outputs.outputs ?? {})).toEqual(['evidence1']);
  });

  it('runs every Vitest and Playwright invocation with retries disabled, and keeps the same commands as v2', () => {
    const normalize = (line: string): string =>
      line
        .replace(/\$\{\{ matrix\.pass \}\}/gu, '1')
        .replace(/ --retr(?:y|ies)=0/gu, '')
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
    for (const command of fromV2) expect(fromV3.has(command), command).toBe(true);
    expect(fromV3.size).toBeGreaterThanOrEqual(fromV2.size);
  });

  it('keeps v2 runner placement for every job the v3 file has in common with v2', () => {
    for (const [name, job] of Object.entries(v3.jobs)) {
      const original = v2.jobs[name];
      if (original !== undefined) expect(job['runs-on'], name).toEqual(original['runs-on']);
    }
  });

  it('does not publish, tag, merge or deploy anywhere in the workflow', () => {
    for (const { job, step } of stepsOf(v3)) {
      expect(PUBLISHING.test(JSON.stringify(step)), job).toBe(false);
    }
  });

  describe('negative controls: each mutated copy must be refused', () => {
    it('refuses a pass matrix brought back', () => {
      const mutated = V3.replace(
        '  p3-real-services:\n',
        '  p3-real-services:\n    strategy:\n      matrix:\n        pass: [1, 2]\n',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/pass matrix remains/u);
    });

    it('refuses a vitest run without --retry=0', () => {
      const mutated = V3.replace(
        'pnpm exec vitest run --retry=0 apps/cli/src --no-file-parallelism',
        'pnpm exec vitest run apps/cli/src --no-file-parallelism',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/vitest run without --retry=0/u);
    });

    it('refuses a playwright test without --retries=0', () => {
      const mutated = V3.replace(
        'pnpm exec playwright test --retries=0 \\\n',
        'pnpm exec playwright test \\\n',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/playwright test without --retries=0/u);
    });

    it('refuses a publishing command in a step', () => {
      const mutated = V3.replace(
        '      - name: Verify final-gate teardown',
        '      - name: Publish\n        run: gh release create v9\n      - name: Verify final-gate teardown',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/publishing or deployment/u);
    });

    it('refuses a push trigger, which would run the gate without a human request', () => {
      const mutated = V3.replace(
        'on:\n  workflow_dispatch:',
        'on:\n  push:\n    branches: [main]\n  workflow_dispatch:',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/forbidden trigger push/u);
    });

    it('refuses a checkout that does not pin the exact candidate SHA', () => {
      const mutated = V3.replace(
        '          ref: ${{ env.CANDIDATE_SHA }}\n          fetch-depth: 1\n          persist-credentials: false\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22',
        '          ref: main\n          fetch-depth: 1\n          persist-credentials: false\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22',
      );
      expect(v3Violations(mutated).join(';')).toMatch(/pin the exact candidate SHA/u);
    });

    it('refuses the removal of the re-run guard', () => {
      const mutated = V3.replace('test "$GITHUB_RUN_ATTEMPT" = \'1\' ||', 'true ||');
      expect(v3Violations(mutated).join(';')).toMatch(/refuse any attempt other than 1/u);
    });

    it('refuses a readiness record built without the single-pass topology', () => {
      const mutated = V3.replace('          READINESS_TOPOLOGY: single-pass\n', '');
      expect(v3Violations(mutated).join(';')).toMatch(
        /readiness record must be built as single-pass/u,
      );
    });

    it('refuses an evidence restore that reads the two-pass folder', () => {
      const mutated = V3.replace('          EVIDENCE_TOPOLOGY: single-pass\n', '');
      expect(v3Violations(mutated).join(';')).toMatch(
        /evidence restore must read the single-pass topology/u,
      );
    });
  });
});
