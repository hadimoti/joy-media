/**
 * P07 WP-07.2 — node library v1: concrete node types for all nine §23.2 categories.
 * Extended in WP-07.4 with the node types the §23.4 first-party workflows require
 * (hooks/speakers/chapters analysis, reframe/denoise/normalize/scene/compose
 * transforms, translate generation).
 */

import type { JoyWorkflow, WorkflowNodeCategory } from './definition.js';
import { runMapBatch } from './map.js';
import type { MapBatchState } from './map.js';
import type { NodeParamIssue } from './nodes.js';
import {
  NodeRegistry,
  optionalString,
  paramIssue,
  requireArray,
  requireEnum,
  requireString,
} from './nodes.js';
import type {
  HumanInputRequest,
  HumanInputRequestKind,
  NodeExecutionContext,
  NodeHandler,
  NodeResult,
} from './runtime.js';
import { HUMAN_INPUT_REQUEST_KINDS } from './runtime.js';

// ---------------------------------------------------------------------------
// Value references: how node params point at workflow inputs / upstream outputs.
// ---------------------------------------------------------------------------

export type ValueRef =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'input'; readonly path?: string }
  | { readonly kind: 'upstream'; readonly node: string; readonly path?: string };

export class NodeLibraryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NodeLibraryError';
    this.code = code;
  }
}

function resolvePath(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === '') {
    return value;
  }
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new NodeLibraryError(
          'workflow/ref-unresolved',
          `path segment "${segment}" is not a valid array index`,
        );
      }
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object') {
      throw new NodeLibraryError(
        'workflow/ref-unresolved',
        `path segment "${segment}" cannot be read from a non-object value`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) {
      throw new NodeLibraryError('workflow/ref-unresolved', `path segment "${segment}" is missing`);
    }
  }
  return current;
}

export function isValueRef(value: unknown): value is ValueRef {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'literal') {
    return 'value' in value;
  }
  if (kind === 'input') {
    return true;
  }
  if (kind === 'upstream') {
    return typeof (value as { node?: unknown }).node === 'string';
  }
  return false;
}

/** Resolve a `ValueRef` against the current execution context. Throws coded errors. */
export function resolveValueRef(ref: ValueRef, ctx: NodeExecutionContext): unknown {
  switch (ref.kind) {
    case 'literal':
      return ref.value;
    case 'input':
      return resolvePath(ctx.workflowInputs, ref.path);
    case 'upstream': {
      if (!(ref.node in ctx.upstream)) {
        throw new NodeLibraryError(
          'workflow/ref-unresolved',
          `node "${ctx.node.id}" references upstream "${ref.node}" which is not connected`,
        );
      }
      return resolvePath(ctx.upstream[ref.node], ref.path);
    }
  }
}

/**
 * Resolve a node's primary payload: an explicit `ValueRef` param when present,
 * otherwise the sole upstream output. Multi-parent nodes must use explicit refs.
 */
function resolveSource(ctx: NodeExecutionContext, refParam: string): unknown {
  const ref = ctx.node.params[refParam];
  if (ref !== undefined) {
    if (!isValueRef(ref)) {
      throw new NodeLibraryError(
        'workflow/invalid-ref',
        `node "${ctx.node.id}" param "${refParam}" is not a value reference`,
      );
    }
    return resolveValueRef(ref, ctx);
  }
  const parents = Object.keys(ctx.upstream);
  if (parents.length === 1) {
    return ctx.upstream[parents[0] as string];
  }
  throw new NodeLibraryError(
    'workflow/ambiguous-source',
    `node "${ctx.node.id}" has ${String(parents.length)} upstream nodes; set "${refParam}" explicitly`,
  );
}

function validateOptionalRef(
  params: Readonly<Record<string, unknown>>,
  key: string,
  issues: NodeParamIssue[],
): void {
  const value = params[key];
  if (value !== undefined && !isValueRef(value)) {
    issues.push(paramIssue(key, 'must be a value reference ({kind: literal|input|upstream})'));
  }
}

function validateRequiredRef(
  params: Readonly<Record<string, unknown>>,
  key: string,
  issues: NodeParamIssue[],
): void {
  if (!isValueRef(params[key])) {
    issues.push(paramIssue(key, 'must be a value reference'));
  }
}

function optionalStringArrayParam(
  ctx: NodeExecutionContext,
  key: string,
): readonly string[] | undefined {
  const value = ctx.node.params[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Typed conditions (§23.2 decision: "typed conditions").
// ---------------------------------------------------------------------------

export type WorkflowCondition =
  | {
      readonly op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly left: ValueRef;
      readonly right: ValueRef;
    }
  | { readonly op: 'defined'; readonly value: ValueRef }
  | { readonly op: 'not'; readonly condition: WorkflowCondition }
  | { readonly op: 'and' | 'or'; readonly conditions: readonly WorkflowCondition[] };

export function isWorkflowCondition(value: unknown): value is WorkflowCondition {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const cond = value as Record<string, unknown>;
  switch (cond['op']) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return isValueRef(cond['left']) && isValueRef(cond['right']);
    case 'defined':
      return isValueRef(cond['value']);
    case 'not':
      return isWorkflowCondition(cond['condition']);
    case 'and':
    case 'or':
      return (
        Array.isArray(cond['conditions']) &&
        cond['conditions'].every((item) => isWorkflowCondition(item))
      );
    default:
      return false;
  }
}

function compareOrdered(op: 'lt' | 'lte' | 'gt' | 'gte', left: unknown, right: unknown): boolean {
  const comparable =
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'string' && typeof right === 'string');
  if (!comparable) {
    throw new NodeLibraryError(
      'workflow/condition-type-error',
      `"${op}" requires two numbers or two strings; got ${typeof left} and ${typeof right}`,
    );
  }
  switch (op) {
    case 'lt':
      return (left as number | string) < (right as number | string);
    case 'lte':
      return (left as number | string) <= (right as number | string);
    case 'gt':
      return (left as number | string) > (right as number | string);
    case 'gte':
      return (left as number | string) >= (right as number | string);
  }
}

function deepEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => deepEquals(item, right[i]));
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, i) =>
          key === rightKeys[i] &&
          deepEquals(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return false;
}

/** Pure, exhaustive condition evaluation; throws coded errors on type mismatches. */
export function evaluateCondition(
  condition: WorkflowCondition,
  ctx: NodeExecutionContext,
): boolean {
  switch (condition.op) {
    case 'eq':
      return deepEquals(
        resolveValueRef(condition.left, ctx),
        resolveValueRef(condition.right, ctx),
      );
    case 'neq':
      return !deepEquals(
        resolveValueRef(condition.left, ctx),
        resolveValueRef(condition.right, ctx),
      );
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return compareOrdered(
        condition.op,
        resolveValueRef(condition.left, ctx),
        resolveValueRef(condition.right, ctx),
      );
    case 'defined':
      try {
        return resolveValueRef(condition.value, ctx) !== null;
      } catch (error) {
        if (error instanceof NodeLibraryError && error.code === 'workflow/ref-unresolved') {
          return false;
        }
        throw error;
      }
    case 'not':
      return !evaluateCondition(condition.condition, ctx);
    case 'and':
      return condition.conditions.every((item) => evaluateCondition(item, ctx));
    case 'or':
      return condition.conditions.some((item) => evaluateCondition(item, ctx));
  }
}

// ---------------------------------------------------------------------------
// Ports (§45.2 dependency inversion): effectful capabilities the library adapts.
// Missing ports produce coded non-retryable failures — capabilities are discovered.
// ---------------------------------------------------------------------------

export interface AnalysisPorts {
  readonly researchBrief?: (args: {
    readonly brief: unknown;
    readonly media: unknown;
    readonly references?: unknown;
  }) => unknown;
  readonly transcribe?: (args: { readonly source: unknown; readonly language?: string }) => unknown;
  readonly detectSilence?: (args: {
    readonly source: unknown;
    readonly thresholdDb?: number;
    readonly minSilenceMs?: number;
  }) => unknown;
  readonly measureLoudness?: (args: { readonly source: unknown }) => unknown;
  /**
   * Proposes topic/hook candidates for short-form drafts (§23.4). Returned
   * candidates should be self-contained (carry their source and subject hints)
   * so approval responses can feed map/batch items directly.
   */
  readonly detectHighlights?: (args: {
    readonly source: unknown;
    readonly transcript?: unknown;
    readonly maxCandidates?: number;
  }) => unknown;
  readonly detectSpeakers?: (args: { readonly source: unknown }) => unknown;
  /**
   * Generates chapter markers (§23.4 podcast cleanup). Each returned chapter
   * should be a self-contained renderable reference so clip map items need no
   * parent-scope access.
   */
  readonly generateChapters?: (args: {
    readonly source: unknown;
    readonly transcript?: unknown;
  }) => unknown;
}

export interface TransformPorts {
  readonly trim?: (args: { readonly source: unknown; readonly ranges: unknown }) => unknown;
  readonly applyCaptionTemplate?: (args: {
    readonly source: unknown;
    readonly templateId: string;
  }) => unknown;
  readonly reframe?: (args: {
    readonly source: unknown;
    readonly aspect: string;
    readonly subjectHints?: unknown;
  }) => unknown;
  readonly denoise?: (args: {
    readonly source: unknown;
    readonly strength?: number;
    readonly method?: 'noise-gate' | 'spectral' | 'ml';
  }) => unknown;
  readonly normalizeAudio?: (args: {
    readonly source: unknown;
    readonly targetLufs?: number;
    readonly duckMusic?: boolean;
  }) => unknown;
  /** Instantiates an HTML scene template (§20.4) with bound variables. */
  readonly instantiateSceneTemplate?: (args: {
    readonly templateId: string;
    readonly variables: unknown;
  }) => unknown;
  readonly buildContactSheet?: (args: {
    readonly title: string;
    readonly candidates: unknown;
    readonly shotlist?: unknown;
    readonly providerRefs?: readonly string[];
  }) => unknown;
}

export interface GenerationPorts {
  readonly synthesizeSpeech?: (args: {
    readonly text: string;
    readonly voiceId: string;
    readonly language?: string;
  }) => unknown;
  readonly generateImage?: (args: { readonly prompt: string }) => unknown;
  readonly translate?: (args: {
    readonly text: string;
    readonly targetLanguage: string;
    readonly sourceLanguage?: string;
  }) => unknown;
  readonly generateScript?: (args: {
    readonly brief: unknown;
    readonly research: unknown;
    readonly media: unknown;
    readonly style?: string;
  }) => unknown;
  readonly generateShotlist?: (args: {
    readonly script: unknown;
    readonly media: unknown;
    readonly format?: string;
  }) => unknown;
}

export interface EditorPorts {
  /** Executes one command-bus transaction; never mutates project JSON directly (§44). */
  readonly executeCommandTransaction?: (args: {
    readonly label: string;
    readonly commands: readonly unknown[];
    /** Original run input, available to explicitly connected host adapters. */
    readonly workflowInputs?: unknown;
    /** Opaque editor revision at which this handler is executing. */
    readonly projectRevision?: string;
  }) => { readonly transactionId: string };
  readonly createBranch?: (args: { readonly name: string; readonly source: unknown }) => {
    readonly branchId: string;
  };
}

