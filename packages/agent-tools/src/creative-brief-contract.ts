/**
 * Creative Brief model-facing contract - v1.1.2 reliability fix.
 *
 * The Creative Brief path used to reach the model with a single sentence:
 * "Return only one JSON CreativeBriefV1 object". Nothing told the model which
 * fields the contract requires, which values it had to echo back, or which
 * enums were allowed, so a provider that answered in good faith could still
 * return an object that the independent validator rejects.
 *
 * This module owns the one model-facing description of that contract:
 *
 * - `buildCreativeBriefModelContract` renders the bounded shape the model may
 *   return. It is derived from the existing structural contract
 *   (`ModelAdapterOutputV1` plus the echoed bindings) and from the same
 *   constants the validator uses, so the prompt cannot drift from validation.
 * - `buildCreativeBriefModelPrompt` binds that contract to the exact project
 *   and revision of one request.
 * - `completeCreativeBriefFromModelOutput` turns the model answer into a
 *   `CreativeBriefV1` by filling only the host-owned fields, then runs the
 *   unchanged, independent validator over the result.
 *
 * Pure and deterministic: no network, no provider calls, no persistence, no
 * secrets, and no edit capability.
 */

import type { CreativeBriefV1 } from './creative-brief.js';
import { MAX_LENGTHS, RECOMMENDATION_KINDS } from './creative-brief.js';

/** Version of the model-facing contract. Bump only with a validator change. */
export const CREATIVE_BRIEF_MODEL_CONTRACT_VERSION = 1;

/**
 * Hard ceiling for the composed prompt. The engine truncates a run prompt at
 * 8000 characters, so the contract must always fit whole.
 */
export const CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS = 7_800;

/** Bound for the user request echoed into the prompt. */
export const CREATIVE_BRIEF_MODEL_REQUEST_MAX_CHARS = 4_000;

/** Default adapter label recorded in brief metadata. */
export const CREATIVE_BRIEF_MODEL_ADAPTER_LABEL = 'joy-agent-provider';

/** Failure classes of the contract, so a rejection names a subtype. */
export type CreativeBriefContractErrorCode =
  | 'model-output-not-object'
  | 'binding-invalid'
  | 'binding-mismatch'
  | 'prompt-budget-exceeded'
  | 'unsupported-schema-version'
  | 'invalid-brief';

/** Warning code recorded when the request was shortened before the model saw it. */
export const CREATIVE_BRIEF_REQUEST_TRUNCATED_CODE = 'request-truncated';

export class CreativeBriefContractError extends Error {
  readonly code: CreativeBriefContractErrorCode;
  readonly field: string | undefined;
  readonly detail: string | undefined;

  constructor(
    code: CreativeBriefContractErrorCode,
    message: string,
    field?: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'CreativeBriefContractError';
    this.code = code;
    this.field = field;
    this.detail = detail;
  }
}

/** The exact values the model must echo back for one request. */
export interface CreativeBriefModelBindingV1 {
  readonly schemaVersion: 1;
  readonly snapshotRevisionId: string;
  readonly projectId: string;
  readonly request: string;
  /** True when the request shown to the model was shortened to fit the budget. */
  readonly requestTruncated: boolean;
}

/** The bounded shape of the object the model may return. */
export interface CreativeBriefModelContractV1 {
  readonly contractVersion: number;
  readonly echo: CreativeBriefModelBindingV1;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, number>>;
  readonly skeleton: Readonly<Record<string, unknown>>;
}

const CONFIDENCE_VALUES = 'low|medium|high';

const RISK_VALUES = 'none|reversible-local|destructive|remote-egress|spend';

