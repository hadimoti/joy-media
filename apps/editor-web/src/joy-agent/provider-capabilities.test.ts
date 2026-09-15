import { describe, expect, it } from 'vitest';
import {
  PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN,
  PROVIDER_TOOL_PROBE_RESULT,
  PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
  assessProviderCapabilities,
  assessProviderMediaCapabilities,
  resolveProviderExecutionMode,
  type ProviderStructuredToolDefinition,
} from './provider-capabilities.js';

const emptyProbeTool: ProviderStructuredToolDefinition = {
  name: 'joy_probe',
  validateArguments(value) {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    );
  },
};

function providerResponse(message: Readonly<Record<string, unknown>>) {
  return { choices: [{ message }] };
}

function toolCall(
  id = 'probe-1',
  name = 'joy_probe',
  argumentsValue: unknown = {},
): Record<string, unknown> {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(argumentsValue) },
  };
}

function fullStructuredProbe(
  overrides: {
    readonly initialResponse?: unknown;
    readonly continuationRequest?: unknown;
    readonly continuationResponse?: unknown;
  } = {},
) {
  const initial = overrides.initialResponse ?? providerResponse({ tool_calls: [toolCall()] });
  return {
    structuredTool: {
      tool: emptyProbeTool,
      transcript: {
        initialResponse: initial,
        continuationRequest: overrides.continuationRequest ?? {
          messages: [
            { role: 'assistant', content: null, tool_calls: [toolCall()] },
            {
              role: 'tool',
              tool_call_id: 'probe-1',
              content: PROVIDER_TOOL_PROBE_RESULT,
            },
          ],
        },
        continuationResponse:
          overrides.continuationResponse ??
          providerResponse({ content: PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN }),
      },
    },
  };
}

