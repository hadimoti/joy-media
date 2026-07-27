/**
 * Creative artifacts, provenance, temporal bindings, and the persisted workflow
 * graph — the durable half of Dual Lens (ADR-0022, ADR-0023).
 *
 * Until now the Flow projection was derived: it read timeline clips, visual
 * objects, caption documents, and asset generation records, and inferred a
 * graph from them. That works for what the editor already stores, but a script,
 * a prompt, an analysis result, or an agent change set has no durable identity
 * of its own, so it cannot be versioned, bound to a time range, or cited as the
 * source of something else.
 *
 * These types give that data an identity without flattening it: an artifact
 * knows what kind it is, where its content lives, what produced it, and what it
 * is bound to in time. Unification is by id, ownership, binding, and typed
 * relationship — deliberately not by pretending a transcript is a video clip.
 *
 * Two rules this file exists to enforce:
 *
 * 1. Time stays in integer microseconds (ADR-0002). No durable float seconds.
 * 2. Nothing here is renderable by virtue of existing. Only artifact kinds the
 *    renderer understands may reach Render IR; analysis, prompts, and change
 *    sets influence renderable artifacts through relationships, never by being
 *    silently promoted into fake layers.
 */

import type { ProjectDiagnostic } from './model.js';
import type { TimeUs } from './time.js';

/**
 * Durable permission vocabulary for anything that can act on a project.
 *
 * This is the single list. `@joy-media/agent-tools` aliases its `ToolCapability`
 * to this type rather than keeping a parallel copy, because a capability the
 * policy engine does not recognise is a capability that silently grants
 * nothing — or silently grants everything, depending on which side drifts.
 * It lives here because the dependency runs agent-tools → project-schema.
 */
export type CreativeCapability =
  | 'timeline.read'
  | 'timeline.write'
  | 'assets.read'
  | 'assets.import'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'provider.generate'
  | 'provider.spend'
  | 'render.preview'
  | 'export.write'
  | 'project.overwrite'
  | 'plugin.invoke';

export const CREATIVE_CAPABILITIES: readonly CreativeCapability[] = [
  'timeline.read',
  'timeline.write',
  'assets.read',
  'assets.import',
  'filesystem.read',
  'filesystem.write',
  'provider.generate',
  'provider.spend',
  'render.preview',
  'export.write',
  'project.overwrite',
  'plugin.invoke',
];

/** Capabilities that can spend money or leave the machine. */
export const ESCALATED_CAPABILITIES: readonly CreativeCapability[] = [
  'provider.generate',
  'provider.spend',
  'filesystem.write',
  'export.write',
  'project.overwrite',
  'plugin.invoke',
];

export type CreativeArtifactKind =
  | 'video'
  | 'audio'
  | 'image'
  | 'text'
  | 'script'
  | 'transcript'
  | 'captionDocument'
  | 'htmlScene'
  | 'analysis'
  | 'prompt'
  | 'generatedMedia'
  | 'changeSet'
  | 'renderOutput'
  | 'metadata';

export const CREATIVE_ARTIFACT_KINDS: readonly CreativeArtifactKind[] = [
  'video',
  'audio',
  'image',
  'text',
  'script',
  'transcript',
  'captionDocument',
  'htmlScene',
  'analysis',
  'prompt',
  'generatedMedia',
  'changeSet',
  'renderOutput',
  'metadata',
];

/**
 * Kinds the renderer can evaluate. Everything else influences the picture only
 * by way of a command, never by being handed to Render IR — see §5.4 of the
 * unified-data plan, and the `changeSet`/`analysis` cases in particular.
 */
export const RENDERABLE_ARTIFACT_KINDS: readonly CreativeArtifactKind[] = [
  'video',
  'audio',
  'image',
  'htmlScene',
  'generatedMedia',
  'renderOutput',
];

export function isRenderableArtifactKind(kind: CreativeArtifactKind): boolean {
  return RENDERABLE_ARTIFACT_KINDS.includes(kind);
}