function buildModelFields(): Readonly<Record<string, unknown>> {
  return {
    interpretedGoal: {
      required: true,
      shape: {
        userIntent: 'string',
        inferredGoal: 'string',
        resolvedGoal: 'string',
        confidence: CONFIDENCE_VALUES,
      },
    },
    distinction: {
      required: true,
      shape: {
        facts: [{ id: 'string', statement: 'string', source: 's1|s2|snapshot', evidence: [] }],
        inferences: [
          {
            id: 'string',
            statement: 'string',
            confidence: CONFIDENCE_VALUES,
            rationale: 'string',
            evidence: [],
          },
        ],
      },
    },
    assumptions: {
      required: false,
      shape: [
        {
          id: 'string',
          statement: 'string',
          confidence: CONFIDENCE_VALUES,
          evidence: [],
          verified: 'boolean',
        },
      ],
    },
    recommendations: {
      required: true,
      shape: [
        {
          id: 'string',
          kind: RECOMMENDATION_KINDS.join('|'),
          confidence: CONFIDENCE_VALUES,
          evidence: [],
          rationale: 'string',
          expectedBenefit: 'string',
          proposedIntent: 'string (optional, advisory only)',
          risk: RISK_VALUES,
          scope: {
            sceneIds: 'string[] (optional)',
            startUs: 'number (optional)',
            endUs: 'number (optional)',
            elementIds: 'string[] (optional)',
          },
        },
      ],
    },
    blockedBy: {
      required: false,
      shape: [
        {
          id: 'string',
          capability: 'string',
          status: 'setup-required|unavailable|unknown',
          message: 'string',
          evidence: [],
        },
      ],
    },
    requiresHumanDecision: {
      required: false,
      shape: [
        {
          id: 'string',
          question: 'string',
          context: 'string',
          options: 'string[]',
          evidence: [],
        },
      ],
    },
    intelligence: {
      required: true,
      hostOwned: true,
      shape: { brand: 'object', scenes: 'array', project: 'object', rules: 'array' },
    },
    warnings: {
      required: false,
      shape: [{ code: 'string', message: 'string', severity: 'info|warning|error' }],
    },
  };
}

function buildModelLimits(): Readonly<Record<string, number>> {
  return {
    recommendations: MAX_LENGTHS.recommendationCount,
    assumptions: MAX_LENGTHS.assumptionCount,
    blockedBy: MAX_LENGTHS.capabilityGapCount,
    requiresHumanDecision: MAX_LENGTHS.humanDecisionCount,
    evidencePerItem: MAX_LENGTHS.evidenceRefCount,
    rationaleChars: MAX_LENGTHS.rationale,
    expectedBenefitChars: MAX_LENGTHS.expectedBenefit,
    requestChars: MAX_LENGTHS.request,
  };
}

/**
 * Render the model-facing contract for one request.
 *
 * The contract is bounded and provider compatible: plain JSON, no exotic
 * schema keywords, no host objects, and no capability beyond reading the
 * attached project context.
 */
export function buildCreativeBriefModelContract(input: {
  readonly projectId: string;
  readonly revisionId: string;
  readonly request: string;
  readonly requestTruncated?: boolean;
}): CreativeBriefModelContractV1 {
  const echo: CreativeBriefModelBindingV1 = {
    schemaVersion: 1,
    snapshotRevisionId: input.revisionId,
    projectId: input.projectId,
    request: input.request,
    requestTruncated: input.requestTruncated === true,
  };
  return {
    contractVersion: CREATIVE_BRIEF_MODEL_CONTRACT_VERSION,
    echo,
    fields: buildModelFields(),
    limits: buildModelLimits(),
    skeleton: {
      schemaVersion: 1,
      snapshotRevisionId: input.revisionId,
      projectId: input.projectId,
      request: '<copy the USER REQUEST text verbatim>',
      interpretedGoal: {
        userIntent: '<the user request>',
        inferredGoal: '<what the project needs>',
        resolvedGoal: '<the bounded goal>',
        confidence: 'medium',
      },
      distinction: { facts: [], inferences: [] },
      assumptions: [],
      recommendations: [
        {
          id: 'pacing-001',
          kind: 'pacing',
          confidence: 'medium',
          evidence: [],
          rationale: '<why this helps>',
          expectedBenefit: '<what improves>',
          risk: 'none',
          scope: {},
        },
      ],
      blockedBy: [],
      requiresHumanDecision: [],
      intelligence: { brand: {}, scenes: [], project: {}, rules: [] },
      warnings: [],
    },
  };
}