export interface RenderPorts {
  readonly render?: (args: {
    readonly mode: 'preview' | 'final';
    readonly source: unknown;
    readonly profile?: string;
  }) => unknown;
  readonly inspect?: (args: {
    readonly source: unknown;
    readonly deliveryPromise?: unknown;
    readonly reportRef?: string;
  }) => unknown;
}

export interface OutputPorts {
  readonly writeToFolder?: (args: {
    readonly folderId: string;
    readonly artifact: unknown;
    readonly fileName?: string;
  }) => unknown;
  readonly writeMetadataFile?: (args: {
    readonly folderId: string;
    readonly fileName: string;
    readonly metadata: unknown;
  }) => unknown;
  readonly writeDeliveryManifest?: (args: {
    readonly folderId: string;
    readonly fileName: string;
    readonly artifact: unknown;
    readonly inspection?: unknown;
    readonly approvals?: unknown;
    readonly providerRefs?: readonly string[];
  }) => unknown;
}

/** Persists partial map/batch progress across parent-run resumes, keyed by node run key. */
export interface MapStateStore {
  get(runKey: string): MapBatchState | undefined;
  set(runKey: string, state: MapBatchState): void;
}

export class InMemoryMapStateStore implements MapStateStore {
  private readonly states = new Map<string, MapBatchState>();

  get(runKey: string): MapBatchState | undefined {
    return this.states.get(runKey);
  }

  set(runKey: string, state: MapBatchState): void {
    this.states.set(runKey, state);
  }
}

export interface NodeLibraryPorts {
  readonly analysis?: AnalysisPorts;
  readonly transform?: TransformPorts;
  readonly generation?: GenerationPorts;
  readonly editor?: EditorPorts;
  readonly render?: RenderPorts;
  readonly output?: OutputPorts;
}

export interface BuildNodeLibraryOptions {
  readonly ports?: NodeLibraryPorts;
  /** Store for map/batch partial progress; defaults to a fresh in-memory store. */
  readonly mapStateStore?: MapStateStore;
}

export interface NodeLibrary {
  readonly registry: NodeRegistry;
  /** Handlers for every registered node type, ready for `executeWorkflow`. */
  readonly handlers: Readonly<Record<string, NodeHandler>>;
}

// ---------------------------------------------------------------------------
// Handler plumbing.
// ---------------------------------------------------------------------------

const okResult = (output: unknown): NodeResult => ({ ok: true, output });

const failure = (failureCode: string, retryable: boolean): NodeResult => ({
  ok: false,
  failureCode,
  retryable,
});

/** Wraps a handler body: library errors are coded non-retryable, port errors retryable. */
function guarded(body: (ctx: NodeExecutionContext) => NodeResult): NodeHandler {
  return (ctx) => {
    try {
      return body(ctx);
    } catch (error) {
      if (error instanceof NodeLibraryError) {
        return failure(error.code, false);
      }
      return failure('workflow/port-error', true);
    }
  };
}

function portBacked<TPort>(
  port: TPort | undefined,
  portName: string,
  body: (port: TPort, ctx: NodeExecutionContext) => NodeResult,
): NodeHandler {
  return guarded((ctx) => {
    if (port === undefined) {
      return failure(`workflow/port-unavailable:${portName}`, false);
    }
    return body(port, ctx);
  });
}

function stringParam(ctx: NodeExecutionContext, key: string): string {
  const value = ctx.node.params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NodeLibraryError(
      'workflow/invalid-params',
      `node "${ctx.node.id}" param "${key}" must be a non-empty string`,
    );
  }
  return value;
}

