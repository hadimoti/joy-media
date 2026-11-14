/**
 * The one closed, product-owned vocabulary for model-visible browser host
 * calls. This deliberately lives below the provider catalog and public
 * Worker protocol so both boundaries validate the identical set without
 * pulling agent-tools schemas into the main client bundle.
 */
export const JOY_AGENT_HOST_TOOL_NAMES = [
  'read_project_context',
  'validate_proposal',
  'media_describe',
  'media_observe',
  'media_frames',
  'media_transcript',
  'evidence_read',
  'evidence_coverage',
  'qc_report_read',
  'media_frames_view',
  'media_contact_sheet',
  // Generated media (T-C04). `generate_media` always raises a cost card and waits
  // for the user; `attach_generated_media` places a job this run completed.
  'generate_media',
  'attach_generated_media',
  // Living Look intent tools (R2 / GAP 5). Deterministic host tools like
  // `validate_proposal`: the model supplies intent (which pack, which controls,
  // which instance) and the trusted host compiles the exact Look plan, stages a
  // reversible preview, and returns only opaque identities. A successful call is
  // terminal for the turn and never applies an edit — the operator approves the
  // staged change through the same approval card and Undo as every other agent
  // edit.
  'look_apply',
  'look_update',
  'look_reset_overrides',
  'look_detach',
] as const;

export type JoyAgentHostToolName = (typeof JOY_AGENT_HOST_TOOL_NAMES)[number];

/** Generated media limits shared by the model schema and the host parser (T-C04). */
export const GENERATION_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export const GENERATION_PROMPT_MAX_CHARS = 2_000;
export const GENERATION_MAX_SECONDS = 15;

export function isJoyAgentHostToolName(value: unknown): value is JoyAgentHostToolName {
  return (
    typeof value === 'string' && (JOY_AGENT_HOST_TOOL_NAMES as readonly string[]).includes(value)
  );
}