/**
 * The only sanctioned way to hand artifacts to anything that renders.
 *
 * Plan §5.4 and acceptance criterion 7 require that non-renderable data never
 * becomes a fake render layer. Stating that as a rule in prose is not
 * enforceable; making it the single filter every render path calls is, because
 * a caller that wants a script in the picture has to visibly bypass this to get
 * one. Scripts, prompts, analyses, and change sets influence the picture by
 * producing commands — never by being handed to the renderer.
 */
export function selectRenderableArtifacts(
  artifacts: Iterable<CreativeArtifactV2>,
): readonly CreativeArtifactV2[] {
  return [...artifacts].filter((artifact) => isRenderableArtifactKind(artifact.kind));
}

/**
 * Where an artifact's bytes or structure actually live.
 *
 * `inline` is for small structured data that belongs in the document (a prompt,
 * an analysis summary). `asset` points at an existing `AssetRecordV1`, so
 * importing media does not duplicate it. `document` points at another durable
 * document slice already in the project — a caption document, for instance —
 * which is what lets captions gain provenance without being copied.
 */
export type ArtifactContentRef =
  | { readonly type: 'inline'; readonly value: string }
  | { readonly type: 'asset'; readonly assetId: string }
  | { readonly type: 'document'; readonly documentId: string }
  | { readonly type: 'external'; readonly uri: string; readonly contentHash?: string };

/** Who or what produced something. Mirrors the agent envelope's actor. */
export interface CreativeActorRef {
  readonly type: 'human' | 'agent' | 'plugin' | 'system';
  readonly id: string;
}

/**
 * Enough to reproduce a generated artifact as closely as the provider permits.
 *
 * ADR-0019 settled the honest form of the determinism claim: command execution
 * is replayable, generation is not, so generation records provenance instead of
 * promising the same bytes twice. `cost` is recorded because undo can remove an
 * artifact from the project but cannot refund credits already spent.
 */
export interface ArtifactProvenance {
  readonly sourceArtifactIds: readonly string[];
  readonly inputHashes: readonly string[];
  readonly createdBy: CreativeActorRef;
  readonly workflowNodeId?: string;
  readonly jobId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly promptArtifactId?: string;
  readonly seed?: string | number;
  readonly cost?: { readonly amount: string; readonly currency: string };
}

/**
 * How an artifact attaches to the timeline.
 *
 * `global` is project-wide (a brand kit). `none` is deliberately distinct: it
 * means "not placed yet", which the Data Lane drawer renders as an unplaced
 * chip rather than hiding. Ranges are integer microseconds; a range with
 * `durationUs: 0` is a point and should use the `point` form instead, which is
 * why validation rejects it.
 */
export type TemporalBinding =
  | { readonly type: 'global' }
  | { readonly type: 'none' }
  | { readonly type: 'point'; readonly timeUs: TimeUs }
  | { readonly type: 'range'; readonly startUs: TimeUs; readonly durationUs: TimeUs }
  | { readonly type: 'track'; readonly trackId: string }
  | { readonly type: 'item'; readonly itemId: string }
  | { readonly type: 'selection'; readonly selectionId: string };

export interface CreativeArtifactV2 {
  readonly id: string;
  readonly kind: CreativeArtifactKind;
  readonly schemaVersion: number;
  /** Bumped on every content change; artifact versions cite it. */
  readonly revision: number;
  readonly label: string;
  readonly contentRef: ArtifactContentRef;
  readonly binding: TemporalBinding;
  readonly provenance: ArtifactProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Pinned artifacts survive a downstream re-run untouched. */
  readonly pinned?: boolean;
}

/**
 * A retained earlier state of an artifact.
 *
 * Kept as a flat list keyed by artifact rather than a tree, because the product
 * need is "compare, pin, promote, fork" — not arbitrary branching history,
 * which the command transaction log already provides.
 */
export interface ArtifactVersionV2 {
  readonly id: string;
  readonly artifactId: string;
  readonly revision: number;
  readonly contentRef: ArtifactContentRef;
  readonly provenance: ArtifactProvenance;
  readonly createdAt: string;
  readonly pinned?: boolean;
}

export type WorkflowNodeStatus =
  | 'idle'
  | 'ready'
  | 'blocked'
  | 'awaitingApproval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale';

