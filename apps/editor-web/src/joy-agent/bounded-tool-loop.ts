import {
  createModelVisibleJoyCodeProposalParameters,
  listModelVisibleJoyCodeOperationKinds,
  validateJoyCodeModelPlan,
} from '@joy-media/agent-tools';
import { JOY_CAPTION_TEMPLATES } from '@joy-media/captions-core';
import { TEXT_TEMPLATES } from '../text-template-catalog.js';
import { HostRpcError, type HostRpcJson } from './host-rpc.js';
import { MAX_JOY_AGENT_RUN_BUDGET_V1 } from './run-budget.js';
import { isJoyAgentHostToolName, type JoyAgentHostToolName } from './host-tool-contract.js';

export { JOY_AGENT_HOST_TOOL_NAMES } from './host-tool-contract.js';
export type { JoyAgentHostToolName } from './host-tool-contract.js';

export type BrowserProposal = ReturnType<typeof validateBrowserProposal>;

export interface BrowserPreparedProposal {
  readonly summary: string;
  readonly baseRevision: string;
  readonly changeSetId: string;
  readonly operationDigest: string;
  readonly bindingDigest: string;
  readonly operationCount: number;
}

export type BrowserToolExchangeOutcome =
  | { readonly kind: 'prepared'; readonly proposal: BrowserPreparedProposal }
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'clarification'; readonly question: string };

/** Alias retained for callers which describe the Worker-facing host boundary. */
export type BrowserAgentHostToolName = JoyAgentHostToolName;

export interface BrowserAgentToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: JoyAgentHostToolName;
    readonly description: string;
    /** OpenAI-compatible strict tool definitions set this when all fields are required. */
    readonly strict?: true;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/** A frozen pair so a caller can give the provider and parser the same allowlist. */
export interface BrowserAgentToolCatalog {
  readonly allowedToolNames: readonly JoyAgentHostToolName[];
  readonly tools: readonly BrowserAgentToolDefinition[];
}

export type BrowserAgentHostCall = (
  method: JoyAgentHostToolName,
  args: HostRpcJson,
) => Promise<HostRpcJson>;

/**
 * This only bounds malformed provider transcript iteration. Four tool-bearing
 * exchanges are needed by an observation-backed edit (overview, assets,
 * bounded observation, then canonical validation); the fifth exchange is
 * reserved for a non-tool response and therefore rejects tool calls. It is
 * deliberately separate from the execution budget: each actual tool call is
 * charged to the versioned run budget supplied by the Worker below.
 */
const MAX_PARSER_MODEL_EXCHANGES = 5;
const DEFAULT_MAX_TOOL_CALLS = MAX_JOY_AGENT_RUN_BUDGET_V1.maxToolSteps;
const MAX_TOOL_RESULT_BYTES = 65_536;
const MAX_MODEL_ANSWER_CHARS = 8_192;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const MAX_OBSERVATION_RANGE_US = 6 * 60 * 60 * 1_000_000;
const MAX_OBSERVATION_TIME_US = Number.MAX_SAFE_INTEGER - MAX_OBSERVATION_RANGE_US;
const MAX_OBSERVATION_FRAMES = 512;
const MAX_OBSERVATION_METADATA_BYTES = 32 * 1024;
const MAX_OBSERVATION_PAGE_SIZE = 128;
const MAX_OBSERVATION_CURSOR = 2_097_152;
const SAFE_OBSERVATION_IDENTIFIER_PATTERN =
  '^[A-Za-z0-9][A-Za-z0-9._:@=-]*(?:/[A-Za-z0-9][A-Za-z0-9._:@=-]*)*$';

const DEFAULT_BROWSER_AGENT_ALLOWED_TOOL_NAMES = Object.freeze([
  'read_project_context',
  'validate_proposal',
] as const satisfies readonly JoyAgentHostToolName[]);
const READ_ONLY_BROWSER_AGENT_ALLOWED_TOOL_NAMES = Object.freeze([
  'read_project_context',
] as const satisfies readonly JoyAgentHostToolName[]);

