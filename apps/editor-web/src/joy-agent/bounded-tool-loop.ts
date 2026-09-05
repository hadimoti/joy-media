import { validateJoyCodeModelPlan } from '@joy-media/agent-tools';
import { JOY_CAPTION_TEMPLATES } from '@joy-media/captions-core';
import { TEXT_TEMPLATES } from '../text-template-catalog.js';
import type { JoyAgentContextSnapshot } from './context-snapshot.js';

export type BrowserProposal = ReturnType<typeof validateBrowserProposal>;

/** Snapshot checks are conservative; the canonical compiler remains the apply gate. */
function validateProjectReferences(
  proposal: BrowserProposal,
  context: JoyAgentContextSnapshot,
): void {
  const clips = new Map(context.clips.map((clip) => [clip.id, { ...clip }]));
  const tracks = new Set(context.trackIds ?? context.clips.map((clip) => clip.trackId));
  const assets = new Set(context.assets.map((asset) => asset.id));
  for (const operation of proposal.operations) {
    if ('compositionId' in operation && operation.compositionId !== context.compositionId)
      throw new Error('JOY_AGENT_UNKNOWN_COMPOSITION');
    if ('clipId' in operation) {
      const clip = clips.get(operation.clipId);
      if (!clip) throw new Error('JOY_AGENT_UNKNOWN_CLIP');
      const trackId = 'sourceTrackId' in operation ? operation.sourceTrackId : operation.trackId;
      if (clip.trackId !== trackId) throw new Error('JOY_AGENT_CLIP_TRACK_MISMATCH');
      if (
        operation.kind === 'timeline.splitClip' &&
        (operation.atUs <= clip.startUs || operation.atUs >= clip.startUs + clip.durationUs)
      )
        throw new Error('JOY_AGENT_SPLIT_OUTSIDE_CLIP');
      if (operation.kind === 'timeline.trimClip') {
        if (
          operation.newStartUs < clip.startUs ||
          operation.newEndUs > clip.startUs + clip.durationUs
        )
          throw new Error('JOY_AGENT_TRIM_OUTSIDE_CLIP');
        clip.startUs = operation.newStartUs;
        clip.durationUs = operation.newEndUs - operation.newStartUs;
      }
      if (operation.kind === 'timeline.removeClip') clips.delete(operation.clipId);
      if (operation.kind === 'timeline.moveClip') {
        clip.trackId = operation.targetTrackId;
        clip.startUs = operation.newStartUs;
      }
    }
    if ('targetTrackId' in operation && !tracks.has(operation.targetTrackId))
      throw new Error('JOY_AGENT_UNKNOWN_TRACK');
    if ('assetId' in operation && !assets.has(operation.assetId))
      throw new Error('JOY_AGENT_UNKNOWN_ASSET');
    if (
      'outgoingClipId' in operation &&
      (!clips.has(operation.outgoingClipId) || !clips.has(operation.incomingClipId))
    )
      throw new Error('JOY_AGENT_UNKNOWN_CLIP');
  }
}

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
        'Validate typed JOY operations against the snapshot and stage a candidate in this run. Nothing is applied. Read context first; repair any returned error; after success return exactly the staged proposal JSON as final content.',
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
  options: {
    readonly signal?: AbortSignal;
    readonly onStaged?: (proposal: BrowserProposal) => void;
  } = {},
): Promise<string> {
  const messages = [...initialMessages];
  // Detach from caller-owned objects so a subsequent user edit cannot change this run.
  const snapshot = JSON.parse(JSON.stringify(context)) as JoyAgentContextSnapshot;
  if (!snapshot || !Array.isArray(snapshot.clips) || !Array.isArray(snapshot.assets))
    throw new Error('Provider proposal context is invalid');
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 60_000)
    throw new Error('Provider proposal context is too large');
  let toolCount = 0;
  let contextRead = false;
  let contextReadStep = -1;
  let staged: BrowserProposal | undefined;
  const callIds = new Set<string>();
  for (let step = 0; step < 4; step += 1) {
    options.signal?.throwIfAborted();
    const raw = await request(messages);
    options.signal?.throwIfAborted();
    const envelope = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
    };
    const message = envelope.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned invalid proposal response');
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      if (!contextRead || staged === undefined || typeof message.content !== 'string')
        throw new Error('Provider returned a proposal before context inspection and staging');
      const final = validateBrowserProposal(JSON.parse(message.content));
      if (JSON.stringify(final) !== JSON.stringify(staged))
        throw new Error('Provider final proposal differs from the staged operations');
      return raw;
    }
    if (step === 3 || toolCount + message.tool_calls.length > 8)
      throw new Error('Provider tool limit reached before a valid proposal');
    const calls = message.tool_calls as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    }[];
    for (const call of calls) {
      if (
        !call ||
        typeof call.id !== 'string' ||
        call.id.length === 0 ||
        callIds.has(call.id) ||
        call.id.length > 128 ||
        call.type !== 'function' ||
        typeof call.function?.arguments !== 'string' ||
        call.function.arguments.length > 65_536 ||
        !BROWSER_AGENT_TOOLS.some((tool) => tool.function.name === call.function?.name)
      )
        throw new Error('Provider returned invalid proposal tool');
      callIds.add(call.id);
    }
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    for (const call of calls) {
      toolCount += 1;
      let result: unknown;
      try {
        const args = JSON.parse(call.function!.arguments as string);
        if (call.function!.name === 'read_project_context') {
          if (!args || Array.isArray(args) || Object.keys(args).length !== 0) throw new Error();
          if (!contextRead) contextReadStep = step;
          contextRead = true;
          result = {
            ok: true,
            context: snapshot,
            catalogs: {
              text: TEXT_TEMPLATES.map((template) => template.id),
              captions: JOY_CAPTION_TEMPLATES.map((template) => template.id),
              transitions: ['dissolve', 'wipe', 'slide'],
            },
          };
        } else {
          staged = undefined;
          if (!contextRead || contextReadStep === step)
            throw new Error('JOY_AGENT_CONTEXT_REQUIRED');
          const proposal = validateBrowserProposal(args);
          validateProjectReferences(proposal, snapshot);
          staged = proposal;
          options.onStaged?.(proposal);
          result = {
            ok: true,
            staged: true,
            applied: false,
            baseRevision: snapshot.revision,
            proposal,
          };
        }
      } catch (error) {
        // Only product-owned error codes cross back into the model transcript.
        const code =
          error instanceof Error && /^JOY_AGENT_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'JOY_AGENT_INVALID_PROPOSAL';
        result = { ok: false, code, repairable: true, applied: false };
      }
      const content = JSON.stringify(result);
      if (new TextEncoder().encode(content).byteLength > 65_536)
        throw new Error('Tool result too large');
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('Provider tool limit reached');
}