export const WORKFLOW_NODE_STATUSES: readonly WorkflowNodeStatus[] = [
  'idle',
  'ready',
  'blocked',
  'awaitingApproval',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
];

/**
 * A typed connection point. `dataType` names an artifact kind or a domain type
 * such as `Sequence`; validation of which pairs may connect belongs to
 * `workflow-engine`, not to the document schema, so that adding a node type
 * does not require a schema migration.
 */
export interface WorkflowPortV2 {
  readonly id: string;
  readonly label: string;
  readonly dataType: string;
  readonly required: boolean;
  readonly multiple?: boolean;
  /**
   * Extra upstream `dataType`s this input will take, beyond its own.
   *
   * Compatibility is declared by the port rather than looked up in a central
   * type table, so introducing a node type never requires a schema migration —
   * which is the reason ADR-0023 kept type compatibility out of the document
   * format in the first place. `'any'` on an input accepts everything.
   */
  readonly accepts?: readonly string[];
}

/** An input port that takes anything. Kept as a constant so it is greppable. */
export const ANY_PORT_TYPE = 'any';

/**
 * Whether an output may feed an input.
 *
 * Structural and data-driven: exact type match, an explicit `accepts` entry, or
 * an `any` input. There is deliberately no subtype hierarchy — an inheritance
 * tree in the document format would be a migration every time it changed.
 */
export function arePortsCompatible(from: WorkflowPortV2, to: WorkflowPortV2): boolean {
  if (to.dataType === ANY_PORT_TYPE || from.dataType === ANY_PORT_TYPE) return true;
  if (from.dataType === to.dataType) return true;
  return to.accepts?.includes(from.dataType) === true;
}

/** Binds a node to a capability rather than a vendor (§8.3). */
export interface AgentAssignmentV2 {
  readonly roleId: string;
  readonly capability: string;
  readonly permissionProfileId: string;
  readonly approvalPolicyId: string;
  readonly contextPolicyId: string;
  readonly adapterPreference?: string;
  readonly modelPreference?: string;
  readonly budgetPolicyId?: string;
}

