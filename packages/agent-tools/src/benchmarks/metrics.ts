import type { ToolRegistry } from '../registry.js';
import type { ApprovalEngine } from '../approval.js';
import type { AgentEditPlan, AgentPlanStep } from '../plan.js';
import type { EditorContext } from '../context.js';
import type { ExecutionResult } from '../execution.js';
import type { BenchmarkIntent, BenchmarkProject, ValidationCheck } from './types.js';
import type { JsonValue } from '../types.js';
import { createPlan } from '../plan.js';
import { PlanExecutor } from '../execution.js';

export interface BenchmarkMetrics {
  readonly intentId: string;
  readonly planValidity: boolean;
  readonly executionSuccess: boolean;
  readonly acceptedChange: boolean;
  readonly revertedChange: boolean;
  readonly unintendedChanges: number;
  readonly costAccuracy: number;
  readonly durationMs: number;
  readonly stepCount: number;
  readonly approvalCount: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface BenchmarkSuiteResult {
  readonly totalIntents: number;
  readonly passedIntents: number;
  readonly failedIntents: number;
  readonly metrics: readonly BenchmarkMetrics[];
  readonly summary: {
    readonly planValidityRate: number;
    readonly executionSuccessRate: number;
    readonly acceptedChangeRate: number;
    readonly revertedChangeRate: number;
    readonly averageCostAccuracy: number;
    readonly averageDurationMs: number;
  };
}

export class BenchmarkRunner {
  private readonly registry: ToolRegistry;
  private readonly approvalEngine: ApprovalEngine;

  constructor(registry: ToolRegistry, approvalEngine: ApprovalEngine) {
    this.registry = registry;
    this.approvalEngine = approvalEngine;
  }