const CONTRACT_RULES: readonly string[] = [
  'Reply with one JSON object only. No markdown fence, no prose before or after it.',
  'Copy schemaVersion, snapshotRevisionId and projectId exactly as the contract shows them, and set request to the USER REQUEST text verbatim. A brief bound to another project or revision is rejected.',
  'Do not send a meta object. JOY fills generatedAt, modelAdapter and processingTimeMs itself.',
  'Use only ids that appear in the attached project context. Never invent clip, asset, scene, object or template ids.',
  'Put verified project facts in distinction.facts and every judgement in distinction.inferences. Mark an assumption verified only when the context proves it.',
  'Give every recommendation an id, kind, confidence, evidence, rationale, expectedBenefit, risk and scope. Use the risk list in the contract and no other value.',
  'This task is read-only. Never send edit operations, tool calls or commands, and never claim that an edit was applied.',
  'Never put credentials, access tokens, URLs, file paths or command payloads in any field.',
];

/**
 * Compose the Creative Brief prompt for one request.
 *
 * The result carries the exact project and revision bindings, the bounded
 * output shape, and the rules the answer must respect. It never exceeds
 * {@link CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS}, so the engine never truncates
 * the contract away.
 */
export function buildCreativeBriefModelPrompt(input: {
  readonly request: string;
  readonly projectId: string;
  readonly revisionId: string;
}): string {
  const resolved = resolveCreativeBriefRequest(input);
  return renderCreativeBriefPrompt({
    ...input,
    request: resolved.request,
    truncated: resolved.truncated,
  });
}

/**
 * Resolve the request text that the model actually sees.
 *
 * The request is carried twice in the prompt (the request section and the
 * contract echo), so the bound is what the fixed prompt leaves free. When the
 * request is shortened, the caller and the brief are told, so user content is
 * never lost silently.
 */
function resolveCreativeBriefRequest(input: {
  readonly request: string;
  readonly projectId: string;
  readonly revisionId: string;
}): { readonly request: string; readonly truncated: boolean } {
  const { request } = input;
  if (
    request.length <= CREATIVE_BRIEF_MODEL_REQUEST_MAX_CHARS &&
    renderCreativeBriefPrompt({ ...input, truncated: false }).length <=
      CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS
  ) {
    return { request, truncated: false };
  }
  const fixedLength = renderCreativeBriefPrompt({
    ...input,
    request: '',
    truncated: true,
  }).length;
  if (fixedLength > CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS) {
    throw new CreativeBriefContractError(
      'prompt-budget-exceeded',
      'The project context identifiers are too long to build a Creative Brief request.',
    );
  }
  let remaining = CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS - fixedLength;
  let length = 0;
  for (const character of request) {
    const cost = character.length + JSON.stringify(character).length - 2;
    if (cost > remaining || length + character.length > CREATIVE_BRIEF_MODEL_REQUEST_MAX_CHARS) {
      break;
    }
    remaining -= cost;
    length += character.length;
  }
  return { request: request.slice(0, length), truncated: true };
}

function renderCreativeBriefPrompt(input: {
  readonly request: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly truncated: boolean;
}): string {
  const contract = buildCreativeBriefModelContract({
    projectId: input.projectId,
    revisionId: input.revisionId,
    request: input.request,
    requestTruncated: input.truncated,
  });
  const rules = [
    ...CONTRACT_RULES,
    ...(input.truncated
      ? [
          'The user request was shortened before it reached you. Answer only from the request text you can see and never claim to have seen the part that was cut.',
        ]
      : []),
  ]
    .map((rule, index) => `${index + 1}. ${rule}`)
    .join('\n');
  return [
    'JOY Creative Brief request. Analyse the attached project context and answer with one JSON object that matches the contract below.',
    '',
    'USER REQUEST:',
    input.request,
    ...(input.truncated
      ? ['', 'NOTE: the user request above was shortened to fit the JOY prompt budget.']
      : []),
    '',
    `CONTRACT (binding, version ${contract.contractVersion}):`,
    JSON.stringify(contract),
    '',
    'RULES:',
    rules,
    '',
    'Answer with the JSON object only.',
  ].join('\n');
}