function validateAllowedToolNames(
  value: readonly JoyAgentHostToolName[] | undefined,
  defaultValue: readonly JoyAgentHostToolName[],
): readonly JoyAgentHostToolName[] {
  if (value !== undefined && !Array.isArray(value))
    throw new Error('JOY_AGENT_INVALID_ALLOWED_TOOLS');
  const names = value === undefined ? [...defaultValue] : [...value];
  const seen = new Set<JoyAgentHostToolName>();
  for (const name of names) {
    if (!isJoyAgentHostToolName(name) || seen.has(name))
      throw new Error('JOY_AGENT_INVALID_ALLOWED_TOOLS');
    seen.add(name);
  }
  if (names.some((name) => name !== 'read_project_context') && !seen.has('read_project_context'))
    throw new Error('JOY_AGENT_ALLOWED_TOOLS_REQUIRE_READ_PROJECT_CONTEXT');
  return Object.freeze(names);
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
      allowedOperationKinds: listModelVisibleJoyCodeOperationKinds(),
      textTemplateIds: TEXT_TEMPLATES.map((template) => template.id),
      captionTemplateIds: JOY_CAPTION_TEMPLATES.map((template) => template.id),
      transitionIds: ['dissolve', 'wipe', 'slide'],
    },
  );
  if (!result.valid || result.value.operations.length === 0)
    throw new Error('Provider returned invalid proposal operations');
  return { summary: result.value.summary.slice(0, 512), operations: result.value.operations };
}

const READ_PROJECT_CONTEXT_TOOL: BrowserAgentToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'read_project_context',
    description:
      'Read one frozen, paged project context domain. Use overview first; then query tracks, clips, assets, visual-objects, titles, looks, or the attached Creative Brief with a cursor and optional query. The looks domain lists the reopened project’s applied Living Look instances — instance id, pinned pack id + version, entity bindings, missing/orphaned targets, hand-edited overrides — which is how you discover what look_update / look_reset_overrides / look_detach must target when there is no prior chat context. overview reports lookInstanceCount and orphanedLookInstanceCount.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: [
            'overview',
            'brief',
            'tracks',
            'clips',
            'assets',
            'visual-objects',
            'titles',
            'looks',
          ],
        },
        cursor: { type: 'integer', minimum: 0 },
        pageSize: { type: 'integer', minimum: 1, maximum: 32 },
        query: { type: 'string', maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
};

function createValidateProposalTool(
  parameters: NonNullable<ReturnType<typeof createModelVisibleJoyCodeProposalParameters>>,
): BrowserAgentToolDefinition {
  return {
    type: 'function' as const,
    function: {
      name: 'validate_proposal',
      description:
        'Send typed JOY operations to the trusted canonical compiler. The compiler can return structured repair diagnostics. A successful call creates an immutable preview only; it never applies edits.',
      parameters: parameters as unknown as Readonly<Record<string, unknown>>,
    },
  };
}

const MEDIA_DESCRIBE_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'media_describe',
    description:
      'Read bounded, metadata-only facts for one project asset. It never returns a URL, local path, Blob, bytes, or provider credential.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId'],
      properties: {
        assetId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: SAFE_OBSERVATION_IDENTIFIER_PATTERN,
        },
      },
    },
  },
};

const MEDIA_OBSERVE_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'media_observe',
    description:
      'Request bounded local sampling metadata for one asset range. This does not upload media or assert model comprehension.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId', 'range', 'mode', 'maxFrames', 'maxMetadataBytes'],
      properties: {
        assetId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: SAFE_OBSERVATION_IDENTIFIER_PATTERN,
        },
        range: {
          type: 'object',
          additionalProperties: false,
          required: ['startUs', 'endUs'],
          properties: {
            startUs: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_TIME_US },
            endUs: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_TIME_US },
          },
        },
        mode: { type: 'string', enum: ['overview', 'focus', 'exhaustive'] },
        maxFrames: { type: 'integer', minimum: 1, maximum: MAX_OBSERVATION_FRAMES },
        maxMetadataBytes: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_OBSERVATION_METADATA_BYTES,
        },
      },
    },
  },
};

const MEDIA_FRAMES_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'media_frames',
    description:
      'Read one bounded metadata page from an existing observation. It never returns frame pixels, blobs, URLs, or paths.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['observationId', 'cursor', 'pageSize'],
      properties: {
        observationId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: SAFE_OBSERVATION_IDENTIFIER_PATTERN,
        },
        cursor: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_CURSOR },
        pageSize: { type: 'integer', minimum: 1, maximum: MAX_OBSERVATION_PAGE_SIZE },
      },
    },
  },
};