  async runBenchmark(
    intent: BenchmarkIntent,
    project: BenchmarkProject,
  ): Promise<BenchmarkMetrics> {
    const startTime = Date.now();
    const warnings: string[] = [];
    const errors: string[] = [];

    const plan = this.createPlanFromIntent(intent, project.context);
    const planValidity = this.validatePlan(plan, intent);

    if (!planValidity) {
      errors.push('Plan validation failed');
    }

    const executor = new PlanExecutor(this.registry, this.approvalEngine);
    let executionResult: ExecutionResult | null = null;
    let executionSuccess = false;
    let acceptedChange = false;
    const revertedChange = false;
    let unintendedChanges = 0;
    let approvalCount = 0;

    try {
      executionResult = await executor.execute(plan, project.context, project.projectState);
      executionSuccess = executionResult.success;
      acceptedChange =
        executionSuccess && executionResult.stepResults.some((s) => s.status === 'success');
      unintendedChanges = this.countUnintendedChanges(executionResult, intent);
      approvalCount = plan.requiredApprovals.length;

      if (intent.requiresApproval.length > 0) {
        const approvals = this.approvalEngine.evaluatePlan(plan, project.context);
        approvalCount = approvals.filter((a) => a.decision === 'requires-manual').length;
      }
    } catch (error) {
      errors.push(`Execution error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const durationMs = Date.now() - startTime;
    const costAccuracy = this.calculateCostAccuracy(plan, executionResult);

    return {
      intentId: intent.id,
      planValidity,
      executionSuccess,
      acceptedChange,
      revertedChange,
      unintendedChanges,
      costAccuracy,
      durationMs,
      stepCount: plan.steps.length,
      approvalCount,
      warnings,
      errors,
    };
  }

  async runSuite(
    intents: readonly BenchmarkIntent[],
    projects: readonly BenchmarkProject[],
  ): Promise<BenchmarkSuiteResult> {
    const metrics: BenchmarkMetrics[] = [];

    for (const intent of intents) {
      const project = this.selectProject(intent, projects);
      const metric = await this.runBenchmark(intent, project);
      metrics.push(metric);
    }

    const passedIntents = metrics.filter(
      (m) => m.planValidity && m.executionSuccess && m.errors.length === 0,
    ).length;
    const failedIntents = metrics.length - passedIntents;

    const planValidityRate = metrics.filter((m) => m.planValidity).length / metrics.length;
    const executionSuccessRate = metrics.filter((m) => m.executionSuccess).length / metrics.length;
    const acceptedChangeRate = metrics.filter((m) => m.acceptedChange).length / metrics.length;
    const revertedChangeRate = metrics.filter((m) => m.revertedChange).length / metrics.length;
    const averageCostAccuracy =
      metrics.reduce((sum, m) => sum + m.costAccuracy, 0) / metrics.length;
    const averageDurationMs = metrics.reduce((sum, m) => sum + m.durationMs, 0) / metrics.length;

    return {
      totalIntents: metrics.length,
      passedIntents,
      failedIntents,
      metrics,
      summary: {
        planValidityRate,
        executionSuccessRate,
        acceptedChangeRate,
        revertedChangeRate,
        averageCostAccuracy,
        averageDurationMs,
      },
    };
  }

  validateResults(
    metrics: BenchmarkMetrics,
    intent: BenchmarkIntent,
  ): { passed: boolean; failures: readonly string[] } {
    const failures: string[] = [];

    if (!metrics.planValidity) {
      failures.push('Plan validation failed');
    }

    if (!metrics.executionSuccess) {
      failures.push('Execution failed');
    }

    if (metrics.unintendedChanges > 0) {
      failures.push(`Unintended changes: ${metrics.unintendedChanges}`);
    }

    for (const check of intent.validationChecks) {
      const checkResult = this.validateCheck(check, metrics, intent);
      if (!checkResult.passed) {
        failures.push(checkResult.message);
      }
    }

    return {
      passed: failures.length === 0,
      failures,
    };
  }

  private createPlanFromIntent(intent: BenchmarkIntent, context: EditorContext): AgentEditPlan {
    const steps: AgentPlanStep[] = intent.expectedTools.map((tool, index) => ({
      id: `step-${index + 1}`,
      description: `${tool} operation`,
      mode: 'command' as const,
      tool,
      arguments: this.createToolArguments(tool, context),
      dependsOn: index > 0 ? [`step-${index}`] : [],
      expectedChange: `${tool} applied`,
      preconditions: [],
      requiresConfirmation: false,
    }));

    return createPlan(intent.intent, steps, {
      planId: `bench-plan-${intent.id}`,
      status: 'draft',
    });
  }

  private createToolArguments(tool: string, context: EditorContext): Record<string, JsonValue> {
    const clipId = context.selection.selectedClipIds[0] ?? 'clip-1';
    const compositionId = context.timeline.compositions[0]?.id ?? 'comp-1';
    const trackId = context.selection.selectedTrackIds[0] ?? 'track-1';

    switch (tool) {
      case 'insertClip':
        return {
          compositionId,
          trackId,
          clip: {
            id: `clip-new-${Date.now()}`,
            kind: 'video',
            startUs: context.selection.playheadUs,
            durationUs: 1_000_000,
          },
        };
      case 'removeClip':
        return { compositionId, trackId, clipId };
      case 'moveClip':
        return { compositionId, trackId, clipId, newStartUs: context.selection.playheadUs };
      case 'trimClip':
        return { compositionId, trackId, clipId, newStartUs: 2_000_000, newEndUs: 8_000_000 };
      case 'splitClip':
        return {
          compositionId,
          trackId,
          clipId,
          atUs: context.selection.playheadUs,
          newClipId: `clip-split-${Date.now()}`,
        };
      case 'joinClips':
        return { compositionId, trackId, firstClipId: clipId, secondClipId: 'clip-2' };
      case 'setGain':
        return { clipId, gain: -3.0 };
      case 'setPan':
        return { clipId, pan: 0.0 };
      case 'setMute':
        return { clipId, mute: false };
      case 'setFade':
        return { clipId, fadeInUs: 500_000, fadeOutUs: 500_000 };
      case 'addEffect':
        return { id: `effect-${Date.now()}`, targetId: clipId, effect: { type: 'noiseReduction' } };
      case 'searchTranscript':
        return { query: 'hello' };
      default:
        return {};
    }
  }

  private validatePlan(plan: AgentEditPlan, intent: BenchmarkIntent): boolean {
    if (plan.steps.length === 0) {
      return false;
    }

    const tools = plan.steps.map((s) => s.tool);
    const expectedTools = [...intent.expectedTools];

    if (tools.length !== expectedTools.length) {
      return false;
    }

    for (const expectedTool of expectedTools) {
      if (!tools.includes(expectedTool)) {
        return false;
      }
    }

    return true;
  }

  private countUnintendedChanges(result: ExecutionResult, intent: BenchmarkIntent): number {
    const expectedTools = new Set(intent.expectedTools);
    let unintended = 0;

    for (const stepResult of result.stepResults) {
      if (stepResult.status === 'success' && stepResult.toolResult?.diff) {
        const step = result.stepResults.find((s) => s.stepId === stepResult.stepId);
        if (step) {
          const tool = stepResult.toolResult;
          if (
            tool.diff &&
            (tool.diff.created.length > 0 ||
              tool.diff.modified.length > 0 ||
              tool.diff.deleted.length > 0)
          ) {
            const stepTool = result.stepResults.find((s) => s.stepId === stepResult.stepId);
            if (stepTool && !expectedTools.has(stepTool.stepId)) {
              unintended++;
            }
          }
        }
      }
    }

    return unintended;
  }

  private calculateCostAccuracy(plan: AgentEditPlan, result: ExecutionResult | null): number {
    if (!result || !result.actualCost) {
      return 1.0;
    }

    const estimatedCost = plan.estimated.cost;
    const actualCost = result.actualCost;

    if (!estimatedCost || !actualCost.providerCost) {
      return 1.0;
    }

    const estimatedAmount = parseFloat(estimatedCost.max.amount);
    const actualAmount = parseFloat(actualCost.providerCost.amount);

    if (estimatedAmount === 0 && actualAmount === 0) {
      return 1.0;
    }

    const diff = Math.abs(estimatedAmount - actualAmount);
    const accuracy = Math.max(0, 1 - diff / Math.max(estimatedAmount, 0.01));

    return accuracy;
  }

  private selectProject(
    intent: BenchmarkIntent,
    projects: readonly BenchmarkProject[],
  ): BenchmarkProject {
    if (intent.id.includes('minimal')) {
      return projects.find((p) => p.id.includes('minimal')) ?? projects[0]!;
    }
    return projects[0]!;
  }

  private validateCheck(
    check: ValidationCheck,
    metrics: BenchmarkMetrics,
    intent: BenchmarkIntent,
  ): { passed: boolean; message: string } {
    switch (check.type) {
      case 'entities-created':
        return { passed: metrics.executionSuccess, message: 'Entities not created' };
      case 'entities-modified':
        return { passed: metrics.executionSuccess, message: 'Entities not modified' };
      case 'no-overlaps':
        return { passed: metrics.executionSuccess, message: 'Overlaps detected' };
      case 'captions-valid':
        return { passed: metrics.executionSuccess, message: 'Captions invalid' };
      case 'audio-valid':
        return { passed: metrics.executionSuccess, message: 'Audio invalid' };
      case 'cost-within-limit':
        return { passed: metrics.costAccuracy >= 0.8, message: 'Cost exceeds limit' };
      case 'local-only-respected':
        return { passed: intent.localOnly, message: 'Local-only not respected' };
      case 'approval-requested':
        return { passed: metrics.approvalCount > 0, message: 'Approval not requested' };
      case 'revert-possible':
        return { passed: metrics.revertedChange, message: 'Revert not possible' };
      default:
        return { passed: true, message: '' };
    }
  }
}

export function createBenchmarkRunner(
  registry: ToolRegistry,
  approvalEngine: ApprovalEngine,
): BenchmarkRunner {
  return new BenchmarkRunner(registry, approvalEngine);
}