describe('provider capability probes', () => {
  it('proves structured-tools only after the named call, schema-valid arguments, and linked continuation', () => {
    expect(assessProviderCapabilities(fullStructuredProbe())).toEqual({
      state: 'structured-tools',
      diagnostic: 'structured-tool-proven',
      proof: { kind: 'structured-tool-probe', toolName: 'joy_probe' },
    });
  });

  it('does not treat a nonempty tool-call array as a structured-tool capability proof', () => {
    expect(
      assessProviderCapabilities(
        fullStructuredProbe({
          continuationRequest: { messages: [] },
          continuationResponse: providerResponse({
            content: PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN,
          }),
        }),
      ),
    ).toEqual({
      state: 'unavailable',
      diagnostic: 'structured-tool-continuation-missing',
    });
  });

  it('fails closed for malformed evidence and a response that never completes the continuation', () => {
    expect(assessProviderCapabilities(null as never)).toEqual({
      state: 'unavailable',
      diagnostic: 'provider-probe-missing',
    });
    expect(
      assessProviderCapabilities(
        fullStructuredProbe({
          continuationResponse: providerResponse({ content: 'I called the tool.' }),
        }),
      ),
    ).toEqual({
      state: 'unavailable',
      diagnostic: 'structured-tool-continuation-invalid',
    });
    expect(
      assessProviderCapabilities(
        fullStructuredProbe({
          initialResponse: providerResponse({ role: 'tool', tool_calls: [toolCall()] }),
        }),
      ),
    ).toEqual({
      state: 'unavailable',
      diagnostic: 'structured-tool-response-invalid',
    });
  });

  it('rejects a wrong tool name, invalid arguments, and an unlinked tool result', () => {
    expect(
      assessProviderCapabilities(
        fullStructuredProbe({
          initialResponse: providerResponse({ tool_calls: [toolCall('probe-1', 'other')] }),
        }),
      ),
    ).toMatchObject({ state: 'unavailable', diagnostic: 'structured-tool-name-mismatch' });

    expect(
      assessProviderCapabilities(
        fullStructuredProbe({
          initialResponse: providerResponse({
            tool_calls: [toolCall('probe-1', 'joy_probe', { extra: true })],
          }),
        }),
      ),
    ).toMatchObject({ state: 'unavailable', diagnostic: 'structured-tool-arguments-invalid' });

    expect(
      assessProviderCapabilities(
        fullStructuredProbe({
          continuationRequest: {
            messages: [
              { role: 'assistant', content: null, tool_calls: [toolCall()] },
              {
                role: 'tool',
                tool_call_id: 'different-call',
                content: PROVIDER_TOOL_PROBE_RESULT,
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ state: 'unavailable', diagnostic: 'structured-tool-continuation-missing' });
  });

  it('uses a separately-proven text response for plan-only and never lets policy upgrade a provider', () => {
    const planOnly = assessProviderCapabilities({
      structuredTool: {
        tool: emptyProbeTool,
        transcript: {
          initialResponse: providerResponse({ content: 'I cannot call a tool.' }),
          continuationRequest: { messages: [] },
          continuationResponse: providerResponse({ content: 'ignored' }),
        },
      },
      planOnly: { response: providerResponse({ content: 'A bounded edit plan.' }) },
    });

    expect(planOnly).toEqual({ state: 'plan-only', diagnostic: 'plan-only-proven' });
    expect(resolveProviderExecutionMode('structured-tools', 'plan-only')).toBe('plan-only');
    expect(resolveProviderExecutionMode('structured-tools', 'prefer-structured-tools')).toBe(
      'structured-tools',
    );
    expect(resolveProviderExecutionMode('unavailable', 'prefer-structured-tools')).toBe(
      'unavailable',
    );
  });

  it('keeps raw BYOK and provider transcript data out of its durable-looking assessment', () => {
    const apiKey = 'sk-owner-secret-must-not-appear';
    const endpoint = 'https://private-provider.example/v1';
    const probe = fullStructuredProbe({
      initialResponse: {
        ...providerResponse({ tool_calls: [toolCall()] }),
        apiKey,
      },
      continuationRequest: {
        endpoint,
        authorization: `Bearer ${apiKey}`,
        messages: [
          { role: 'assistant', content: null, tool_calls: [toolCall()] },
          { role: 'tool', tool_call_id: 'probe-1', content: PROVIDER_TOOL_PROBE_RESULT },
        ],
      },
      continuationResponse: providerResponse({
        content: PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN,
        raw_response: apiKey,
      }),
    });
    const before = JSON.stringify(probe);

    const assessment = assessProviderCapabilities(probe);

    expect(assessment.state).toBe('structured-tools');
    expect(JSON.stringify(assessment)).not.toContain(apiKey);
    expect(JSON.stringify(assessment)).not.toContain(endpoint);
    expect(assessment).not.toHaveProperty('transcript');
    expect(JSON.stringify(probe)).toBe(before);
  });

  it('records synthetic media modality support independently without upgrading tool capability', () => {
    const assessment = assessProviderMediaCapabilities({
      image: {
        response: providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
        }),
      },
      audio: {
        response: providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
        }),
      },
      video: {
        response: providerResponse({ role: 'assistant', content: 'I cannot inspect video.' }),
      },
    });

    expect(assessment).toEqual({
      image: 'supported',
      audio: 'supported',
      video: 'unavailable',
      modalities: ['image', 'audio'],
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.modalities)).toBe(true);
  });

  it('fails closed for malformed or hostile media responses and redacts their input', () => {
    const apiKey = 'sk-owner-secret-must-not-appear';
    const endpoint = 'https://private-provider.example/v1';
    const probe = {
      image: {
        response: providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
          tool_calls: [],
          apiKey,
        }),
      },
      audio: {
        response: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: `${PROVIDER_MEDIA_CAPABILITY_PROBE_ACK}\n${endpoint}`,
              },
            },
          ],
        },
      },
      video: { response: { choices: [] } },
    };
    const before = JSON.stringify(probe);

    const assessment = assessProviderMediaCapabilities(probe);

    expect(assessment).toEqual({
      image: 'unavailable',
      audio: 'unavailable',
      video: 'unavailable',
      modalities: [],
    });
    expect(JSON.stringify(assessment)).not.toContain(apiKey);
    expect(JSON.stringify(assessment)).not.toContain(endpoint);
    expect(assessment).not.toHaveProperty('response');
    expect(JSON.stringify(probe)).toBe(before);
  });
});