export interface NodeExecutionPolicyV2 {
  /** Declared up front so permission denial happens before any work starts. */
  readonly requiredCapabilities: readonly CreativeCapability[];
  readonly requiresApproval: boolean;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export interface WorkflowNodeV2 {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly label: string;
  readonly inputs: readonly WorkflowPortV2[];
  readonly outputs: readonly WorkflowPortV2[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly executionPolicy: NodeExecutionPolicyV2;
  readonly status?: WorkflowNodeStatus;
  readonly binding?: TemporalBinding;
  readonly agentAssignment?: AgentAssignmentV2;
  /**
   * View state only. Creative meaning and execution must never depend on pixel
   * coordinates, which is also why the graph UI library's own node format is
   * not what gets persisted (§13.2).
   */
  readonly ui?: {
    readonly position: { readonly x: number; readonly y: number };
    readonly collapsed?: boolean;
    readonly colorTag?: string;
  };
}

export interface WorkflowEdgeV2 {
  readonly id: string;
  readonly fromNodeId: string;
  readonly fromPortId: string;
  readonly toNodeId: string;
  readonly toPortId: string;
}

export interface WorkflowGraphV2 {
  readonly schemaVersion: number;
  readonly nodes: readonly WorkflowNodeV2[];
  readonly edges: readonly WorkflowEdgeV2[];
}

export const CREATIVE_ARTIFACT_SCHEMA_VERSION = 1;
export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;

export const EMPTY_WORKFLOW_GRAPH: WorkflowGraphV2 = {
  schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
  nodes: [],
  edges: [],
};

// ---------------------------------------------------------------------------
// Validation. Diagnostics rather than throws, matching validateJoyProjectV1, so
// a malformed import reports everything wrong with it in one pass.
// ---------------------------------------------------------------------------

export function validateTemporalBinding(value: unknown, path: string): ProjectDiagnostic[] {
  if (!isRecord(value)) {
    return [diagnostic('BINDING_NOT_OBJECT', 'temporal binding must be an object', path)];
  }
  switch (value.type) {
    case 'global':
    case 'none':
      return [];
    case 'point':
      return isTimeUs(value.timeUs)
        ? []
        : [diagnostic('BINDING_POINT_TIME', 'timeUs must be a non-negative integer', `${path}.timeUs`)];
    case 'range': {
      const diagnostics: ProjectDiagnostic[] = [];
      if (!isTimeUs(value.startUs)) {
        diagnostics.push(
          diagnostic('BINDING_RANGE_START', 'startUs must be a non-negative integer', `${path}.startUs`),
        );
      }
      // A zero-length range is a point wearing the wrong type; rejecting it
      // keeps "does this range contain the playhead" from having two answers.
      if (!isTimeUs(value.durationUs) || value.durationUs === 0) {
        diagnostics.push(
          diagnostic(
            'BINDING_RANGE_DURATION',
            'durationUs must be a positive integer; use a point binding for an instant',
            `${path}.durationUs`,
          ),
        );
      }
      return diagnostics;
    }
    case 'track':
      return isNonEmptyString(value.trackId)
        ? []
        : [diagnostic('BINDING_TRACK_ID', 'trackId must be a non-empty string', `${path}.trackId`)];
    case 'item':
      return isNonEmptyString(value.itemId)
        ? []
        : [diagnostic('BINDING_ITEM_ID', 'itemId must be a non-empty string', `${path}.itemId`)];
    case 'selection':
      return isNonEmptyString(value.selectionId)
        ? []
        : [
            diagnostic(
              'BINDING_SELECTION_ID',
              'selectionId must be a non-empty string',
              `${path}.selectionId`,
            ),
          ];
    default:
      return [
        diagnostic('BINDING_KIND', `unknown temporal binding type "${String(value.type)}"`, `${path}.type`),
      ];
  }
}

export function validateArtifactContentRef(value: unknown, path: string): ProjectDiagnostic[] {
  if (!isRecord(value)) {
    return [diagnostic('CONTENT_REF_NOT_OBJECT', 'contentRef must be an object', path)];
  }
  switch (value.type) {
    case 'inline':
      return typeof value.value === 'string'
        ? []
        : [diagnostic('CONTENT_REF_INLINE', 'inline value must be a string', `${path}.value`)];
    case 'asset':
      return isNonEmptyString(value.assetId)
        ? []
        : [diagnostic('CONTENT_REF_ASSET', 'assetId must be a non-empty string', `${path}.assetId`)];
    case 'document':
      return isNonEmptyString(value.documentId)
        ? []
        : [
            diagnostic(
              'CONTENT_REF_DOCUMENT',
              'documentId must be a non-empty string',
              `${path}.documentId`,
            ),
          ];
    case 'external':
      return isNonEmptyString(value.uri)
        ? []
        : [diagnostic('CONTENT_REF_EXTERNAL', 'uri must be a non-empty string', `${path}.uri`)];
    default:
      return [
        diagnostic('CONTENT_REF_KIND', `unknown contentRef type "${String(value.type)}"`, `${path}.type`),
      ];
  }
}

export function validateArtifactProvenance(value: unknown, path: string): ProjectDiagnostic[] {
  if (!isRecord(value)) {
    return [diagnostic('PROVENANCE_NOT_OBJECT', 'provenance must be an object', path)];
  }
  const diagnostics: ProjectDiagnostic[] = [];
  if (!isStringArray(value.sourceArtifactIds)) {
    diagnostics.push(
      diagnostic(
        'PROVENANCE_SOURCES',
        'sourceArtifactIds must be an array of strings',
        `${path}.sourceArtifactIds`,
      ),
    );
  }
  if (!isStringArray(value.inputHashes)) {
    diagnostics.push(
      diagnostic('PROVENANCE_HASHES', 'inputHashes must be an array of strings', `${path}.inputHashes`),
    );
  }
  const actor = value.createdBy;
  if (
    !isRecord(actor) ||
    !isNonEmptyString(actor.id) ||
    !['human', 'agent', 'plugin', 'system'].includes(String(actor.type))
  ) {
    diagnostics.push(
      diagnostic(
        'PROVENANCE_ACTOR',
        'createdBy must name an actor type of human, agent, plugin, or system, plus an id',
        `${path}.createdBy`,
      ),
    );
  }
  // A generated artifact that cannot say which model made it is not
  // reproducible, and claiming provenance we do not have is worse than none.
  if (isNonEmptyString(value.providerId) && !isNonEmptyString(value.modelId)) {
    diagnostics.push(
      diagnostic(
        'PROVENANCE_MODEL',
        'modelId is required whenever providerId is recorded',
        `${path}.modelId`,
      ),
    );
  }
  return diagnostics;
}

export function validateCreativeArtifact(value: unknown, path: string): ProjectDiagnostic[] {
  if (!isRecord(value)) {
    return [diagnostic('ARTIFACT_NOT_OBJECT', 'artifact must be an object', path)];
  }
  const diagnostics: ProjectDiagnostic[] = [];
  if (!isNonEmptyString(value.id)) {
    diagnostics.push(diagnostic('ARTIFACT_ID', 'id must be a non-empty string', `${path}.id`));
  }
  if (!CREATIVE_ARTIFACT_KINDS.includes(value.kind as CreativeArtifactKind)) {
    diagnostics.push(
      diagnostic('ARTIFACT_KIND', `unknown artifact kind "${String(value.kind)}"`, `${path}.kind`),
    );
  }
  if (!isNonEmptyString(value.label)) {
    diagnostics.push(diagnostic('ARTIFACT_LABEL', 'label must be a non-empty string', `${path}.label`));
  }
  if (!isNonNegativeInteger(value.revision)) {
    diagnostics.push(
      diagnostic('ARTIFACT_REVISION', 'revision must be a non-negative integer', `${path}.revision`),
    );
  }
  diagnostics.push(...validateArtifactContentRef(value.contentRef, `${path}.contentRef`));
  diagnostics.push(...validateTemporalBinding(value.binding, `${path}.binding`));
  diagnostics.push(...validateArtifactProvenance(value.provenance, `${path}.provenance`));
  return diagnostics;
}

export function validateWorkflowGraph(value: unknown, path: string): ProjectDiagnostic[] {
  if (!isRecord(value)) {
    return [diagnostic('GRAPH_NOT_OBJECT', 'workflow graph must be an object', path)];
  }
  const diagnostics: ProjectDiagnostic[] = [];
  const nodes = value.nodes;
  const edges = value.edges;
  if (!Array.isArray(nodes)) {
    diagnostics.push(diagnostic('GRAPH_NODES', 'nodes must be an array', `${path}.nodes`));
    return diagnostics;
  }
  if (!Array.isArray(edges)) {
    diagnostics.push(diagnostic('GRAPH_EDGES', 'edges must be an array', `${path}.edges`));
    return diagnostics;
  }

  const nodeIds = new Set<string>();
  const portsByNode = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();
  nodes.forEach((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    if (!isRecord(node)) {
      diagnostics.push(diagnostic('GRAPH_NODE_NOT_OBJECT', 'node must be an object', nodePath));
      return;
    }
    if (!isNonEmptyString(node.id)) {
      diagnostics.push(diagnostic('GRAPH_NODE_ID', 'node id must be a non-empty string', `${nodePath}.id`));
      return;
    }
    if (nodeIds.has(node.id)) {
      diagnostics.push(
        diagnostic('GRAPH_NODE_DUPLICATE', `duplicate node id "${node.id}"`, `${nodePath}.id`),
      );
    }
    nodeIds.add(node.id);
    if (!isNonEmptyString(node.type)) {
      diagnostics.push(
        diagnostic('GRAPH_NODE_TYPE', 'node type must be a non-empty string', `${nodePath}.type`),
      );
    }
    if (node.status !== undefined && !WORKFLOW_NODE_STATUSES.includes(node.status as WorkflowNodeStatus)) {
      diagnostics.push(
        diagnostic('GRAPH_NODE_STATUS', `unknown node status "${String(node.status)}"`, `${nodePath}.status`),
      );
    }
    if (node.binding !== undefined) {
      diagnostics.push(...validateTemporalBinding(node.binding, `${nodePath}.binding`));
    }
    const policy = node.executionPolicy;
    if (!isRecord(policy)) {
      diagnostics.push(
        diagnostic('GRAPH_NODE_POLICY', 'executionPolicy must be an object', `${nodePath}.executionPolicy`),
      );
    } else {
      const required = policy.requiredCapabilities;
      if (!Array.isArray(required)) {
        diagnostics.push(
          diagnostic(
            'GRAPH_NODE_CAPABILITIES',
            'requiredCapabilities must be an array',
            `${nodePath}.executionPolicy.requiredCapabilities`,
          ),
        );
      } else {
        for (const capability of required) {
          if (!CREATIVE_CAPABILITIES.includes(capability as CreativeCapability)) {
            diagnostics.push(
              diagnostic(
                'GRAPH_NODE_CAPABILITY_UNKNOWN',
                `unknown capability "${String(capability)}"`,
                `${nodePath}.executionPolicy.requiredCapabilities`,
              ),
            );
          }
        }
      }
    }
    portsByNode.set(node.id, {
      inputs: new Set(collectPortIds(node.inputs)),
      outputs: new Set(collectPortIds(node.outputs)),
    });
  });

  edges.forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    if (!isRecord(edge)) {
      diagnostics.push(diagnostic('GRAPH_EDGE_NOT_OBJECT', 'edge must be an object', edgePath));
      return;
    }
    const { fromNodeId, toNodeId, fromPortId, toPortId } = edge;
    if (!isNonEmptyString(fromNodeId) || !nodeIds.has(fromNodeId)) {
      diagnostics.push(
        diagnostic('GRAPH_EDGE_FROM', `edge source node "${String(fromNodeId)}" is not in the graph`, `${edgePath}.fromNodeId`),
      );
    } else if (isNonEmptyString(fromPortId) && !portsByNode.get(fromNodeId)?.outputs.has(fromPortId)) {
      diagnostics.push(
        diagnostic('GRAPH_EDGE_FROM_PORT', `node "${fromNodeId}" has no output port "${fromPortId}"`, `${edgePath}.fromPortId`),
      );
    }
    if (!isNonEmptyString(toNodeId) || !nodeIds.has(toNodeId)) {
      diagnostics.push(
        diagnostic('GRAPH_EDGE_TO', `edge target node "${String(toNodeId)}" is not in the graph`, `${edgePath}.toNodeId`),
      );
    } else if (isNonEmptyString(toPortId) && !portsByNode.get(toNodeId)?.inputs.has(toPortId)) {
      diagnostics.push(
        diagnostic('GRAPH_EDGE_TO_PORT', `node "${toNodeId}" has no input port "${toPortId}"`, `${edgePath}.toPortId`),
      );
    }
  });

