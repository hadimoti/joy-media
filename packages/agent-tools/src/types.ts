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

export type ToolCapability =
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
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
