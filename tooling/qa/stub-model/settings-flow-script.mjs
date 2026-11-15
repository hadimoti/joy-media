/**
 * The response script for the T-A11 settings flow (D-087 to D-091).
 *
 * Responses are picked by the shape of the request (`match`), so the order of the app's own
 * probe calls cannot shift the script. The probe tokens are the constants of
 * `apps/editor-web/src/joy-agent/provider-capabilities.ts`.
 *
 * Marker words the flow types into Joy Code: STUB-HELLO (plain reply), STUB-PLAN (read project
 * context, stage a `validate_proposal`, then a closing line), STUB-SLOW (a reply held for five
 * seconds, so a run can be cancelled), STUB-IMAGE (a reply to a request that carries an image).
 */

export const STUB_MODEL = 'joy-stub-model';

const TOOL_PROBE_CONTINUATION_TOKEN = 'JOY_PROVIDER_PROBE_CONTINUED_V1';
const MEDIA_PROBE_ACK = 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1';

/** A schema-valid renderer operation for a STUB-PLAN turn; live runs may pass project IDs. */
export const DEFAULT_PLAN_OPERATIONS = Object.freeze([
  Object.freeze({
    kind: 'timeline.insertExistingAsset',
    id: 'agent-intro',
    dependsOn: Object.freeze([]),
    compositionId: 'composition',
    targetTrackId: 'track',
    assetId: 'asset-1',
    startUs: 0,
    durationUs: 2_000_000,
  }),
]);

export function buildSettingsFlowScript({
  model = STUB_MODEL,
  planOperations = DEFAULT_PLAN_OPERATIONS,
} = {}) {
  const proposalCall = {
    id: 'call-stub-plan',
    type: 'function',
    function: {
      name: 'validate_proposal',
      arguments: JSON.stringify({
        summary: 'Add a source-backed intro clip.',
        operations: planOperations,
      }),
    },
  };
  const readContextCall = {
    id: 'call-stub-context',
    type: 'function',
    function: {
      name: 'read_project_context',
      arguments: JSON.stringify({ domain: 'overview', pageSize: 1 }),
    },
  };
  return {
    model,
    responses: [
      {
        content: null,
        reusable: true,
        match: {
          user_includes: 'joy_probe tool exactly once',
          last_role: 'user',
          tool: 'joy_probe',
        },
        tool_calls: [
          {
            id: 'call-joy-probe',
            type: 'function',
            function: { name: 'joy_probe', arguments: '{}' },
          },
        ],
      },
      {
        content: TOOL_PROBE_CONTINUATION_TOKEN,
        reusable: true,
        match: { last_role: 'tool', tool: 'joy_probe' },
      },
      {
        content: 'Plan-only text mode is available.',
        reusable: true,
        match: { user_includes: 'plan-only text mode' },
      },
      {
        content: MEDIA_PROBE_ACK,
        reusable: true,
        match: {
          user_includes: 'synthetic image capability test',
          media_part: 'image_url',
        },
      },
      {
        error: {
          message: 'Audio input is not supported by this model.',
          code: 'unsupported_media',
        },
        status_code: 400,
        reusable: true,
        match: {
          user_includes: 'synthetic audio capability test',
          media_part: 'input_audio',
        },
      },
      {
        content: MEDIA_PROBE_ACK,
        reusable: true,
        match: {
          user_includes: 'synthetic video capability test',
          media_part: 'video_url',
        },
      },
      {
        content: 'Hello from the JOY QA stub.',
        reusable: true,
        match: { user_includes: 'STUB-HELLO', last_role: 'user' },
      },
      {
        content: 'I can see the attached image.',
        reusable: true,
        match: { user_includes: 'STUB-IMAGE', media_part: 'image_url' },
      },
      {
        content: 'Slow reply from the JOY QA stub.',
        delay_ms: 5000,
        reusable: true,
        match: { user_includes: 'STUB-SLOW', last_role: 'user' },
      },
      {
        content: null,
        reusable: true,
        match: {
          user_includes: 'STUB-PLAN',
          last_role: 'user',
          tool: 'read_project_context',
        },
        tool_calls: [readContextCall],
      },
      {
        content: null,
        reusable: true,
        match: {
          user_includes: 'STUB-PLAN',
          last_role: 'tool',
          last_tool: 'read_project_context',
          tool: 'validate_proposal',
        },
        tool_calls: [proposalCall],
      },
      {
        content: 'Staged the edit.',
        reusable: true,
        match: {
          user_includes: 'STUB-PLAN',
          last_role: 'tool',
          last_tool: 'validate_proposal',
          tool: 'validate_proposal',
        },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        content: `Stub fallback reply ${index + 1}.`,
      })),
    ],
  };
}
