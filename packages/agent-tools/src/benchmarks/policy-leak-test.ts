import type { ToolRegistry } from '../registry.js';
import type { ApprovalEngine } from '../approval.js';
import type { AgentEditPlan, AgentPlanStep } from '../plan.js';
import type { EditorContext } from '../context.js';
import type { BenchmarkIntent, BenchmarkProject } from './types.js';
import type { JsonValue } from '../types.js';
import { createPlan } from '../plan.js';
import { isPlanLocalOnly } from '../estimation.js';

export interface PolicyLeakTestResult {
  readonly passed: boolean;
  readonly violations: readonly PolicyViolation[];
  readonly summary: string;
}

export interface PolicyViolation {
  readonly intentId: string;
  readonly stepId: string;
  readonly tool: string;
  readonly violation: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
}

export async function runLocalOnlyPolicyLeakTest(
  intents: readonly BenchmarkIntent[],
  projects: readonly BenchmarkProject[],
  registry: ToolRegistry,
  _approvalEngine: ApprovalEngine,
): Promise<PolicyLeakTestResult> {
  const violations: PolicyViolation[] = [];
  const localOnlyIntents = intents.filter((intent) => intent.localOnly);

  for (const intent of localOnlyIntents) {
    const project = projects[0];
    if (!project) continue;

    const plan = createPlanFromIntent(intent, project.context);
    const isLocal = isPlanLocalOnly(plan, registry, project.context);

    if (!isLocal) {
      for (const step of plan.steps) {
        const stepIsLocal = checkStepIsLocal(step, registry, project.context);
        if (!stepIsLocal) {
          violations.push({
            intentId: intent.id,
            stepId: step.id,
            tool: step.tool,
            violation: 'Local-only policy violated',
            expectedBehavior: 'Operation should remain local',
            actualBehavior: 'Operation attempts to send data to remote provider',
          });
        }
      }
    }
  }

  const passed = violations.length === 0;
  const summary = passed
    ? `All ${localOnlyIntents.length} local-only intents passed policy leak test`
    : `Found ${violations.length} policy violations in ${localOnlyIntents.length} local-only intents`;

  return {
    passed,
    violations,
    summary,
  };
}

function createPlanFromIntent(intent: BenchmarkIntent, context: EditorContext): AgentEditPlan {
  const steps: AgentPlanStep[] = intent.expectedTools.map((tool, index) => ({
    id: `step-${index + 1}`,
    description: `${tool} operation`,
    mode: 'command' as const,
    tool,
    arguments: createToolArguments(tool, context),
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

function createToolArguments(tool: string, context: EditorContext): Record<string, JsonValue> {
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

function checkStepIsLocal(
  step: AgentPlanStep,
  registry: ToolRegistry,
  context: EditorContext,
): boolean {
  const tool = registry.getTool(step.tool);
  if (!tool) {
    return true;
  }

  const toolDef = 'definition' in tool ? tool.definition : null;
  const requiresProvider =
    toolDef?.scope.capabilities.includes('provider.generate') === true ||
    toolDef?.scope.capabilities.includes('provider.spend') === true;

  if (requiresProvider) {
    const provider = context.providers.availableProviders[0];
    if (provider && provider.dataLeavesDevice) {
      return false;
    }
  }

  return true;
}