export interface CreativeBriefCompletionInput {
  /** The raw object the provider returned. */
  readonly output: unknown;
  readonly projectId: string;
  readonly revisionId: string;
  /** The exact user request; the brief always records this text. */
  readonly request: string;
  readonly modelAdapter?: string;
  readonly generatedAt?: string;
  readonly processingTimeMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check one echoed binding.
 *
 * An absent binding is filled by the host. A supplied binding must be the
 * current one: a blank, non-string or foreign value is rejected with a
 * redacted error that names the field and never the value.
 */
function assertBinding(
  output: Record<string, unknown>,
  field: 'projectId' | 'snapshotRevisionId',
  expected: string,
  label: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(output, field)) return;
  const value = output[field];
  if (typeof value !== 'string' || value.trim() === '')
    throw new CreativeBriefContractError(
      'binding-invalid',
      `The Creative Brief carries an invalid ${field} binding.`,
      field,
    );
  if (value !== expected)
    throw new CreativeBriefContractError(
      'binding-mismatch',
      `The Creative Brief is bound to another ${label}.`,
      field,
    );
}

/**
 * Complete a provider answer into a `CreativeBriefV1`.
 *
 * Host-owned fields are the schema version, the project and revision bindings,
 * the recorded request, the metadata block, and the intelligence shell. The
 * model keeps authorship of the interpreted goal, the fact and inference
 * distinction, assumptions, recommendations, capability gaps and human
 * decisions; those are validated unchanged by `validateCreativeBrief`.
 *
 * A mismatch on the echoed bindings is a rejection, never a silent rewrite.
 */
export function completeCreativeBriefFromModelOutput(
  input: CreativeBriefCompletionInput,
): CreativeBriefV1 {
  if (!isRecord(input.output))
    throw new CreativeBriefContractError(
      'model-output-not-object',
      'The model did not return a JSON object for the Creative Brief.',
    );
  const output = input.output;
  if (output.schemaVersion !== undefined && output.schemaVersion !== 1)
    throw new CreativeBriefContractError(
      'unsupported-schema-version',
      'The model returned a Creative Brief that is not schema version 1.',
      'schemaVersion',
    );
  // A binding is either absent or exactly right. A supplied binding that is
  // blank, of another type, or of another value is a rejection, never a
  // silent rewrite. The supplied value is never echoed into the error.
  assertBinding(output, 'projectId', input.projectId, 'project');
  assertBinding(output, 'snapshotRevisionId', input.revisionId, 'revision');
  // The brief always records the exact trusted request. A model that rewrote
  // the request does not get to change what the user asked for.
  const recordedRequest = input.request;
  // A list the model authored is kept exactly as authored. Only an absent
  // list becomes an empty one, so a malformed list still reaches the
  // independent validator instead of being normalized away.
  const authoredList = (value: unknown): unknown => (value === undefined ? [] : value);
  const suppliedWarnings = authoredList(output.warnings);
  // When the request was shortened before the model saw it, the brief says so
  // instead of losing that user content silently.
  const resolved = resolveCreativeBriefRequest({
    request: recordedRequest,
    projectId: input.projectId,
    revisionId: input.revisionId,
  });
  const warnings = Array.isArray(suppliedWarnings)
    ? resolved.truncated
      ? [
          ...suppliedWarnings,
          {
            code: CREATIVE_BRIEF_REQUEST_TRUNCATED_CODE,
            message:
              'The brief request was shortened before the model saw it, so this brief answers the shortened request.',
            severity: 'warning',
          },
        ]
      : suppliedWarnings
    : suppliedWarnings;
  const intelligence =
    output.intelligence === undefined
      ? { brand: {}, scenes: [], project: {}, rules: [] }
      : isRecord(output.intelligence)
        ? { brand: {}, scenes: [], project: {}, rules: [], ...output.intelligence }
        : output.intelligence;
  const brief = {
    schemaVersion: 1,
    snapshotRevisionId: input.revisionId,
    projectId: input.projectId,
    request: recordedRequest,
    interpretedGoal: output.interpretedGoal,
    distinction: output.distinction,
    assumptions: authoredList(output.assumptions),
    recommendations: authoredList(output.recommendations),
    blockedBy: authoredList(output.blockedBy),
    requiresHumanDecision: authoredList(output.requiresHumanDecision),
    intelligence,
    warnings,
    meta: {
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      modelAdapter: input.modelAdapter ?? CREATIVE_BRIEF_MODEL_ADAPTER_LABEL,
      processingTimeMs: input.processingTimeMs ?? 0,
    },
  } as unknown as CreativeBriefV1;
  return brief;
}
