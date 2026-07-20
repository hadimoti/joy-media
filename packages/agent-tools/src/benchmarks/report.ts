import type { BenchmarkSuiteResult } from './metrics.js';
import type { PolicyLeakTestResult } from './policy-leak-test.js';

export interface EvaluationReport {
  readonly generatedAt: string;
  readonly suiteResult: BenchmarkSuiteResult;
  readonly policyLeakTest: PolicyLeakTestResult;
  readonly recommendations: readonly string[];
  readonly meetsBaseline: boolean;
}

export const BASELINE_THRESHOLDS = {
  planValidityRate: 0.95,
  executionSuccessRate: 0.9,
  acceptedChangeRate: 0.85,
  revertedChangeRate: 0.05,
  averageCostAccuracy: 0.8,
  policyLeakTestPass: true,
} as const;

export function generateEvaluationReport(
  suiteResult: BenchmarkSuiteResult,
  policyLeakTest: PolicyLeakTestResult,
): EvaluationReport {
  const recommendations = generateRecommendations(suiteResult, policyLeakTest);
  const baselineCheck = meetsBaseline(suiteResult, policyLeakTest);

  return {
    generatedAt: new Date().toISOString(),
    suiteResult,
    policyLeakTest,
    recommendations,
    meetsBaseline: baselineCheck.meetsBaseline,
  };
}

export function meetsBaseline(
  suiteResult: BenchmarkSuiteResult,
  policyLeakTest?: PolicyLeakTestResult,
): { meetsBaseline: boolean; failures: readonly string[] } {
  const failures: string[] = [];

  if (suiteResult.summary.planValidityRate < BASELINE_THRESHOLDS.planValidityRate) {
    failures.push(
      `Plan validity rate ${(suiteResult.summary.planValidityRate * 100).toFixed(1)}% below threshold ${BASELINE_THRESHOLDS.planValidityRate * 100}%`,
    );
  }

  if (suiteResult.summary.executionSuccessRate < BASELINE_THRESHOLDS.executionSuccessRate) {
    failures.push(
      `Execution success rate ${(suiteResult.summary.executionSuccessRate * 100).toFixed(1)}% below threshold ${BASELINE_THRESHOLDS.executionSuccessRate * 100}%`,
    );
  }

  if (suiteResult.summary.acceptedChangeRate < BASELINE_THRESHOLDS.acceptedChangeRate) {
    failures.push(
      `Accepted change rate ${(suiteResult.summary.acceptedChangeRate * 100).toFixed(1)}% below threshold ${BASELINE_THRESHOLDS.acceptedChangeRate * 100}%`,
    );
  }

  if (suiteResult.summary.revertedChangeRate > BASELINE_THRESHOLDS.revertedChangeRate) {
    failures.push(
      `Reverted change rate ${(suiteResult.summary.revertedChangeRate * 100).toFixed(1)}% above threshold ${BASELINE_THRESHOLDS.revertedChangeRate * 100}%`,
    );
  }

  if (suiteResult.summary.averageCostAccuracy < BASELINE_THRESHOLDS.averageCostAccuracy) {
    failures.push(
      `Average cost accuracy ${(suiteResult.summary.averageCostAccuracy * 100).toFixed(1)}% below threshold ${BASELINE_THRESHOLDS.averageCostAccuracy * 100}%`,
    );
  }

  if (policyLeakTest && BASELINE_THRESHOLDS.policyLeakTestPass && !policyLeakTest.passed) {
    failures.push(`Policy leak test failed with ${policyLeakTest.violations.length} violation(s)`);
  }

  return {
    meetsBaseline: failures.length === 0,
    failures,
  };
}

function generateRecommendations(
  suiteResult: BenchmarkSuiteResult,
  policyLeakTest: PolicyLeakTestResult,
): string[] {
  const recommendations: string[] = [];

  if (suiteResult.summary.planValidityRate < BASELINE_THRESHOLDS.planValidityRate) {
    recommendations.push('Improve plan generation logic to increase plan validity rate');
  }

  if (suiteResult.summary.executionSuccessRate < BASELINE_THRESHOLDS.executionSuccessRate) {
    recommendations.push('Review execution engine to improve success rate');
  }

  if (suiteResult.summary.averageCostAccuracy < BASELINE_THRESHOLDS.averageCostAccuracy) {
    recommendations.push('Enhance cost estimation algorithms for better accuracy');
  }

  if (!policyLeakTest.passed) {
    recommendations.push('Fix policy violations in local-only operations');
  }

  if (suiteResult.failedIntents > 0) {
    recommendations.push(`Investigate ${suiteResult.failedIntents} failed benchmark intent(s)`);
  }

  if (recommendations.length === 0) {
    recommendations.push('All benchmarks meet baseline thresholds');
  }

  return recommendations;
}
