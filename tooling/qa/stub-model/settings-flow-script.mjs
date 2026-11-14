/**
 * The response script for the T-A11 settings flow (D-087 to D-091).
 *
 * Responses are picked by the shape of the request (`match`), so the order of the app's own
 * probe calls cannot shift the script. The probe tokens are the constants of
 * `apps/editor-web/src/joy-agent/provider-capabilities.ts`.
 *
 * Marker words the flow types into Joy Code: STUB-HELLO (plain reply), STUB-PLAN (one scripted
 * `propose_timeline_operations` call, then a closing line), STUB-SLOW (a reply held for five
 * seconds, so a run can be cancelled), STUB-IMAGE (a reply to a request that carries an image).
 */

export const STUB_MODEL = 'joy-stub-model';

const TOOL_PROBE_CONTINUATION_TOKEN = 'JOY_PROVIDER_PROBE_CONTINUED_V1';
const MEDIA_PROBE_ACK = 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1';

/**
 * The default operation of a STUB-PLAN turn. It is the insert the CLI matrix uses
 * (`tooling/qa/cli/run-cli-matrix.mjs`); a live run whose project has other ids passes its own.
 */
export const DEFAULT_PLAN_OPERATIONS = Object.freeze([
  Object.freeze({
    kind: 'insert',
    id: 'agent-intro',
    assetId: 'asset-sample-video',
    trackId: 'track-v1',
    startUs: 0,
    durationUs: 2_000_000,
    dependsOn: Object.freeze([]),
  }),
]);

export function buildSettingsFlowScript({
  model = STUB_MODEL,
  planOperations = DEFAULT_PLAN_OPERATIONS,
} = {}) {
  const planCall = {
    id: 'call-stub-plan',
    type: 'function',
    function: {
      name: 'propose_timeline_operations',
      arguments: JSON.stringify({ operations: planOperations }),
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
      { content: MEDIA_PROBE_ACK, reusable: true, match: { user_includes: 'capability test' } },
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
        match: { user_includes: 'STUB-PLAN', last_role: 'user' },
        tool_calls: [planCall],
      },
      {
        content: 'Staged the edit.',
        reusable: true,
        match: { last_role: 'tool', tool: 'propose_timeline_operations' },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        content: `Stub fallback reply ${index + 1}.`,
      })),
    ],
  };
}