const MEDIA_TRANSCRIPT_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'media_transcript',
    description:
      'Read bounded timestamp and speaker metadata for a transcript range. Transcript word text is intentionally not returned.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId', 'range', 'cursor', 'pageSize'],
      properties: {
        assetId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: SAFE_OBSERVATION_IDENTIFIER_PATTERN,
        },
        range: {
          type: 'object',
          additionalProperties: false,
          required: ['startUs', 'endUs'],
          properties: {
            startUs: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_TIME_US },
            endUs: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_TIME_US },
          },
        },
        cursor: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_CURSOR },
        pageSize: { type: 'integer', minimum: 1, maximum: MAX_OBSERVATION_PAGE_SIZE },
      },
    },
  },
};

const EVIDENCE_READ_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'evidence_read',
    description:
      'Read one bounded manifest coverage page for locally generated evidence. This reports coverage only, not media data.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['manifestId', 'pageIndex'],
      properties: {
        manifestId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: SAFE_OBSERVATION_IDENTIFIER_PATTERN,
        },
        pageIndex: { type: 'integer', minimum: 0, maximum: MAX_OBSERVATION_CURSOR },
      },
    },
  },
};

const EVIDENCE_COVERAGE_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'evidence_coverage',
    description:
      'Read aggregate coverage facts for one evidence manifest. It cannot clear, mutate, or export evidence.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['manifestId'],
      properties: {
        manifestId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: SAFE_OBSERVATION_IDENTIFIER_PATTERN,
        },
      },
    },
  },
};

type ObservationToolName =
  | 'media_describe'
  | 'media_observe'
  | 'media_frames'
  | 'media_transcript'
  | 'evidence_read'
  | 'evidence_coverage';

const OBSERVATION_TOOLS: Readonly<Record<ObservationToolName, BrowserAgentToolDefinition>> = {
  media_describe: MEDIA_DESCRIBE_TOOL,
  media_observe: MEDIA_OBSERVE_TOOL,
  media_frames: MEDIA_FRAMES_TOOL,
  media_transcript: MEDIA_TRANSCRIPT_TOOL,
  evidence_read: EVIDENCE_READ_TOOL,
  evidence_coverage: EVIDENCE_COVERAGE_TOOL,
};

/**
 * Living Look intent tools (R2 / GAP 5). Deterministic host tools: the model
 * names which pack / instance / controls it wants; the trusted host compiles
 * the exact Look plan, stages a reversible preview and returns opaque
 * identities. A successful call is terminal for the turn (like
 * `validate_proposal`) and applies nothing — the operator approves the staged
 * change through the same approval card and Undo as any other agent edit. The
 * ids are pattern-bounded here; the host validates that the pack / instance
 * actually exists and that the control values fit the definition, returning a
 * repairable diagnostic when they do not.
 */
const LOOK_ID_PATTERN = '^[a-z][a-z0-9-]{1,63}$';
const LOOK_INSTANCE_ID_PATTERN = '^look-[A-Za-z0-9][A-Za-z0-9-]{7,64}$';
const LOOK_BINDING_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const LOOK_SLOT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$';
const LOOK_CONTROL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$';
const LOOK_ENTITY_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';

const LOOK_CONTROL_VALUE_SCHEMA = {
  type: 'object',
  description: 'controlId -> value. Values are bounded by the definition control kind.',
  additionalProperties: {
    anyOf: [{ type: 'number' }, { type: 'string', maxLength: 120 }, { type: 'boolean' }],
  },
  propertyNames: { pattern: LOOK_CONTROL_ID_PATTERN },
  maxProperties: 32,
} as const;

const LOOK_ENTITY_BINDINGS_SCHEMA = {
  type: 'object',
  description: 'slotId -> existing visual object id.',
  additionalProperties: { type: 'string', pattern: LOOK_ENTITY_ID_PATTERN },
  propertyNames: { pattern: LOOK_SLOT_ID_PATTERN },
  maxProperties: 32,
} as const;

const LOOK_APPLY_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'look_apply',
    description:
      'Apply one built-in Living Look to the root composition. The host compiles it deterministically and stages a reversible preview for operator approval; it never applies the edit itself.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['definitionId', 'entityBindings', 'controlValues'],
      properties: {
        definitionId: { type: 'string', pattern: LOOK_ID_PATTERN, maxLength: 64 },
        entityBindings: LOOK_ENTITY_BINDINGS_SCHEMA,
        controlValues: LOOK_CONTROL_VALUE_SCHEMA,
      },
    },
  },
};

