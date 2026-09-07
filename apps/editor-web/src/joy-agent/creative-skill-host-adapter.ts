import type { JoyCodeOperationKind } from '@joy-media/agent-tools';
import type { CreativeSkillManifest } from '@joy-media/agent-tools';
import type {
  CreativeSkillArtifact,
  CreativeSkillArtifactKind,
  CreativeSkillCheckpointInput,
  CreativeSkillRunAdapter,
  CreativeSkillRunScope,
  CreativeSkillStepResult,
} from './skill-runner.js';
import type { DirectorVerificationReport } from './director-verifier.js';

/**
 * The trusted host primitives a recipe checkpoint may use. Each delegates to
 * the SAME infrastructure the direct tool-loop uses -- one Worker, the
 * observation host bridge, the canonical compiler, the staged-preview path and
 * the director verifier. There is deliberately no commit primitive: a prepared
 * change leaves the run `ready-for-approval` and the existing approval envelope
 * remains the only write path.
 */
export interface CreativeSkillHostPrimitives {
  readProjectContext(input: {
    readonly skillId: CreativeSkillManifest['id'];
    readonly scope: CreativeSkillRunScope;
    readonly contextSelectors: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly summary: string }>;

  observeSources(input: {
    readonly skillId: CreativeSkillManifest['id'];
    readonly scope: CreativeSkillRunScope;
    readonly signal: AbortSignal;
    readonly privacyRequirement: CreativeSkillManifest['privacyRequirement'];
    readonly evidenceRequirements: readonly string[];
    /**
     * The manifest observation budget, forwarded for the implementation's
     * information. R1's editor implementation does not re-enforce a
     * per-checkpoint request/evidence cap here: recipe observation is already
     * bounded by the single scoped tool-loop's overall call budget, the O5
     * consent envelope, and the run-budget. A per-checkpoint cap is an R2
     * refinement.
     */
    readonly budget: {
      readonly maxObservationRequests: number;
      readonly maxEvidenceItems: number;
    };
  }): Promise<{
    readonly evidenceIds: readonly string[];
    readonly coverageSummary: string;
    readonly coverageComplete: boolean;
    readonly moment?: { readonly summary: string };
    readonly uncertainty?: string;
  }>;

  prepareChange(input: {
    readonly skillId: CreativeSkillManifest['id'];
    readonly scope: CreativeSkillRunScope;
    readonly signal: AbortSignal;
    readonly allowedOperationKinds: readonly JoyCodeOperationKind[];
    readonly maxRepairProposals: number;
    readonly priorSummaries: readonly string[];
  }): Promise<
    | {
        readonly kind: 'prepared';
        readonly changeSetId: string;
        readonly operationDigest: string;
        readonly operationCount: number;
        readonly repairAttempts: number;
        readonly summary: string;
      }
    | { readonly kind: 'unavailable'; readonly reason: string }
  >;

  stagePreview(input: {
    readonly skillId: CreativeSkillManifest['id'];
    readonly scope: CreativeSkillRunScope;
    readonly signal: AbortSignal;
    readonly changeSetId: string;
  }): Promise<{
    readonly previewId: string;
    readonly rendererAcknowledged: boolean;
    readonly summary: string;
  }>;

  verifyDeliverable(input: {
    readonly skillId: CreativeSkillManifest['id'];
    readonly scope: CreativeSkillRunScope;
    readonly signal: AbortSignal;
    readonly evidenceRequirements: readonly string[];
  }): Promise<{ readonly report: DirectorVerificationReport; readonly summary: string }>;
}

const MAX_ARTIFACT_SUMMARY = 512;

class CreativeSkillHostAdapterFailure extends Error {
  constructor(message: string) {
    super(`JOY_CREATIVE_SKILL_HOST_${message}`);
    this.name = 'CreativeSkillHostAdapterFailure';
  }
}

/**
 * Build a single-use adapter for one recipe run. It accumulates per-checkpoint
 * summaries so `propose` can carry the inspect/observe findings, and it never
 * holds authority: the runner re-checks `isAuthorityCurrent` around every call.
 */
export function createCreativeSkillHostAdapter(
  primitives: CreativeSkillHostPrimitives,
): CreativeSkillRunAdapter {
  const priorSummaries: string[] = [];
  let preparedChangeSetId: string | undefined;
  let lastCoverageSummary: string | undefined;
  let lastCoverageComplete = false;

  const remember = (summary: string): void => {
    priorSummaries.push(summary.slice(0, MAX_ARTIFACT_SUMMARY));
  };

  const artifact = (
    input: CreativeSkillCheckpointInput,
    suffix: string,
    kind: CreativeSkillArtifactKind,
    summary: string,
    uncertainty?: string,
  ): CreativeSkillArtifact =>
    Object.freeze({
      id: `${kind}:${input.scope.runId}:${suffix}`,
      kind,
      summary: summary.slice(0, MAX_ARTIFACT_SUMMARY),
      ...(uncertainty === undefined
        ? {}
        : { uncertainty: uncertainty.slice(0, MAX_ARTIFACT_SUMMARY) }),
    });

  const step = (artifacts: readonly CreativeSkillArtifact[]): CreativeSkillStepResult =>
    Object.freeze({ artifacts });

  return Object.freeze({
    async inspect(input: CreativeSkillCheckpointInput): Promise<CreativeSkillStepResult> {
      const result = await primitives.readProjectContext({
        skillId: input.skill.id,
        scope: input.scope,
        contextSelectors: input.skill.contextSelectors,
        signal: input.signal,
      });
      remember(result.summary);
      return step([artifact(input, input.checkpoint.id, 'context', result.summary)]);
    },

    async observe(input: CreativeSkillCheckpointInput): Promise<CreativeSkillStepResult> {
      const result = await primitives.observeSources({
        skillId: input.skill.id,
        scope: input.scope,
        signal: input.signal,
        privacyRequirement: input.skill.privacyRequirement,
        evidenceRequirements: input.skill.evidenceRequirements,
        budget: {
          maxObservationRequests: input.skill.budget.maxObservationRequests,
          maxEvidenceItems: input.skill.budget.maxEvidenceItems,
        },
      });
      lastCoverageSummary = result.coverageSummary;
      lastCoverageComplete = result.coverageComplete;
      remember(result.coverageSummary);
      const artifacts: CreativeSkillArtifact[] =
        result.moment === undefined
          ? [
              artifact(
                input,
                input.checkpoint.id,
                'evidence',
                result.coverageSummary,
                result.uncertainty,
              ),
            ]
          : [
              artifact(
                input,
                input.checkpoint.id,
                'moment',
                result.moment.summary,
                result.uncertainty,
              ),
            ];
      return step(artifacts);
    },

    async propose(input: CreativeSkillCheckpointInput): Promise<CreativeSkillStepResult> {
      const result = await primitives.prepareChange({
        skillId: input.skill.id,
        scope: input.scope,
        signal: input.signal,
        allowedOperationKinds: input.skill.requiredOperationKinds,
        maxRepairProposals: input.skill.budget.maxRepairProposals,
        priorSummaries: Object.freeze([...priorSummaries]),
      });
      if (result.kind === 'unavailable')
        throw new CreativeSkillHostAdapterFailure(`NO_PREPARED_CHANGE:${result.reason}`);
      preparedChangeSetId = result.changeSetId;
      const summary =
        result.repairAttempts > 0
          ? `${result.summary} (after ${result.repairAttempts} bounded repair proposal${
              result.repairAttempts === 1 ? '' : 's'
            })`
          : result.summary;
      return step([artifact(input, input.checkpoint.id, 'prepared-change', summary)]);
    },

    async preview(input: CreativeSkillCheckpointInput): Promise<CreativeSkillStepResult> {
      if (preparedChangeSetId === undefined)
        throw new CreativeSkillHostAdapterFailure('PREVIEW_WITHOUT_PREPARED_CHANGE');
      const result = await primitives.stagePreview({
        skillId: input.skill.id,
        scope: input.scope,
        signal: input.signal,
        changeSetId: preparedChangeSetId,
      });
      if (!result.rendererAcknowledged)
        throw new CreativeSkillHostAdapterFailure('PREVIEW_NOT_RENDERED');
      return step([artifact(input, input.checkpoint.id, 'preview', result.summary)]);
    },

    async verify(input: CreativeSkillCheckpointInput): Promise<CreativeSkillStepResult> {
      if (input.skill.id === 'verify-deliverable') {
        const result = await primitives.verifyDeliverable({
          skillId: input.skill.id,
          scope: input.scope,
          signal: input.signal,
          evidenceRequirements: input.skill.evidenceRequirements,
        });
        const failing = result.report.checks.filter((check) => check.status === 'failed');
        const summary =
          `Verification ${result.report.overall}: ` +
          `${result.report.checks.length} check(s), ${failing.length} failed. ${result.summary}`;
        return step([
          artifact(
            input,
            input.checkpoint.id,
            'verification',
            summary,
            result.report.overall === 'verified'
              ? undefined
              : 'Not every deliverable method (structural, rendered, audio-measured, encoded-output) passed.',
          ),
        ]);
      }
      // find-moment / watch-and-map: report the coverage the observe step recorded.
      const coverage = lastCoverageSummary ?? 'No source observation was recorded for this run.';
      return step([
        artifact(
          input,
          input.checkpoint.id,
          'verification',
          coverage,
          lastCoverageComplete
            ? undefined
            : 'Coverage is a sampled subset; it is not exhaustive source understanding.',
        ),
      ]);
    },
  });
}
