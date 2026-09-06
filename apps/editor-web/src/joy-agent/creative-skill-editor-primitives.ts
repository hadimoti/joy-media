import { getCreativeSkill, type CreativeSkillManifest } from '@joy-media/agent-tools';
import type { JoyAgentHostToolName } from './host-tool-contract.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import type { CreativeSkillHostPrimitives } from './creative-skill-host-adapter.js';
import type { DirectorVerificationReport } from './director-verifier.js';

/**
 * The terminal state of one scoped recipe tool-loop. `prepared` carries the
 * opaque proposal identity; `answer` is the advisory/no-edit outcome; `failed`
 * is a redacted host/provider failure.
 */
export type CreativeSkillScopedToolLoopResult =
  | {
      readonly kind: 'prepared';
      readonly changeSetId: string;
      readonly operationDigest: string;
      readonly operationCount: number;
      readonly repairAttempts: number;
    }
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface CreativeSkillScopedToolLoopInput {
  readonly skillId: CreativeSkillManifest['id'];
  readonly scope: CreativeSkillRunScope;
  readonly signal: AbortSignal;
  readonly allowedToolNames: readonly JoyAgentHostToolName[];
  readonly prompt: string;
  readonly maxRepairProposals: number;
}

/**
 * Narrow function dependencies wired from the `App.tsx` object graph. Keeping
 * them as functions rather than the raw host objects lets the primitives be
 * unit-tested without a Worker.
 */
