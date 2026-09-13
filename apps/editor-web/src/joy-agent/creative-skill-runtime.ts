import {
  listModelVisibleJoyEditorOperationDefinitions,
  type CreativeSkillCapability,
  type CreativeSkillRuntime,
} from '@joy-media/agent-tools';

/**
 * Which editor host seams are actually wired and browser-proven. The recipe
 * runtime is computed from these booleans only, so an unimplemented adapter
 * keeps its recipe visible-but-unavailable instead of being a false promise.
 */
export interface CreativeSkillSeamAvailability {
  /** Bounded project-context read RPC. */
  readonly projectContext: boolean;
  /** Canonical host compiler preparing typed proposals. */
  readonly canonicalPrepare: boolean;
  /** Immutable staged preview with renderer acknowledgement. */
  readonly preview: boolean;
  /** Human approval / transaction boundary. */
  readonly approval: boolean;
  /** The observation host bridge (source samples + evidence coverage). */
  readonly observationBridge: boolean;
  /** Local transcript evidence adapter. */
  readonly transcriptEvidence: boolean;
  /** Bounded local audio measurement. */
  readonly audioAnalysis: boolean;
  /** Frozen composition capture through the real render path. */
  readonly compositionCapture: boolean;
  /** Decoded final-encoded-export verification. */
  readonly encodedOutputVerification: boolean;
  /** A verified audio-mix operation with decoded-mix readback. */
  readonly audioMix: boolean;
  /** An RTL-text project-state / rendered readback. */
  readonly rtlTextReadback: boolean;
}

/**
 * The R1 truth for the browser editor host: observation, transcript and audio
 * measurement are wired. Composition capture and encoded-output verification
 * are not wired into the recipe path yet, so Verify Deliverable stays visible-
 * unavailable alongside audio-mix and RTL-text recipes.
 */
export const R1_EDITOR_CREATIVE_SKILL_SEAMS: CreativeSkillSeamAvailability = Object.freeze({
  projectContext: true,
  canonicalPrepare: true,
  preview: true,
  approval: true,
  observationBridge: true,
  transcriptEvidence: true,
  audioAnalysis: true,
  compositionCapture: false,
  encodedOutputVerification: false,
  audioMix: false,
  rtlTextReadback: false,
});

export function computeCreativeSkillCapabilities(
  seams: CreativeSkillSeamAvailability,
): readonly CreativeSkillCapability[] {
  const capabilities: CreativeSkillCapability[] = [];
  if (seams.projectContext) capabilities.push('project-context');
  if (seams.canonicalPrepare) capabilities.push('canonical-prepare');
  if (seams.preview) capabilities.push('preview');
  if (seams.approval) capabilities.push('approval');
  if (seams.observationBridge) capabilities.push('source-observation', 'evidence-coverage');
  if (seams.transcriptEvidence) capabilities.push('transcript-evidence');
  if (seams.audioAnalysis) capabilities.push('audio-analysis');
  if (seams.compositionCapture) capabilities.push('composition-capture');
  if (seams.encodedOutputVerification) capabilities.push('encoded-output-verification');
  if (seams.audioMix) capabilities.push('audio-mix');
  if (seams.rtlTextReadback) capabilities.push('rtl-text');
  return Object.freeze(capabilities);
}

/**
 * Build the `CreativeSkillRuntime` that drives recipe availability. The
 * operation definitions come from the F1 model-visible registry (already
 * filtered to `canAdvertiseOperation`).
 */
export function createEditorCreativeSkillRuntime(
  seams: CreativeSkillSeamAvailability = R1_EDITOR_CREATIVE_SKILL_SEAMS,
): CreativeSkillRuntime {
  return Object.freeze({
    capabilities: computeCreativeSkillCapabilities(seams),
    operationDefinitions: listModelVisibleJoyEditorOperationDefinitions(),
  });
}
