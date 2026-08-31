import type {
  JoyCodeModelPlanV1,
  JoyCodePlanProposalV1,
  JoyCodeValidationOptions,
} from './joy-code-plan.js';
import type { CreativeBriefV1 } from './creative-brief.js';
import { validateJoyCodeModelPlan, validateJoyCodePlanProposal } from './joy-code-plan.js';

export interface JoyCodePlannerInputV1 {
  readonly projectId: string;
  readonly snapshotRevisionId: string;
  readonly prompt: string;
  /** Optional validated Creative Brief context explicitly handed off by the owner. */
  readonly creativeBrief?: CreativeBriefV1;
  readonly selection: {
    readonly clipIds: readonly string[];
    readonly objectIds?: readonly string[];
  };
  readonly contextSummary: string;
  readonly semanticSnapshot?: unknown;
  readonly intelligenceSummary?: unknown;
  readonly catalogs?: {
    readonly textTemplateIds: readonly string[];
    readonly captionTemplateIds: readonly string[];
    readonly transitionIds: readonly string[];
  };
}

export interface JoyCodePlanFinalizerMetadata {
  readonly planId: string;
  readonly createdAt: string;
  readonly catalogVersion: string;
  readonly consentVersion: string;
  readonly adapterName: string;
  readonly modelId: string;
}

export function finalizeJoyCodePlan(
  input: JoyCodePlannerInputV1,
  modelPlan: JoyCodeModelPlanV1,
  metadata: JoyCodePlanFinalizerMetadata,
  validationOptions: JoyCodeValidationOptions,
): ReturnType<typeof validateJoyCodePlanProposal> {
  const modelValidation = validateJoyCodeModelPlan(modelPlan, validationOptions);
  if (!modelValidation.valid) return modelValidation;
  const proposal: JoyCodePlanProposalV1 = {
    ...modelValidation.value,
    planId: metadata.planId,
    projectId: input.projectId,
    snapshotRevisionId: input.snapshotRevisionId,
    createdAt: metadata.createdAt,
    consentVersion: metadata.consentVersion,
    catalogVersion: metadata.catalogVersion,
    provenance: {
      actor: 'joy-code-server',
      adapterName: metadata.adapterName,
      modelId: metadata.modelId,
    },
  };
  return validateJoyCodePlanProposal(proposal, validationOptions);
}