const LOOK_UPDATE_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'look_update',
    description:
      'Adjust an already-applied Living Look instance: change its control values and/or its entity bindings. Get the instanceId (and its current control values / bindings / overrides) from read_project_context domain=looks. The host recompiles the pinned definition and stages a reversible preview for approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['instanceId'],
      properties: {
        instanceId: { type: 'string', pattern: LOOK_INSTANCE_ID_PATTERN, maxLength: 80 },
        nextControlValues: LOOK_CONTROL_VALUE_SCHEMA,
        nextEntityBindings: LOOK_ENTITY_BINDINGS_SCHEMA,
      },
    },
  },
};

const LOOK_RESET_OVERRIDES_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'look_reset_overrides',
    description:
      'Put hand-edited bindings of a Living Look instance back under Look control, then recompile. Get the instanceId and its overriddenBindingIds from read_project_context domain=looks. Stages a reversible preview for approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['instanceId', 'bindingIds'],
      properties: {
        instanceId: { type: 'string', pattern: LOOK_INSTANCE_ID_PATTERN, maxLength: 80 },
        bindingIds: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: { type: 'string', pattern: LOOK_BINDING_ID_PATTERN },
        },
      },
    },
  },
};

const LOOK_DETACH_TOOL: BrowserAgentToolDefinition = {
  type: 'function',
  function: {
    name: 'look_detach',
    description:
      'Detach a Living Look instance: drop the reopenable Look record and leave its authored keyframes as ordinary editable animation. Get the instanceId from read_project_context domain=looks. Stages a reversible change (no visual diff) for operator approval — an agent detach is never auto-applied.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['instanceId'],
      properties: {
        instanceId: { type: 'string', pattern: LOOK_INSTANCE_ID_PATTERN, maxLength: 80 },
      },
    },
  },
};

const LOOK_TOOLS: Readonly<
  Record<
    'look_apply' | 'look_update' | 'look_reset_overrides' | 'look_detach',
    BrowserAgentToolDefinition
  >
> = {
  look_apply: LOOK_APPLY_TOOL,
  look_update: LOOK_UPDATE_TOOL,
  look_reset_overrides: LOOK_RESET_OVERRIDES_TOOL,
  look_detach: LOOK_DETACH_TOOL,
};

const LOOK_TOOL_NAME_SET: ReadonlySet<JoyAgentHostToolName> = new Set(
  Object.keys(LOOK_TOOLS) as (keyof typeof LOOK_TOOLS)[],
);

/** True for the deterministic Look intent tools that are terminal on success. */
export function isLookIntentToolName(name: JoyAgentHostToolName): boolean {
  return LOOK_TOOL_NAME_SET.has(name);
}

function toolDefinitionFor(
  name: JoyAgentHostToolName,
  proposalParameters: ReturnType<typeof createModelVisibleJoyCodeProposalParameters>,
): BrowserAgentToolDefinition {
  if (name === 'read_project_context') return READ_PROJECT_CONTEXT_TOOL;
  if (name === 'validate_proposal') {
    if (proposalParameters === undefined)
      throw new Error('JOY_AGENT_VALIDATE_PROPOSAL_REQUIRES_SCHEMA');
    return createValidateProposalTool(proposalParameters);
  }
  if (LOOK_TOOL_NAME_SET.has(name)) return LOOK_TOOLS[name as keyof typeof LOOK_TOOLS];
  return OBSERVATION_TOOLS[name as ObservationToolName];
}

/**
 * Creates the exact tool subset a trusted host approved for one run. With no
 * explicit list it preserves the old inspect + prepare catalog (or inspect
 * only while no verified proposal schema exists); observation tools are never
 * implicitly advertised.
 */
export function createBrowserAgentToolCatalog(
  proposalParameters: ReturnType<typeof createModelVisibleJoyCodeProposalParameters>,
  allowedToolNames?: readonly JoyAgentHostToolName[],
): BrowserAgentToolCatalog {
  const defaultToolNames =
    proposalParameters === undefined
      ? READ_ONLY_BROWSER_AGENT_ALLOWED_TOOL_NAMES
      : DEFAULT_BROWSER_AGENT_ALLOWED_TOOL_NAMES;
  const allowed = validateAllowedToolNames(allowedToolNames, defaultToolNames);
  if (allowed.includes('validate_proposal') && proposalParameters === undefined)
    throw new Error('JOY_AGENT_VALIDATE_PROPOSAL_REQUIRES_SCHEMA');
  return Object.freeze({
    allowedToolNames: allowed,
    tools: Object.freeze(allowed.map((name) => toolDefinitionFor(name, proposalParameters))),
  });
}