  if (nodeIds.size > 0 && findCycle(nodes as readonly WorkflowNodeV2[], edges as readonly WorkflowEdgeV2[])) {
    diagnostics.push(
      diagnostic('GRAPH_CYCLE', 'workflow graph must be acyclic; iteration needs an explicit bounded node', `${path}.edges`),
    );
  }
  return diagnostics;
}

/**
 * Cycle detection over the persisted graph.
 *
 * Lives in the schema rather than only in `workflow-engine` because a cyclic
 * graph must not be *storable*: an imported or hand-edited project that round
 * trips a cycle into the document would fail much later, at execution, far from
 * the edit that caused it.
 */
function findCycle(nodes: readonly WorkflowNodeV2[], edges: readonly WorkflowEdgeV2[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge?.fromNodeId !== 'string' || typeof edge?.toNodeId !== 'string') continue;
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (nodeId: string): boolean => {
    const current = state.get(nodeId);
    if (current === 'visiting') return true;
    if (current === 'done') return false;
    state.set(nodeId, 'visiting');
    for (const next of outgoing.get(nodeId) ?? []) {
      if (visit(next)) return true;
    }
    state.set(nodeId, 'done');
    return false;
  };
  return nodes.some((node) => typeof node?.id === 'string' && visit(node.id));
}

function collectPortIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((port) => (isRecord(port) && isNonEmptyString(port.id) ? [port.id] : []));
}

function diagnostic(code: string, message: string, path: string): ProjectDiagnostic {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimeUs(value: unknown): value is TimeUs {
  return isNonNegativeInteger(value);
}