function optionalStringParam(ctx: NodeExecutionContext, key: string): string | undefined {
  const value = ctx.node.params[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function optionalNumberParam(ctx: NodeExecutionContext, key: string): number | undefined {
  const value = ctx.node.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const noParams = (): NodeParamIssue[] => [];

// ---------------------------------------------------------------------------
// The v1 catalog.
// ---------------------------------------------------------------------------

/**
 * Builds the v1 node library: a registry describing every node type (§23.7 palette
 * contract) plus handlers wired to the supplied ports. Pure node types (input,
 * decision.condition, control passthroughs) work with no ports at all.
 */
export function buildNodeLibrary(options: BuildNodeLibraryOptions = {}): NodeLibrary {
  const ports = options.ports ?? {};
  const mapStateStore = options.mapStateStore ?? new InMemoryMapStateStore();
  const registry = new NodeRegistry();
  const handlers: Record<string, NodeHandler> = {};

  const register = (
    type: string,
    category: WorkflowNodeCategory,
    description: string,
    deterministic: boolean,
    validateParams: (params: Readonly<Record<string, unknown>>) => NodeParamIssue[],
    handler: NodeHandler,
  ): void => {
    registry.register({ type, category, description, deterministic, validateParams });
    handlers[type] = handler;
  };

  // --- input --------------------------------------------------------------
  register(
    'input.value',
    'input',
    'A literal JSON value (text, object, number…) fed into the graph.',
    true,
    (params) => ('value' in params ? [] : [paramIssue('value', 'is required')]),
    guarded((ctx) => okResult(ctx.node.params['value'] ?? null)),
  );

  register(
    'input.item',
    'input',
    'The run inputs (e.g. the current map/batch item), optionally a path into them.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      optionalString(params, 'path', issues);
      return issues;
    },
    guarded((ctx) => {
      const path = optionalStringParam(ctx, 'path');
      return okResult(resolvePath(ctx.workflowInputs, path) ?? null);
    }),
  );

  register(
    'input.rows',
    'input',
    'A batch of JSON rows (e.g. imported CSV rows) for map/batch execution.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireArray(params, 'rows', issues);
      return issues;
    },
    guarded((ctx) => {
      const rows = ctx.node.params['rows'];
      if (!Array.isArray(rows)) {
        throw new NodeLibraryError('workflow/invalid-params', 'rows must be an array');
      }
      return okResult(rows);
    }),
  );

  register(
    'input.asset',
    'input',
    'An opaque asset reference; never a path or URL (§44).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'assetId', issues);
      return issues;
    },
    guarded((ctx) => okResult({ assetId: stringParam(ctx, 'assetId') })),
  );

  register(
    'input.project',
    'input',
    'A project reference for editor/render nodes downstream.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'projectId', issues);
      return issues;
    },
    guarded((ctx) =>
      okResult({ projectId: stringParam(ctx, 'projectId'), revision: ctx.projectRevision }),
    ),
  );

  // --- analysis -----------------------------------------------------------
  register(
    'analysis.researchBrief',
    'analysis',
    'Researches a creative brief against selected media and reference material for production packs.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateRequiredRef(params, 'briefFrom', issues);
      validateRequiredRef(params, 'mediaFrom', issues);
      validateOptionalRef(params, 'referencesFrom', issues);
      return issues;
    },
    portBacked(ports.analysis?.researchBrief, 'analysis.researchBrief', (port, ctx) => {
      const briefRef = ctx.node.params['briefFrom'];
      const mediaRef = ctx.node.params['mediaFrom'];
      const referencesRef = ctx.node.params['referencesFrom'];
      if (!isValueRef(briefRef) || !isValueRef(mediaRef)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          'briefFrom and mediaFrom must be value references',
        );
      }
      const references = isValueRef(referencesRef)
        ? resolveValueRef(referencesRef, ctx)
        : undefined;
      return okResult(
        port({
          brief: resolveValueRef(briefRef, ctx),
          media: resolveValueRef(mediaRef, ctx),
          ...(references !== undefined ? { references } : {}),
        }),
      );
    }),
  );

  register(
    'analysis.transcribe',
    'analysis',
    'Transcribes the source via the analysis port (local-first adapters, §21.6).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      optionalString(params, 'language', issues);
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.analysis?.transcribe, 'analysis.transcribe', (port, ctx) => {
      const language = optionalStringParam(ctx, 'language');
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(language !== undefined ? { language } : {}),
        }),
      );
    }),
  );

  register(
    'analysis.silence',
    'analysis',
    'Detects silences in the source; output is a reviewable range list.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.analysis?.detectSilence, 'analysis.detectSilence', (port, ctx) => {
      const thresholdDb = optionalNumberParam(ctx, 'thresholdDb');
      const minSilenceMs = optionalNumberParam(ctx, 'minSilenceMs');
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(thresholdDb !== undefined ? { thresholdDb } : {}),
          ...(minSilenceMs !== undefined ? { minSilenceMs } : {}),
        }),
      );
    }),
  );

  register(
    'analysis.loudness',
    'analysis',
    'Measures loudness (LUFS/peak) of the source.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.analysis?.measureLoudness, 'analysis.measureLoudness', (port, ctx) =>
      okResult(port({ source: resolveSource(ctx, 'source') })),
    ),
  );

  register(
    'analysis.hooks',
    'analysis',
    'Proposes topic/hook candidates for short-form drafts (§23.4 long-video→draft-reels).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      validateOptionalRef(params, 'transcriptFrom', issues);
      const max = params['maxCandidates'];
      if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1)) {
        issues.push(paramIssue('maxCandidates', 'must be an integer >= 1'));
      }
      return issues;
    },
    portBacked(ports.analysis?.detectHighlights, 'analysis.detectHighlights', (port, ctx) => {
      const transcriptRef = ctx.node.params['transcriptFrom'];
      const transcript = isValueRef(transcriptRef)
        ? resolveValueRef(transcriptRef, ctx)
        : undefined;
      const maxCandidates = optionalNumberParam(ctx, 'maxCandidates');
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(transcript !== undefined ? { transcript } : {}),
          ...(maxCandidates !== undefined ? { maxCandidates } : {}),
        }),
      );
    }),
  );

  register(
    'analysis.speakers',
    'analysis',
    'Detects speakers (diarization) in the source; confirm via decision.approval (§23.4).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.analysis?.detectSpeakers, 'analysis.detectSpeakers', (port, ctx) =>
      okResult(port({ source: resolveSource(ctx, 'source') })),
    ),
  );

  register(
    'analysis.chapters',
    'analysis',
    'Generates chapter markers from the source and optional transcript (§23.4 podcast cleanup).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      validateOptionalRef(params, 'transcriptFrom', issues);
      return issues;
    },
    portBacked(ports.analysis?.generateChapters, 'analysis.generateChapters', (port, ctx) => {
      const transcriptRef = ctx.node.params['transcriptFrom'];
      const transcript = isValueRef(transcriptRef)
        ? resolveValueRef(transcriptRef, ctx)
        : undefined;
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(transcript !== undefined ? { transcript } : {}),
        }),
      );
    }),
  );

  // --- transform ------------------------------------------------------------
  register(
    'transform.trim',
    'transform',
    'Trims the source using a range list (e.g. from analysis.silence).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      const ranges = params['rangesFrom'];
      if (!isValueRef(ranges)) {
        issues.push(paramIssue('rangesFrom', 'must be a value reference'));
      }
      return issues;
    },
    portBacked(ports.transform?.trim, 'transform.trim', (port, ctx) => {
      const rangesRef = ctx.node.params['rangesFrom'];
      if (!isValueRef(rangesRef)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          'rangesFrom must be a value reference',
        );
      }
      return okResult(
        port({ source: resolveSource(ctx, 'source'), ranges: resolveValueRef(rangesRef, ctx) }),
      );
    }),
  );

  register(
    'transform.caption',
    'transform',
    'Applies a caption template to the source (§20.5 templates).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'templateId', issues);
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(
      ports.transform?.applyCaptionTemplate,
      'transform.applyCaptionTemplate',
      (port, ctx) =>
        okResult(
          port({
            source: resolveSource(ctx, 'source'),
            templateId: stringParam(ctx, 'templateId'),
          }),
        ),
    ),
  );

  register(
    'transform.reframe',
    'transform',
    'Reframes the source to a target aspect ratio using subject hints (§23.4).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'aspect', issues);
      validateOptionalRef(params, 'source', issues);
      validateOptionalRef(params, 'subjectHintsFrom', issues);
      return issues;
    },
    portBacked(ports.transform?.reframe, 'transform.reframe', (port, ctx) => {
      const hintsRef = ctx.node.params['subjectHintsFrom'];
      const subjectHints = isValueRef(hintsRef) ? resolveValueRef(hintsRef, ctx) : undefined;
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          aspect: stringParam(ctx, 'aspect'),
          ...(subjectHints !== undefined ? { subjectHints } : {}),
        }),
      );
    }),
  );

  register(
    'transform.denoise',
    'transform',
    'Removes noise from the source audio via local processing (§21, §23.4 podcast cleanup).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      const strength = params['strength'];
      if (strength !== undefined && (typeof strength !== 'number' || !Number.isFinite(strength))) {
        issues.push(paramIssue('strength', 'must be a finite number'));
      }
      const method = params['method'];
      if (
        method !== undefined &&
        method !== 'noise-gate' &&
        method !== 'spectral' &&
        method !== 'ml'
      ) {
        issues.push(paramIssue('method', 'must be noise-gate, spectral, or ml'));
      }
      return issues;
    },
    portBacked(ports.transform?.denoise, 'transform.denoise', (port, ctx) => {
      const strength = optionalNumberParam(ctx, 'strength');
      const methodRaw = ctx.node.params['method'];
      const method =
        methodRaw === 'noise-gate' || methodRaw === 'spectral' || methodRaw === 'ml'
          ? methodRaw
          : undefined;
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(strength !== undefined ? { strength } : {}),
          ...(method !== undefined ? { method } : {}),
        }),
      );
    }),
  );

  register(
    'transform.normalizeAudio',
    'transform',
    'Normalizes loudness toward a LUFS target; optionally ducks music (§23.4).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      const targetLufs = params['targetLufs'];
      if (
        targetLufs !== undefined &&
        (typeof targetLufs !== 'number' || !Number.isFinite(targetLufs))
      ) {
        issues.push(paramIssue('targetLufs', 'must be a finite number'));
      }
      const duckMusic = params['duckMusic'];
      if (duckMusic !== undefined && typeof duckMusic !== 'boolean') {
        issues.push(paramIssue('duckMusic', 'must be a boolean'));
      }
      return issues;
    },
    portBacked(ports.transform?.normalizeAudio, 'transform.normalizeAudio', (port, ctx) => {
      const targetLufs = optionalNumberParam(ctx, 'targetLufs');
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(targetLufs !== undefined ? { targetLufs } : {}),
          ...(ctx.node.params['duckMusic'] === true ? { duckMusic: true } : {}),
        }),
      );
    }),
  );

  register(
    'transform.sceneTemplate',
    'transform',
    'Instantiates an HTML scene template with bound variables (§23.4 multilingual promo, §20.4).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'templateId', issues);
      validateOptionalRef(params, 'variablesFrom', issues);
      if (params['variablesFrom'] === undefined && !('variables' in params)) {
        issues.push(paramIssue('variables', 'is required when variablesFrom is not set'));
      }
      return issues;
    },
    portBacked(
      ports.transform?.instantiateSceneTemplate,
      'transform.instantiateSceneTemplate',
      (port, ctx) => {
        const varsRef = ctx.node.params['variablesFrom'];
        const variables = isValueRef(varsRef)
          ? resolveValueRef(varsRef, ctx)
          : ctx.node.params['variables'];
        return okResult(port({ templateId: stringParam(ctx, 'templateId'), variables }));
      },
    ),
  );

  register(
    'transform.contactSheet',
    'transform',
    'Builds a reviewable contact sheet from candidates and shot-list context.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'title', issues);
      validateRequiredRef(params, 'candidatesFrom', issues);
      validateOptionalRef(params, 'shotlistFrom', issues);
      const providerRefs = params['providerRefs'];
      if (
        providerRefs !== undefined &&
        (!Array.isArray(providerRefs) || providerRefs.some((entry) => typeof entry !== 'string'))
      ) {
        issues.push(paramIssue('providerRefs', 'must be an array of strings when present'));
      }
      return issues;
    },
    portBacked(ports.transform?.buildContactSheet, 'transform.buildContactSheet', (port, ctx) => {
      const candidatesRef = ctx.node.params['candidatesFrom'];
      if (!isValueRef(candidatesRef)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          'candidatesFrom must be a value reference',
        );
      }
      const shotlistRef = ctx.node.params['shotlistFrom'];
      const shotlist = isValueRef(shotlistRef) ? resolveValueRef(shotlistRef, ctx) : undefined;
      const providerRefs = optionalStringArrayParam(ctx, 'providerRefs');
      return okResult(
        port({
          title: stringParam(ctx, 'title'),
          candidates: resolveValueRef(candidatesRef, ctx),
          ...(shotlist !== undefined ? { shotlist } : {}),
          ...(providerRefs !== undefined ? { providerRefs } : {}),
        }),
      );
    }),
  );

  register(
    'transform.compose',
    'transform',
    'Builds one object from named value references — pure fan-in for multi-input downstream nodes.',
    true,
    (params) => {
      const fields = params['fields'];
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        return [paramIssue('fields', 'must be an object of value references')];
      }
      const issues: NodeParamIssue[] = [];
      for (const [key, ref] of Object.entries(fields)) {
        if (!isValueRef(ref)) {
          issues.push(paramIssue(`fields.${key}`, 'must be a value reference'));
        }
      }
      return issues;
    },
    guarded((ctx) => {
      const fields = ctx.node.params['fields'];
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          `node "${ctx.node.id}" fields must be an object of value references`,
        );
      }
      const out: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(fields)) {
        if (!isValueRef(ref)) {
          throw new NodeLibraryError(
            'workflow/invalid-ref',
            `node "${ctx.node.id}" fields.${key} is not a value reference`,
          );
        }
        out[key] = resolveValueRef(ref, ctx);
      }
      return okResult(out);
    }),
  );

  // --- generation (nondeterministic; §23.5 reuse only by policy) -----------
  register(
    'generation.speech',
    'generation',
    'Synthesizes speech via the provider system; consent is enforced by the adapter (§21.6).',
    false,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'voiceId', issues);
      optionalString(params, 'language', issues);
      validateOptionalRef(params, 'textFrom', issues);
      if (params['textFrom'] === undefined) {
        requireString(params, 'text', issues);
      }
      return issues;
    },
    portBacked(ports.generation?.synthesizeSpeech, 'generation.synthesizeSpeech', (port, ctx) => {
      const textRef = ctx.node.params['textFrom'];
      const text = isValueRef(textRef) ? resolveValueRef(textRef, ctx) : ctx.node.params['text'];
      if (typeof text !== 'string' || text === '') {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          `node "${ctx.node.id}" resolved speech text is not a non-empty string`,
        );
      }
      const language = optionalStringParam(ctx, 'language');
      return okResult(
        port({
          text,
          voiceId: stringParam(ctx, 'voiceId'),
          ...(language !== undefined ? { language } : {}),
        }),
      );
    }),
  );

  register(
    'generation.image',
    'generation',
    'Generates an image via the provider system.',
    false,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'prompt', issues);
      return issues;
    },
    portBacked(ports.generation?.generateImage, 'generation.generateImage', (port, ctx) =>
      okResult(port({ prompt: stringParam(ctx, 'prompt') })),
    ),
  );

  register(
    'generation.translate',
    'generation',
    'Translates text via the provider system (§23.4 multilingual promo).',
    false,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'textFrom', issues);
      if (params['textFrom'] === undefined) {
        requireString(params, 'text', issues);
      }
      validateOptionalRef(params, 'targetLanguageFrom', issues);
      if (params['targetLanguageFrom'] === undefined) {
        requireString(params, 'targetLanguage', issues);
      }
      optionalString(params, 'sourceLanguage', issues);
      return issues;
    },
    portBacked(ports.generation?.translate, 'generation.translate', (port, ctx) => {
      const textRef = ctx.node.params['textFrom'];
      const text = isValueRef(textRef) ? resolveValueRef(textRef, ctx) : ctx.node.params['text'];
      if (typeof text !== 'string' || text === '') {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          `node "${ctx.node.id}" resolved translation text is not a non-empty string`,
        );
      }
      const langRef = ctx.node.params['targetLanguageFrom'];
      const targetLanguage = isValueRef(langRef)
        ? resolveValueRef(langRef, ctx)
        : ctx.node.params['targetLanguage'];
      if (typeof targetLanguage !== 'string' || targetLanguage === '') {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          `node "${ctx.node.id}" resolved target language is not a non-empty string`,
        );
      }
      const sourceLanguage = optionalStringParam(ctx, 'sourceLanguage');
      return okResult(
        port({
          text,
          targetLanguage,
          ...(sourceLanguage !== undefined ? { sourceLanguage } : {}),
        }),
      );
    }),
  );

  register(
    'generation.script',
    'generation',
    'Generates a production script from a brief, selected media, and research notes.',
    false,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateRequiredRef(params, 'briefFrom', issues);
      validateRequiredRef(params, 'researchFrom', issues);
      validateRequiredRef(params, 'mediaFrom', issues);
      optionalString(params, 'style', issues);
      return issues;
    },
    portBacked(ports.generation?.generateScript, 'generation.generateScript', (port, ctx) => {
      const briefRef = ctx.node.params['briefFrom'];
      const researchRef = ctx.node.params['researchFrom'];
      const mediaRef = ctx.node.params['mediaFrom'];
      if (!isValueRef(briefRef) || !isValueRef(researchRef) || !isValueRef(mediaRef)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          'briefFrom, researchFrom, and mediaFrom must be value references',
        );
      }
      return okResult(
        port({
          brief: resolveValueRef(briefRef, ctx),
          research: resolveValueRef(researchRef, ctx),
          media: resolveValueRef(mediaRef, ctx),
          ...(() => {
            const style = optionalStringParam(ctx, 'style');
            return style === undefined ? {} : { style };
          })(),
        }),
      );
    }),
  );

  register(
    'generation.shotlist',
    'generation',
    'Generates an editable shot list from the approved/scripted treatment and media.',
    false,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateRequiredRef(params, 'scriptFrom', issues);
      validateRequiredRef(params, 'mediaFrom', issues);
      optionalString(params, 'format', issues);
      return issues;
    },
    portBacked(ports.generation?.generateShotlist, 'generation.generateShotlist', (port, ctx) => {
      const scriptRef = ctx.node.params['scriptFrom'];
      const mediaRef = ctx.node.params['mediaFrom'];
      if (!isValueRef(scriptRef) || !isValueRef(mediaRef)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          'scriptFrom and mediaFrom must be value references',
        );
      }
      return okResult(
        port({
          script: resolveValueRef(scriptRef, ctx),
          media: resolveValueRef(mediaRef, ctx),
          ...(() => {
            const format = optionalStringParam(ctx, 'format');
            return format === undefined ? {} : { format };
          })(),
        }),
      );
    }),
  );

  // --- decision -------------------------------------------------------------
  register(
    'decision.condition',
    'decision',
    'Evaluates a typed condition; output is {passed: boolean}.',
    true,
    (params) =>
      isWorkflowCondition(params['condition'])
        ? []
        : [paramIssue('condition', 'must be a typed workflow condition')],
    guarded((ctx) => {
      const condition = ctx.node.params['condition'];
      if (!isWorkflowCondition(condition)) {
        throw new NodeLibraryError('workflow/invalid-params', 'condition is not a typed condition');
      }
      return okResult({ passed: evaluateCondition(condition, ctx) });
    }),
  );

  register(
    'decision.approval',
    'decision',
    'Parks the run as waiting_for_input until a human responds (§23.6); holds no resources.',
    false,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireEnum(params, 'kind', HUMAN_INPUT_REQUEST_KINDS, issues);
      requireString(params, 'prompt', issues);
      validateOptionalRef(params, 'payloadFrom', issues);
      return issues;
    },
    guarded((ctx) => {
      if (ctx.humanInput === undefined) {
        const payloadRef = ctx.node.params['payloadFrom'];
        const payload = isValueRef(payloadRef) ? resolveValueRef(payloadRef, ctx) : undefined;
        const request: HumanInputRequest = {
          kind: stringParam(ctx, 'kind') as HumanInputRequestKind,
          prompt: stringParam(ctx, 'prompt'),
          ...(payload !== undefined ? { payload } : {}),
        };
        return { waiting: true, request };
      }
      return okResult({ response: ctx.humanInput });
    }),
  );

  // --- editor ---------------------------------------------------------------
  register(
    'editor.commandTransaction',
    'editor',
    'Executes one labeled command-bus transaction; never mutates project JSON directly.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'label', issues);
      validateOptionalRef(params, 'commandsFrom', issues);
      if (params['commandsFrom'] === undefined) {
        requireArray(params, 'commands', issues);
      }
      return issues;
    },
    portBacked(
      ports.editor?.executeCommandTransaction,
      'editor.executeCommandTransaction',
      (port, ctx) => {
        const commandsRef = ctx.node.params['commandsFrom'];
        const commands = isValueRef(commandsRef)
          ? resolveValueRef(commandsRef, ctx)
          : ctx.node.params['commands'];
        if (!Array.isArray(commands)) {
          throw new NodeLibraryError(
            'workflow/invalid-params',
            `node "${ctx.node.id}" resolved commands is not an array`,
          );
        }
        return okResult(
          port({
            label: stringParam(ctx, 'label'),
            commands,
            workflowInputs: ctx.workflowInputs,
            projectRevision: ctx.projectRevision,
          }),
        );
      },
    ),
  );

  register(
    'editor.createBranch',
    'editor',
    'Creates an editable project branch/variant from the source reference.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'name', issues);
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.editor?.createBranch, 'editor.createBranch', (port, ctx) =>
      okResult(port({ name: stringParam(ctx, 'name'), source: resolveSource(ctx, 'source') })),
    ),
  );

  // --- render ---------------------------------------------------------------
  const renderValidate = (params: Readonly<Record<string, unknown>>): NodeParamIssue[] => {
    const issues: NodeParamIssue[] = [];
    optionalString(params, 'profile', issues);
    validateOptionalRef(params, 'source', issues);
    return issues;
  };
  const renderHandler = (mode: 'preview' | 'final'): NodeHandler =>
    portBacked(ports.render?.render, 'render.render', (port, ctx) => {
      const profile = optionalStringParam(ctx, 'profile');
      return okResult(
        port({
          mode,
          source: resolveSource(ctx, 'source'),
          ...(profile !== undefined ? { profile } : {}),
        }),
      );
    });

  register(
    'render.preview',
    'render',
    'Renders a review proxy through the deterministic render path.',
    true,
    renderValidate,
    renderHandler('preview'),
  );
  register(
    'render.final',
    'render',
    'Renders the final export through the deterministic render path.',
    true,
    renderValidate,
    renderHandler('final'),
  );
  register(
    'render.inspect',
    'render',
    'Inspects a rendered artifact against a delivery promise and returns a bounded QA report.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      validateOptionalRef(params, 'source', issues);
      validateOptionalRef(params, 'deliveryPromiseFrom', issues);
      optionalString(params, 'reportRef', issues);
      return issues;
    },
    portBacked(ports.render?.inspect, 'render.inspect', (port, ctx) => {
      const deliveryPromiseRef = ctx.node.params['deliveryPromiseFrom'];
      const deliveryPromise = isValueRef(deliveryPromiseRef)
        ? resolveValueRef(deliveryPromiseRef, ctx)
        : undefined;
      const reportRef = optionalStringParam(ctx, 'reportRef');
      return okResult(
        port({
          source: resolveSource(ctx, 'source'),
          ...(deliveryPromise !== undefined ? { deliveryPromise } : {}),
          ...(reportRef !== undefined ? { reportRef } : {}),
        }),
      );
    }),
  );

  // --- output ---------------------------------------------------------------
  register(
    'output.folder',
    'output',
    'Writes the artifact to a local folder reference (opaque id, not a path).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'folderId', issues);
      optionalString(params, 'fileName', issues);
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.output?.writeToFolder, 'output.writeToFolder', (port, ctx) => {
      const fileName = optionalStringParam(ctx, 'fileName');
      return okResult(
        port({
          folderId: stringParam(ctx, 'folderId'),
          artifact: resolveSource(ctx, 'source'),
          ...(fileName !== undefined ? { fileName } : {}),
        }),
      );
    }),
  );

  register(
    'output.metadata',
    'output',
    'Writes a metadata file describing run outputs (auditability, §36 Phase 7).',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'folderId', issues);
      requireString(params, 'fileName', issues);
      validateOptionalRef(params, 'source', issues);
      return issues;
    },
    portBacked(ports.output?.writeMetadataFile, 'output.writeMetadataFile', (port, ctx) =>
      okResult(
        port({
          folderId: stringParam(ctx, 'folderId'),
          fileName: stringParam(ctx, 'fileName'),
          metadata: resolveSource(ctx, 'source'),
        }),
      ),
    ),
  );

  register(
    'output.deliveryManifest',
    'output',
    'Writes a delivery manifest tying the final artifact to QA, approval, and provider references.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      requireString(params, 'folderId', issues);
      requireString(params, 'fileName', issues);
      validateOptionalRef(params, 'source', issues);
      validateOptionalRef(params, 'inspectionFrom', issues);
      validateOptionalRef(params, 'approvalsFrom', issues);
      const providerRefs = params['providerRefs'];
      if (
        providerRefs !== undefined &&
        (!Array.isArray(providerRefs) || providerRefs.some((entry) => typeof entry !== 'string'))
      ) {
        issues.push(paramIssue('providerRefs', 'must be an array of strings when present'));
      }
      return issues;
    },
    portBacked(ports.output?.writeDeliveryManifest, 'output.writeDeliveryManifest', (port, ctx) => {
      const inspectionRef = ctx.node.params['inspectionFrom'];
      const approvalsRef = ctx.node.params['approvalsFrom'];
      const inspection = isValueRef(inspectionRef)
        ? resolveValueRef(inspectionRef, ctx)
        : undefined;
      const approvals = isValueRef(approvalsRef) ? resolveValueRef(approvalsRef, ctx) : undefined;
      const providerRefs = optionalStringArrayParam(ctx, 'providerRefs');
      return okResult(
        port({
          folderId: stringParam(ctx, 'folderId'),
          fileName: stringParam(ctx, 'fileName'),
          artifact: resolveSource(ctx, 'source'),
          ...(inspection !== undefined ? { inspection } : {}),
          ...(approvals !== undefined ? { approvals } : {}),
          ...(providerRefs !== undefined ? { providerRefs } : {}),
        }),
      );
    }),
  );

  // --- control ----------------------------------------------------------------
  register(
    'control.delay',
    'control',
    'Records an intended delay for schedulers; passes its input through unchanged.',
    true,
    (params) => {
      const delayMs = params['delayMs'];
      return typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0
        ? []
        : [paramIssue('delayMs', 'must be a finite number >= 0')];
    },
    guarded((ctx) =>
      okResult({
        delayMs: ctx.node.params['delayMs'],
        passthrough: resolveSource(ctx, 'source'),
      }),
    ),
  );

  register(
    'control.checkpoint',
    'control',
    'Explicit checkpoint boundary marker; passes its input through unchanged.',
    true,
    noParams,
    guarded((ctx) => okResult({ passthrough: resolveSource(ctx, 'source') })),
  );

  register(
    'control.map',
    'control',
    'Runs a sub-workflow once per item (map/batch); item progress survives resumes.',
    true,
    (params) => {
      const issues: NodeParamIssue[] = [];
      if (params['workflow'] === null || typeof params['workflow'] !== 'object') {
        issues.push(paramIssue('workflow', 'must be an inline sub-workflow definition'));
      }
      validateOptionalRef(params, 'itemsFrom', issues);
      return issues;
    },
    guarded((ctx) => {
      const subWorkflow = ctx.node.params['workflow'] as JoyWorkflow;
      const itemsRef = ctx.node.params['itemsFrom'];
      const items = isValueRef(itemsRef)
        ? resolveValueRef(itemsRef, ctx)
        : resolveSource(ctx, 'itemsFrom');
      if (!Array.isArray(items)) {
        throw new NodeLibraryError(
          'workflow/invalid-params',
          `node "${ctx.node.id}" resolved items is not an array`,
        );
      }
      const priorState = mapStateStore.get(ctx.runKey);
      const result = runMapBatch({
        workflow: subWorkflow,
        items,
        runId: `${ctx.runId}/${ctx.node.id}`,
        projectRevision: ctx.projectRevision,
        handlers,
        ...(priorState !== undefined ? { priorState } : {}),
        ...(ctx.node.params['reuseNondeterministic'] === true
          ? { reuseNondeterministic: true }
          : {}),
        ...(ctx.node.params['continueOnItemFailure'] === true
          ? { continueOnItemFailure: true }
          : {}),
      });
      mapStateStore.set(ctx.runKey, result.state);
      if (!result.succeeded) {
        const waiting = result.state.items.some((item) => item.state === 'waiting_for_input');
        return failure(
          waiting ? 'workflow/map-item-waiting' : 'workflow/map-item-failed',
          !waiting,
        );
      }
      return okResult({ count: items.length, items: result.outputs });
    }),
  );

  return { registry, handlers };
}