/** With no verified operation schema, the model can inspect but cannot propose. */
export function createBrowserAgentTools(
  proposalParameters: ReturnType<typeof createModelVisibleJoyCodeProposalParameters>,
  allowedToolNames?: readonly JoyAgentHostToolName[],
): readonly BrowserAgentToolDefinition[] {
  return createBrowserAgentToolCatalog(proposalParameters, allowedToolNames).tools;
}

export const BROWSER_AGENT_TOOLS = createBrowserAgentTools(
  createModelVisibleJoyCodeProposalParameters(),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_TOOL_RESULT_BYTES
  )
    throw new Error('Tool result too large');
  return serialized;
}

interface BrowserRepairResult {
  readonly ok: false;
  readonly code: string;
  readonly repairable: boolean;
  readonly applied: false;
  readonly operation?: string;
  readonly field?: string;
  readonly facts?: Readonly<Record<string, string | number | boolean>>;
}

function repairResult(error: unknown): BrowserRepairResult {
  if (error instanceof HostRpcError) {
    return {
      ok: false,
      code: error.diagnostic.code,
      repairable: error.diagnostic.retryable,
      ...(error.diagnostic.operation === undefined
        ? {}
        : { operation: error.diagnostic.operation }),
      ...(error.diagnostic.field === undefined ? {} : { field: error.diagnostic.field }),
      ...(error.diagnostic.facts === undefined ? {} : { facts: error.diagnostic.facts }),
      applied: false,
    };
  }
  const code =
    error instanceof Error && /^JOY_AGENT_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'JOY_AGENT_INVALID_PROPOSAL';
  return { ok: false, code, repairable: true, applied: false };
}

function parsePreparedProposal(value: HostRpcJson): BrowserPreparedProposal {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    typeof value.summary !== 'string' ||
    value.summary.length > 512 ||
    typeof value.baseRevision !== 'string' ||
    value.baseRevision.length > 256 ||
    typeof value.changeSetId !== 'string' ||
    !OPAQUE_ID.test(value.changeSetId) ||
    typeof value.operationDigest !== 'string' ||
    !SHA_256.test(value.operationDigest) ||
    typeof value.bindingDigest !== 'string' ||
    !SHA_256.test(value.bindingDigest) ||
    typeof value.operationCount !== 'number' ||
    !Number.isSafeInteger(value.operationCount) ||
    value.operationCount < 1 ||
    value.operationCount > 32
  )
    throw new Error('JOY_AGENT_INVALID_PROPOSAL');
  return {
    summary: value.summary,
    baseRevision: value.baseRevision,
    changeSetId: value.changeSetId,
    operationDigest: value.operationDigest,
    bindingDigest: value.bindingDigest,
    operationCount: value.operationCount,
  };
}

function parseNonMutatingAnswer(content: unknown): BrowserToolExchangeOutcome {
  if (
    typeof content !== 'string' ||
    content.trim().length === 0 ||
    content.length > MAX_MODEL_ANSWER_CHARS
  )
    throw new Error('Provider returned invalid response');
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const candidate = JSON.parse(text) as {
      operations?: unknown;
      question?: unknown;
      summary?: unknown;
    };
    if (Array.isArray(candidate.operations) && candidate.operations.length > 0)
      throw new Error('Provider returned a proposal before canonical preparation');
    if (typeof candidate.question === 'string' && candidate.question.trim().length > 0)
      return {
        kind: 'clarification',
        question: candidate.question.trim().slice(0, MAX_MODEL_ANSWER_CHARS),
      };
    if (typeof candidate.summary === 'string' && candidate.summary.trim().length > 0)
      return { kind: 'answer', text: candidate.summary.trim().slice(0, MAX_MODEL_ANSWER_CHARS) };
  } catch (error) {
    if (error instanceof Error && /canonical preparation/.test(error.message)) throw error;
  }
  return { kind: 'answer', text };
}

