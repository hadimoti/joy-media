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

export function isJoyAgentHostToolName(value: unknown): value is JoyAgentHostToolName {
  return (
    typeof value === 'string' && (JOY_AGENT_HOST_TOOL_NAMES as readonly string[]).includes(value)
  );
}