export interface CreativeSkillEditorPrimitiveDeps {
  readProjectContext(input: {
    readonly scope: CreativeSkillRunScope;
    readonly contextSelectors: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly summary: string }>;

  /** Runs one scoped `runJoyAgentTask` tool-loop to a terminal state. */
  runScopedToolLoop(
    input: CreativeSkillScopedToolLoopInput,
  ): Promise<CreativeSkillScopedToolLoopResult>;

  /** Reads the coverage the scoped tool-loop's observation produced. */
  readObservationCoverage(input: {
    readonly scope: CreativeSkillRunScope;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly coverageSummary: string;
    readonly coverageComplete: boolean;
    readonly evidenceIds: readonly string[];
    readonly moment?: { readonly summary: string };
    readonly uncertainty?: string;
  }>;

  /** Confirms the renderer acknowledged the staged preview of a prepared change. */
  confirmPreviewRendered(input: {
    readonly scope: CreativeSkillRunScope;
    readonly changeSetId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly previewId: string; readonly rendererAcknowledged: boolean }>;

  /** Runs the O6 composed + encoded-output verification for verify-deliverable. */
  verifyComposedAndEncoded(input: {
    readonly scope: CreativeSkillRunScope;
    readonly signal: AbortSignal;
    readonly evidenceRequirements: readonly string[];
  }): Promise<{ readonly report: DirectorVerificationReport; readonly summary: string }>;
}

const OBSERVE_TOOLS: readonly JoyAgentHostToolName[] = [
  'media_describe',
  'media_observe',
  'media_frames',
  'evidence_read',
  'evidence_coverage',
];

/**
 * Product-owned recipe prompt templates. These are constants: never model- or
 * user-authored, and they cannot widen the tool allow-list.
 */
const RECIPE_PROMPTS: Readonly<Record<CreativeSkillManifest['id'], string>> = Object.freeze({
  'creative-brief':
    'Read the project goal and existing brief. Produce a bounded structured Creative Brief. Make no editor change.',
  'watch-and-map':
    'Identify the source assets and requested ranges, read bounded source samples within budget, and return an evidence map with explicit sampled coverage and uncertainty. Make no editor change.',
  'find-moment':
    'Resolve the requested source and search interval, inspect the bounded exact interval, and return one cited source time range with its coverage status. Make no editor change.',
  'build-rough-cut':
    'Resolve the selected source ranges and target tracks, read the requested source evidence, then prepare typed timeline operations for a reversible rough cut. Only prepare a change; never apply it.',
  'title-and-caption-polish':
    'Inspect the bounded title and caption context and prepare typed, readable text and timing edits, preserving right-to-left text. Only prepare a change; never apply it.',
  'motion-and-transition-polish':
    'Resolve existing properties and timeline junctions and prepare typed property and transition operations at those exact targets. Only prepare a change; never apply it.',
  'audio-balance':
    'Measure bounded audio evidence and uncertainty, then prepare a mix proposal through the verified adapter. Only prepare a change; never apply it.',
  'verify-deliverable':
    'Capture the frozen composed output and verify the final encoded media timing and tracks against explicit predicates. Make no editor change.',
});

/** Compute the manifest-derived host tool allow-list for one recipe. */
export function buildCreativeSkillToolAllowList(
  skill: CreativeSkillManifest,
): readonly JoyAgentHostToolName[] {
  const tools: JoyAgentHostToolName[] = ['read_project_context'];
  const needsObservation = !(
    skill.evidenceRequirements.length === 1 && skill.evidenceRequirements[0] === 'none'
  );
  if (needsObservation) tools.push(...OBSERVE_TOOLS);
  if (skill.evidenceRequirements.includes('transcript')) tools.push('media_transcript');
  if (skill.requiredOperationKinds.length > 0) tools.push('validate_proposal');
  return Object.freeze([...new Set(tools)]);
}

function buildCreativeSkillPrompt(
  skill: CreativeSkillManifest,
  priorSummaries: readonly string[],
): string {
  const base = RECIPE_PROMPTS[skill.id];
  const context =
    priorSummaries.length > 0 ? `\n\nContext so far:\n- ${priorSummaries.join('\n- ')}` : '';
  const operations =
    skill.requiredOperationKinds.length > 0
      ? `\n\nAllowed canonical operations: ${skill.requiredOperationKinds.join(', ')}.`
      : '';
  return `${skill.title}. ${base}${operations}${context}`.slice(0, 8_000);
}

class CreativeSkillToolLoopFailure extends Error {
  constructor(message: string) {
    super(`JOY_CREATIVE_SKILL_TOOL_LOOP:${message}`);
    this.name = 'CreativeSkillToolLoopFailure';
  }
}

/**
 * Build the editor `CreativeSkillHostPrimitives` for one recipe run. A single
 * scoped tool-loop is run lazily on the first model-needing checkpoint and its
 * terminal state is shared by `observe` and `propose`.
 */
export function createCreativeSkillEditorPrimitives(
  deps: CreativeSkillEditorPrimitiveDeps,
  scope: CreativeSkillRunScope,
): CreativeSkillHostPrimitives {
  let toolLoop: Promise<CreativeSkillScopedToolLoopResult> | undefined;
  let priorForPrompt: readonly string[] = [];

  const ensureToolLoop = (
    skill: CreativeSkillManifest,
    signal: AbortSignal,
  ): Promise<CreativeSkillScopedToolLoopResult> => {
    if (toolLoop === undefined) {
      toolLoop = deps.runScopedToolLoop({
        skillId: skill.id,
        scope,
        signal,
        allowedToolNames: buildCreativeSkillToolAllowList(skill),
        prompt: buildCreativeSkillPrompt(skill, priorForPrompt),
        maxRepairProposals: skill.budget.maxRepairProposals,
      });
    }
    return toolLoop;
  };

  return {
    async readProjectContext(input) {
      return deps.readProjectContext({
        scope: input.scope,
        contextSelectors: input.contextSelectors,
        signal: input.signal,
      });
    },

    async observeSources(input) {
      const skill = manifestFor(input.skillId);
      await ensureToolLoop(skill, input.signal);
      const coverage = await deps.readObservationCoverage({
        scope: input.scope,
        signal: input.signal,
      });
      priorForPrompt = [...priorForPrompt, coverage.coverageSummary];
      return {
        evidenceIds: coverage.evidenceIds,
        coverageSummary: coverage.coverageSummary,
        coverageComplete: coverage.coverageComplete,
        ...(coverage.moment === undefined ? {} : { moment: coverage.moment }),
        ...(coverage.uncertainty === undefined ? {} : { uncertainty: coverage.uncertainty }),
      };
    },

    async prepareChange(input) {
      const skill = manifestFor(input.skillId);
      const result = await ensureToolLoop(skill, input.signal);
      if (result.kind === 'failed') throw new CreativeSkillToolLoopFailure(result.message);
      if (result.kind === 'answer') return { kind: 'unavailable', reason: 'no-actionable-edit' };
      return {
        kind: 'prepared',
        changeSetId: result.changeSetId,
        operationDigest: result.operationDigest,
        operationCount: result.operationCount,
        repairAttempts: result.repairAttempts,
        summary: `Prepared ${result.operationCount} typed operation${
          result.operationCount === 1 ? '' : 's'
        } for ${skill.title}.`,
      };
    },

    async stagePreview(input) {
      const ack = await deps.confirmPreviewRendered({
        scope: input.scope,
        changeSetId: input.changeSetId,
        signal: input.signal,
      });
      return {
        previewId: ack.previewId,
        rendererAcknowledged: ack.rendererAcknowledged,
        summary: ack.rendererAcknowledged
          ? 'Before/after preview acknowledged by the renderer.'
          : 'The renderer did not acknowledge the staged preview.',
      };
    },

    async verifyDeliverable(input) {
      return deps.verifyComposedAndEncoded({
        scope: input.scope,
        signal: input.signal,
        evidenceRequirements: input.evidenceRequirements,
      });
    },
  };
}

function manifestFor(skillId: CreativeSkillManifest['id']): CreativeSkillManifest {
  const skill = getCreativeSkill(skillId);
  if (skill === undefined) throw new CreativeSkillToolLoopFailure(`UNKNOWN_SKILL:${skillId}`);
  return skill;
}