/**
 * Bounded OpenAI-compatible exchange. All project reads and preparation go
 * through `callHost`; the Worker never receives a project object, compiler,
 * writer, or storage handle. A successful prepare is terminal for this model
 * turn, so a later provider message cannot replace an approved preview.
 */
export async function runBoundedToolExchange(
  initialMessages: readonly unknown[],
  request: (messages: readonly unknown[]) => Promise<string>,
  callHost: BrowserAgentHostCall,
  options: {
    readonly signal?: AbortSignal;
    /** The Worker passes its parsed V1 run budget; callers cannot expand it. */
    readonly maxToolCalls?: number;
    /**
     * Exact host-approved subset for this exchange. Pass the same list to
     * `createBrowserAgentToolCatalog` when preparing the provider request.
     */
    readonly allowedToolNames?: readonly JoyAgentHostToolName[];
    readonly onToolCall?: (name: JoyAgentHostToolName) => void;
    readonly onRepairAttempt?: () => void;
  } = {},
): Promise<BrowserToolExchangeOutcome> {
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  if (
    !Number.isSafeInteger(maxToolCalls) ||
    maxToolCalls < 0 ||
    maxToolCalls > MAX_JOY_AGENT_RUN_BUDGET_V1.maxToolSteps
  )
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  const allowedToolNames = validateAllowedToolNames(
    options.allowedToolNames,
    DEFAULT_BROWSER_AGENT_ALLOWED_TOOL_NAMES,
  );
  const allowedToolNameSet = new Set(allowedToolNames);
  const messages = [...initialMessages];
  let toolCount = 0;
  let contextRead = false;
  let contextReadStep = -1;
  const callIds = new Set<string>();
  for (let step = 0; step < MAX_PARSER_MODEL_EXCHANGES; step += 1) {
    options.signal?.throwIfAborted();
    const raw = await request(messages);
    options.signal?.throwIfAborted();
    const envelope = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
    };
    const message = envelope.choices?.[0]?.message;
    if (message === undefined) throw new Error('Provider returned invalid response');
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
      return parseNonMutatingAnswer(message.content);
    if (
      step === MAX_PARSER_MODEL_EXCHANGES - 1 ||
      toolCount + message.tool_calls.length > maxToolCalls
    )
      throw new Error('Provider tool limit reached before a valid result');
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
        call.id.length > 128 ||
        callIds.has(call.id) ||
        call.type !== 'function' ||
        typeof call.function?.arguments !== 'string' ||
        call.function.arguments.length > MAX_TOOL_RESULT_BYTES ||
        !isJoyAgentHostToolName(call.function.name) ||
        !allowedToolNameSet.has(call.function.name)
      )
        throw new Error('Provider returned invalid proposal tool');
      callIds.add(call.id);
    }
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function!.name as JoyAgentHostToolName;
      toolCount += 1;
      options.onToolCall?.(name);
      let result: HostRpcJson;
      try {
        // Stop the batch immediately on cancellation rather than issuing more
        // host RPC calls the caller no longer wants.
        options.signal?.throwIfAborted();
        const args = JSON.parse(call.function!.arguments as string) as HostRpcJson;
        if (name !== 'read_project_context' && (!contextRead || contextReadStep === step))
          throw new Error('JOY_AGENT_CONTEXT_REQUIRED');
        const hostResult = await callHost(name, args);
        options.signal?.throwIfAborted();
        if (name === 'read_project_context') {
          contextRead = true;
          if (contextReadStep < 0) contextReadStep = step;
          result = { ok: true, context: hostResult, applied: false };
        } else if (name === 'validate_proposal' || LOOK_TOOL_NAME_SET.has(name)) {
          // A Look intent tool is deterministic and terminal, exactly like
          // `validate_proposal`: the host has staged a reversible preview and
          // returned only opaque identities. A later provider message cannot
          // replace it.
          return { kind: 'prepared', proposal: parsePreparedProposal(hostResult) };
        } else {
          result = { ok: true, evidence: hostResult, applied: false };
        }
      } catch (error) {
        // A cancellation is terminal: never convert it into a repairable
        // diagnostic that would charge a repair attempt and keep the loop going.
        if (options.signal?.aborted === true) throw error;
        const repair = repairResult(error);
        result = repair as unknown as HostRpcJson;
        if (repair.repairable) options.onRepairAttempt?.();
        else throw error;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: boundedJson(result) });
    }
  }
  throw new Error('Provider tool limit reached');
}
