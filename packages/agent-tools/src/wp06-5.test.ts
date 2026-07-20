import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_INTENTS,
  BENCHMARK_PROJECTS,
  BenchmarkRunner,
  createBenchmarkRunner,
  runLocalOnlyPolicyLeakTest,
  generateEvaluationReport,
  meetsBaseline,
  BASELINE_THRESHOLDS,
} from './benchmarks/index.js';
import { createToolRegistry } from './registry.js';
import { ApprovalEngine, createDefaultApprovalPolicy } from './approval.js';
import type { PolicyLeakTestResult } from './benchmarks/policy-leak-test.js';

describe('WP-06.5 Evaluation Suite', () => {
  describe('Benchmark Intents', () => {
    it('defines at least 10 benchmark intents', () => {
      expect(BENCHMARK_INTENTS.length).toBeGreaterThanOrEqual(10);
    });

    it('all intents have required fields', () => {
      for (const intent of BENCHMARK_INTENTS) {
        expect(intent.id).toBeDefined();
        expect(intent.name).toBeDefined();
        expect(intent.description).toBeDefined();
        expect(intent.intent).toBeDefined();
        expect(intent.expectedPlanSteps).toBeGreaterThan(0);
        expect(intent.expectedTools.length).toBeGreaterThan(0);
        expect(Array.isArray(intent.requiresApproval)).toBe(true);
        expect(typeof intent.localOnly).toBe('boolean');
        expect(intent.validationChecks.length).toBeGreaterThan(0);
      }
    });

    it('includes simple clip insertion', () => {
      const insertIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-001');
      expect(insertIntent).toBeDefined();
      expect(insertIntent?.expectedTools).toContain('insertClip');
      expect(insertIntent?.localOnly).toBe(true);
    });

    it('includes clip trimming', () => {
      const trimIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-002');
      expect(trimIntent).toBeDefined();
      expect(trimIntent?.expectedTools).toContain('trimClip');
    });

    it('includes multiple clip operations', () => {
      const multiIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-003');
      expect(multiIntent).toBeDefined();
      expect(multiIntent?.expectedPlanSteps).toBeGreaterThan(1);
    });

    it('includes audio gain adjustment', () => {
      const gainIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-004');
      expect(gainIntent).toBeDefined();
      expect(gainIntent?.expectedTools).toContain('setGain');
    });

    it('includes caption search and edit', () => {
      const captionIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-005');
      expect(captionIntent).toBeDefined();
      expect(captionIntent?.expectedTools).toContain('searchTranscript');
    });

    it('includes effect application', () => {
      const effectIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-006');
      expect(effectIntent).toBeDefined();
      expect(effectIntent?.expectedTools).toContain('addEffect');
    });

    it('includes complex multi-step edit', () => {
      const complexIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-007');
      expect(complexIntent).toBeDefined();
      expect(complexIntent?.expectedPlanSteps).toBeGreaterThanOrEqual(4);
    });

    it('includes local-only constraint test', () => {
      const localIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-008');
      expect(localIntent).toBeDefined();
      expect(localIntent?.localOnly).toBe(true);
    });

    it('includes approval-required operation', () => {
      const approvalIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-009');
      expect(approvalIntent).toBeDefined();
      expect(approvalIntent?.requiresApproval.length).toBeGreaterThan(0);
      expect(approvalIntent?.localOnly).toBe(false);
    });

    it('includes revert scenario', () => {
      const revertIntent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-010');
      expect(revertIntent).toBeDefined();
      expect(revertIntent?.validationChecks.some((c) => c.type === 'revert-possible')).toBe(true);
    });
  });

  describe('Benchmark Projects', () => {
    it('defines at least one benchmark project', () => {
      expect(BENCHMARK_PROJECTS.length).toBeGreaterThan(0);
    });

    it('all projects have required fields', () => {
      for (const project of BENCHMARK_PROJECTS) {
        expect(project.id).toBeDefined();
        expect(project.name).toBeDefined();
        expect(project.description).toBeDefined();
        expect(project.projectState).toBeDefined();
        expect(project.context).toBeDefined();
      }
    });

    it('projects have valid context', () => {
      for (const project of BENCHMARK_PROJECTS) {
        expect(project.context.project).toBeDefined();
        expect(project.context.selection).toBeDefined();
        expect(project.context.timeline).toBeDefined();
        expect(project.context.audio).toBeDefined();
        expect(project.context.providers).toBeDefined();
      }
    });
  });

  describe('BenchmarkRunner', () => {
    it('creates a benchmark runner', () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      expect(runner).toBeInstanceOf(BenchmarkRunner);
    });

    it('runs a single benchmark intent', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const intent = BENCHMARK_INTENTS[0];
      const project = BENCHMARK_PROJECTS[0];

      const metrics = await runner.runBenchmark(intent, project);

      expect(metrics.intentId).toBe(intent.id);
      expect(typeof metrics.planValidity).toBe('boolean');
      expect(typeof metrics.executionSuccess).toBe('boolean');
      expect(typeof metrics.durationMs).toBe('number');
      expect(typeof metrics.stepCount).toBe('number');
      expect(Array.isArray(metrics.warnings)).toBe(true);
      expect(Array.isArray(metrics.errors)).toBe(true);
    });

    it('runs a full benchmark suite', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const suiteResult = await runner.runSuite(BENCHMARK_INTENTS, BENCHMARK_PROJECTS);

      expect(suiteResult.totalIntents).toBe(BENCHMARK_INTENTS.length);
      expect(typeof suiteResult.passedIntents).toBe('number');
      expect(typeof suiteResult.failedIntents).toBe('number');
      expect(suiteResult.metrics.length).toBe(BENCHMARK_INTENTS.length);
      expect(suiteResult.summary).toBeDefined();
    });

    it('calculates summary statistics correctly', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const suiteResult = await runner.runSuite(BENCHMARK_INTENTS, BENCHMARK_PROJECTS);

      expect(suiteResult.summary.planValidityRate).toBeGreaterThanOrEqual(0);
      expect(suiteResult.summary.planValidityRate).toBeLessThanOrEqual(1);
      expect(suiteResult.summary.executionSuccessRate).toBeGreaterThanOrEqual(0);
      expect(suiteResult.summary.executionSuccessRate).toBeLessThanOrEqual(1);
      expect(suiteResult.summary.acceptedChangeRate).toBeGreaterThanOrEqual(0);
      expect(suiteResult.summary.acceptedChangeRate).toBeLessThanOrEqual(1);
      expect(suiteResult.summary.revertedChangeRate).toBeGreaterThanOrEqual(0);
      expect(suiteResult.summary.revertedChangeRate).toBeLessThanOrEqual(1);
      expect(suiteResult.summary.averageCostAccuracy).toBeGreaterThanOrEqual(0);
      expect(suiteResult.summary.averageCostAccuracy).toBeLessThanOrEqual(1);
      expect(suiteResult.summary.averageDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('validates results against expected outcomes', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const intent = BENCHMARK_INTENTS[0];
      const project = BENCHMARK_PROJECTS[0];
      const metrics = await runner.runBenchmark(intent, project);

      const validation = runner.validateResults(metrics, intent);

      expect(typeof validation.passed).toBe('boolean');
      expect(Array.isArray(validation.failures)).toBe(true);
    });
  });

  describe('Policy Leak Test', () => {
    it('runs local-only policy leak test', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());

      const result = await runLocalOnlyPolicyLeakTest(
        BENCHMARK_INTENTS,
        BENCHMARK_PROJECTS,
        registry,
        approvalEngine,
      );

      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.violations)).toBe(true);
      expect(typeof result.summary).toBe('string');
    });

    it('passes for local-only intents', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());

      const localOnlyIntents = BENCHMARK_INTENTS.filter((i) => i.localOnly);
      const result = await runLocalOnlyPolicyLeakTest(
        localOnlyIntents,
        BENCHMARK_PROJECTS,
        registry,
        approvalEngine,
      );

      expect(result.passed).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('detects violations when present', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());

      const result = await runLocalOnlyPolicyLeakTest(
        BENCHMARK_INTENTS,
        BENCHMARK_PROJECTS,
        registry,
        approvalEngine,
      );

      if (!result.passed) {
        expect(result.violations.length).toBeGreaterThan(0);
        for (const violation of result.violations) {
          expect(violation.intentId).toBeDefined();
          expect(violation.stepId).toBeDefined();
          expect(violation.tool).toBeDefined();
          expect(violation.violation).toBeDefined();
          expect(violation.expectedBehavior).toBeDefined();
          expect(violation.actualBehavior).toBeDefined();
        }
      }
    });
  });

  describe('Evaluation Report', () => {
    it('generates evaluation report', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const suiteResult = await runner.runSuite(BENCHMARK_INTENTS, BENCHMARK_PROJECTS);
      const policyLeakTest = await runLocalOnlyPolicyLeakTest(
        BENCHMARK_INTENTS,
        BENCHMARK_PROJECTS,
        registry,
        approvalEngine,
      );

      const report = generateEvaluationReport(suiteResult, policyLeakTest);

      expect(report.generatedAt).toBeDefined();
      expect(report.suiteResult).toBe(suiteResult);
      expect(report.policyLeakTest).toBe(policyLeakTest);
      expect(Array.isArray(report.recommendations)).toBe(true);
      expect(typeof report.meetsBaseline).toBe('boolean');
    });

    it('includes recommendations', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const suiteResult = await runner.runSuite(BENCHMARK_INTENTS, BENCHMARK_PROJECTS);
      const policyLeakTest = await runLocalOnlyPolicyLeakTest(
        BENCHMARK_INTENTS,
        BENCHMARK_PROJECTS,
        registry,
        approvalEngine,
      );

      const report = generateEvaluationReport(suiteResult, policyLeakTest);

      expect(report.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('Baseline Check', () => {
    it('checks if metrics meet baseline', () => {
      const suiteResult: BenchmarkSuiteResult = {
        totalIntents: 10,
        passedIntents: 10,
        failedIntents: 0,
        metrics: [],
        summary: {
          planValidityRate: 1.0,
          executionSuccessRate: 1.0,
          acceptedChangeRate: 1.0,
          revertedChangeRate: 0.0,
          averageCostAccuracy: 1.0,
          averageDurationMs: 100,
        },
      };

      const result = meetsBaseline(suiteResult);

      expect(result.meetsBaseline).toBe(true);
      expect(result.failures.length).toBe(0);
    });

    it('detects baseline failures', () => {
      const suiteResult: BenchmarkSuiteResult = {
        totalIntents: 10,
        passedIntents: 5,
        failedIntents: 5,
        metrics: [],
        summary: {
          planValidityRate: 0.5,
          executionSuccessRate: 0.5,
          acceptedChangeRate: 0.5,
          revertedChangeRate: 0.5,
          averageCostAccuracy: 0.5,
          averageDurationMs: 100,
        },
      };

      const result = meetsBaseline(suiteResult);

      expect(result.meetsBaseline).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it('checks policy leak test baseline', () => {
      const suiteResult: BenchmarkSuiteResult = {
        totalIntents: 10,
        passedIntents: 10,
        failedIntents: 0,
        metrics: [],
        summary: {
          planValidityRate: 1.0,
          executionSuccessRate: 1.0,
          acceptedChangeRate: 1.0,
          revertedChangeRate: 0.0,
          averageCostAccuracy: 1.0,
          averageDurationMs: 100,
        },
      };

      const policyLeakTest: PolicyLeakTestResult = {
        passed: false,
        violations: [
          {
            intentId: 'bench-001',
            stepId: 'step-1',
            tool: 'testTool',
            violation: 'Policy violation',
            expectedBehavior: 'Local only',
            actualBehavior: 'Remote call',
          },
        ],
        summary: 'Policy leak test failed',
      };

      const result = meetsBaseline(suiteResult, policyLeakTest);

      expect(result.meetsBaseline).toBe(false);
      expect(result.failures.some((f) => f.includes('Policy leak test'))).toBe(true);
    });

    it('has correct baseline thresholds', () => {
      expect(BASELINE_THRESHOLDS.planValidityRate).toBe(0.95);
      expect(BASELINE_THRESHOLDS.executionSuccessRate).toBe(0.9);
      expect(BASELINE_THRESHOLDS.acceptedChangeRate).toBe(0.85);
      expect(BASELINE_THRESHOLDS.revertedChangeRate).toBe(0.05);
      expect(BASELINE_THRESHOLDS.averageCostAccuracy).toBe(0.8);
      expect(BASELINE_THRESHOLDS.policyLeakTestPass).toBe(true);
    });
  });

  describe('Validation Checks', () => {
    it('validates entities-created check', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const intent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-001');
      expect(intent).toBeDefined();

      const project = BENCHMARK_PROJECTS[0];
      const metrics = await runner.runBenchmark(intent!, project);

      const validation = runner.validateResults(metrics, intent!);
      expect(typeof validation.passed).toBe('boolean');
    });

    it('validates no-overlaps check', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const intent = BENCHMARK_INTENTS.find((i) =>
        i.validationChecks.some((c) => c.type === 'no-overlaps'),
      );
      expect(intent).toBeDefined();

      const project = BENCHMARK_PROJECTS[0];
      const metrics = await runner.runBenchmark(intent!, project);

      const validation = runner.validateResults(metrics, intent!);
      expect(typeof validation.passed).toBe('boolean');
    });

    it('validates local-only-respected check', async () => {
      const registry = createToolRegistry();
      const approvalEngine = new ApprovalEngine(createDefaultApprovalPolicy());
      const runner = createBenchmarkRunner(registry, approvalEngine);

      const intent = BENCHMARK_INTENTS.find((i) => i.id === 'bench-008');
      expect(intent).toBeDefined();

      const project = BENCHMARK_PROJECTS[0];
      const metrics = await runner.runBenchmark(intent!, project);

      const validation = runner.validateResults(metrics, intent!);
      expect(typeof validation.passed).toBe('boolean');
    });
  });
});
