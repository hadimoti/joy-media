import type { CreativeCapability } from '@joy-media/project-schema';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly category: 'query' | 'edit' | 'analysis' | 'provider';
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly scope: ToolScope;
  readonly preconditions: readonly Precondition[];
  readonly estimatedCost?: CostEstimate;
  readonly requiresConfirmation: boolean;
  readonly supportsDryRun: boolean;
  readonly returnsStableIds: boolean;
}

/**
 * Alias, not a copy. The capability vocabulary is durable — a workflow node
 * persists the capabilities it needs — so it belongs in the project schema, and
 * the dependency runs agent-tools → project-schema.
 *
 * Two lists would drift, and a capability the policy engine does not recognise
 * grants nothing while still looking declared, which fails silently in the
 * direction of "the gate did not fire".
 */
export type ToolCapability = CreativeCapability;

export interface ToolScope {
  /** Explicit authority requested by this tool. Empty means no project access. */
  readonly capabilities: readonly ToolCapability[];
  readonly isReversible: boolean;
}

export interface Precondition {
  readonly type:
    | 'entity-exists'
    | 'time-range-valid'
    | 'track-exists'
    | 'provider-available'
    | 'consent-active'
    | 'no-overlap';
  readonly entityId?: string;
  readonly message: string;
}

export interface CostEstimate {
  readonly workerTimeMs?: number;
  readonly providerCost?: { amount: string; currency: string };
  readonly localOnly: boolean;
}

export interface ToolResult {
  readonly success: boolean;
  readonly stableIds?: readonly string[];
  /** Structured query/analysis payload. Must remain JSON-serializable. */
  readonly data?: JsonValue;
  readonly diff?: ToolDiff;
  readonly warnings?: readonly string[];
  readonly error?: string;
}

export interface ToolDiff {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly summary: string;
}

export type JsonSchema = Record<string, unknown>;
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
