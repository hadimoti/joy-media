import { validateJoyCodeModelPlan } from '@joy-media/agent-tools';
import { JOY_CAPTION_TEMPLATES } from '@joy-media/captions-core';
import { TEXT_TEMPLATES } from '../text-template-catalog.js';

export function validateBrowserProposal(value: unknown) {
  const plan = value as { summary?: unknown; operations?: unknown } | null;
  const result = validateJoyCodeModelPlan(
    {
      schemaVersion: 1,
      goal: 'Requested edit',
      summary: plan?.summary,
      operations: plan?.operations,
      assumptions: [],
      blockedBy: [],
      requiresHumanDecision: [],
    },
    {
      textTemplateIds: TEXT_TEMPLATES.map((template) => template.id),
      captionTemplateIds: JOY_CAPTION_TEMPLATES.map((template) => template.id),
      transitionIds: ['dissolve', 'wipe', 'slide'],
    },
  );
  if (!result.valid || result.value.operations.length === 0)
    throw new Error('Provider returned invalid proposal operations');
  return { summary: result.value.summary.slice(0, 512), operations: result.value.operations };
}

export const BROWSER_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_project_context',
      description: 'Read the bounded project snapshot and supported catalogs.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_proposal',
      description:
        'Validate a proposed JOY edit. Does not apply or stage edits. Return the validated JSON as final content after validation succeeds.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          operations: { type: 'array', items: { type: 'object' }, maxItems: 24 },
        },
        required: ['summary', 'operations'],
        additionalProperties: false,
      },
    },
  },
] as const;

/** Explicit OpenAI-compatible exchange; four requests and eight tool calls maximum.
 * Only frozen context reads and typed validation are available, never mutations. */
export async function runBoundedToolExchange(
  initialMessages: readonly unknown[],
  context: unknown,
  request: (messages: readonly unknown[]) => Promise<string>,
): Promise<string> {
  const messages = [...initialMessages];
  let toolCount = 0;
  for (let step = 0; step < 4; step += 1) {
    const raw = await request(messages);
    const envelope = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
    };
    const message = envelope.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned invalid proposal response');
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return raw;
    if (step === 3 || toolCount + message.tool_calls.length > 8)
      throw new Error('Provider tool limit reached before a valid proposal');
    const calls = message.tool_calls as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    }[];
    for (const call of calls)
      if (
        typeof call.id !== 'string' ||
        call.id.length > 128 ||
        call.type !== 'function' ||
        typeof call.function?.arguments !== 'string' ||
        call.function.arguments.length > 65_536 ||
        !BROWSER_AGENT_TOOLS.some((tool) => tool.function.name === call.function?.name)
      )
        throw new Error('Provider returned invalid proposal tool');
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    for (const call of calls) {
      toolCount += 1;
      let result: unknown;
      try {
        const args = JSON.parse(call.function!.arguments as string);
        if (call.function!.name === 'read_project_context') {
          if (!args || Array.isArray(args) || Object.keys(args).length !== 0) throw new Error();
          result = {
            ok: true,
            context,
            catalogs: {
              text: TEXT_TEMPLATES.map((template) => template.id),
              captions: JOY_CAPTION_TEMPLATES.map((template) => template.id),
              transitions: ['dissolve', 'wipe', 'slide'],
            },
          };
        } else result = { ok: true, proposal: validateBrowserProposal(args) };
      } catch {
        result = { ok: false, code: 'JOY_AGENT_INVALID_PROPOSAL' };
      }
      const content = JSON.stringify(result);
      if (new TextEncoder().encode(content).byteLength > 65_536)
        throw new Error('Tool result too large');
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('Provider tool limit reached');
}
