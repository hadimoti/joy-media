import { tool, type ToolSet } from 'ai';
import type { ToolCapability } from '@joy-media/agent-tools';
import { z } from 'zod';
import { DEFAULT_JOY_AGENT_LIMITS, type JoyAgentLimits } from './limits.js';
import type { JoyAgentSurface } from './contracts.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const boundedText = z.string().max(4096);

const timelineOperation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('insert'),
      id,
      assetId: id,
      trackId: id,
      startUs: z.number().int().nonnegative(),
      durationUs: z.number().int().positive().max(86_400_000_000),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('remove'),
      id,
      clipId: id,
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('move'),
      id,
      clipId: id,
      trackId: id,
      startUs: z.number().int().nonnegative(),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('trim'),
      id,
      clipId: id,
      startUs: z.number().int().nonnegative(),
      endUs: z.number().int().positive(),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('split'),
      id,
      clipId: id,
      atUs: z.number().int().positive(),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
]);

const documentOperation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('set-text'),
      id,
      objectId: id,
      text: boundedText,
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-property'),
      id,
      objectId: id,
      property: id,
      value: z.union([z.string().max(1024), z.number(), z.boolean()]),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('add-effect'),
      id,
      objectId: id,
      effectId: id,
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
]);

export type JoyTimelineOperation = z.infer<typeof timelineOperation>;
export type JoyDocumentOperation = z.infer<typeof documentOperation>;

export interface JoyAgentToolBridge {
  readonly readProjectSummary: () => Promise<unknown>;
  readonly readSelection: () => Promise<unknown>;
  readonly readTimelineWindow: (input: {
    readonly startUs: number;
    readonly endUs: number;
  }) => Promise<unknown>;
  readonly readAssetMetadata: (input: { readonly assetIds: readonly string[] }) => Promise<unknown>;
  readonly readStyleCatalog: () => Promise<unknown>;
  readonly proposeTimelineOperations: (input: {
    readonly operations: readonly JoyTimelineOperation[];
  }) => Promise<unknown>;
  readonly proposeDocumentOperations: (input: {
    readonly operations: readonly JoyDocumentOperation[];
  }) => Promise<unknown>;
  readonly submitPlan: () => Promise<unknown>;
}

export interface JoyAgentToolMetadata {
  readonly access: 'read' | 'preview' | 'submit';
  readonly capability: ToolCapability;
  readonly activityCode: string;
  readonly surface: JoyAgentSurface;
  readonly parallel: boolean;
}

export const JOY_AGENT_TOOL_METADATA: Readonly<Record<string, JoyAgentToolMetadata>> =
  Object.freeze({
    read_project_summary: {
      access: 'read',
      capability: 'timeline.read',
      activityCode: 'read.project-summary',
      surface: 'joy-code',
      parallel: true,
    },
    read_selection: {
      access: 'read',
      capability: 'timeline.read',
      activityCode: 'read.selection',
      surface: 'joy-code',
      parallel: true,
    },
    read_timeline_window: {
      access: 'read',
      capability: 'timeline.read',
      activityCode: 'read.timeline-window',
      surface: 'timeline',
      parallel: true,
    },
    read_asset_metadata: {
      access: 'read',
      capability: 'assets.read',
      activityCode: 'read.asset-metadata',
      surface: 'asset-library',
      parallel: true,
    },
    read_style_catalog: {
      access: 'read',
      capability: 'assets.read',
      activityCode: 'read.style-catalog',
      surface: 'creative-brief',
      parallel: true,
    },
    propose_timeline_operations: {
      access: 'preview',
      capability: 'timeline.write',
      activityCode: 'preview.timeline',
      surface: 'timeline',
      parallel: false,
    },
    propose_document_operations: {
      access: 'preview',
      capability: 'timeline.write',
      activityCode: 'preview.document',
      surface: 'inspector',
      parallel: false,
    },
    submit_plan: {
      access: 'submit',
      capability: 'timeline.write',
      activityCode: 'approval.requested',
      surface: 'joy-code',
      parallel: false,
    },
  });

export type JoyAgentToolName = keyof typeof JOY_AGENT_TOOL_METADATA;

export function parseJoyTimelineOperations(value: unknown): readonly JoyTimelineOperation[] {
  return parseOperations(timelineOperation, value);
}

export function parseJoyDocumentOperations(value: unknown): readonly JoyDocumentOperation[] {
  return parseOperations(documentOperation, value);
}

function parseOperations<T extends z.ZodTypeAny>(schema: T, value: unknown): readonly z.infer<T>[] {
  const parsed = z
    .array(schema)
    .max(DEFAULT_JOY_AGENT_LIMITS.maxOperations)
    .parse(value) as readonly { readonly id: string; readonly dependsOn: readonly string[] }[];
  validateOperationDependencies(parsed);
  return parsed as readonly z.infer<T>[];
}

export function validateOperationDependencies(
  operations: readonly { readonly id: string; readonly dependsOn: readonly string[] }[],
): void {
  const ids = new Set(operations.map((operation) => operation.id));
  const graph = new Map(operations.map((operation) => [operation.id, operation.dependsOn]));
  for (const operation of operations) {
    if (
      operation.dependsOn.some((dependency) => !ids.has(dependency) || dependency === operation.id)
    )
      throw new Error('JOY_AGENT_INVALID_TOOL');
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operationId: string): void => {
    if (visiting.has(operationId)) throw new Error('JOY_AGENT_INVALID_TOOL');
    if (visited.has(operationId)) return;
    visiting.add(operationId);
    for (const dependency of graph.get(operationId) ?? []) visit(dependency);
    visiting.delete(operationId);
    visited.add(operationId);
  };
  for (const operation of operations) visit(operation.id);
}

class ReadConcurrencyGate {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= DEFAULT_JOY_AGENT_LIMITS.maxConcurrentReads)
      await new Promise<void>((resolve) => this.pending.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.pending.shift()?.();
    }
  }
}

function boundedResult(value: unknown, maxBytes: number): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? 'null';
  } catch {
    throw new Error('JOY_AGENT_INVALID_TOOL');
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes)
    throw new Error('JOY_AGENT_INVALID_TOOL');
  return value;
}

export function createJoyAgentTools(
  bridge: JoyAgentToolBridge,
  limits: JoyAgentLimits = DEFAULT_JOY_AGENT_LIMITS,
): ToolSet {
  const reads = new ReadConcurrencyGate(
    Math.min(limits.maxConcurrentReads, DEFAULT_JOY_AGENT_LIMITS.maxConcurrentReads),
  );
  const maxPayloadBytes = Math.min(
    limits.toolPayloadBytes,
    DEFAULT_JOY_AGENT_LIMITS.toolPayloadBytes,
  );
  const runRead = <T>(operation: () => Promise<T>): Promise<T> => reads.run(operation);
  const operationLimit = Math.min(limits.maxOperations, DEFAULT_JOY_AGENT_LIMITS.maxOperations);
  return {
    read_project_summary: tool({
      description: 'Read a bounded project summary.',
      inputSchema: z.object({}).strict(),
      execute: async () => boundedResult(await runRead(bridge.readProjectSummary), maxPayloadBytes),
    }),
    read_selection: tool({
      description: 'Read the current bounded selection.',
      inputSchema: z.object({}).strict(),
      execute: async () => boundedResult(await runRead(bridge.readSelection), maxPayloadBytes),
    }),
    read_timeline_window: tool({
      description: 'Read a bounded timeline window.',
      inputSchema: z
        .object({ startUs: z.number().int().nonnegative(), endUs: z.number().int().positive() })
        .strict(),
      execute: async (input) =>
        boundedResult(await runRead(() => bridge.readTimelineWindow(input)), maxPayloadBytes),
    }),
    read_asset_metadata: tool({
      description: 'Read bounded metadata for selected assets.',
      inputSchema: z.object({ assetIds: z.array(id).max(32) }).strict(),
      execute: async (input) =>
        boundedResult(await runRead(() => bridge.readAssetMetadata(input)), maxPayloadBytes),
    }),
    read_style_catalog: tool({
      description: 'Read the bounded style catalog.',
      inputSchema: z.object({}).strict(),
      execute: async () => boundedResult(await runRead(bridge.readStyleCatalog), maxPayloadBytes),
    }),
    propose_timeline_operations: tool({
      description: 'Stage validated timeline operations for preview.',
      inputSchema: z
        .object({ operations: z.array(timelineOperation).max(operationLimit) })
        .strict(),
      execute: async (input) => {
        validateOperationDependencies(input.operations);
        return boundedResult(await bridge.proposeTimelineOperations(input), maxPayloadBytes);
      },
    }),
    propose_document_operations: tool({
      description: 'Stage validated document operations for preview.',
      inputSchema: z
        .object({ operations: z.array(documentOperation).max(operationLimit) })
        .strict(),
      execute: async (input) => {
        validateOperationDependencies(input.operations);
        return boundedResult(await bridge.proposeDocumentOperations(input), maxPayloadBytes);
      },
    }),
    submit_plan: tool({
      description: 'Finalize the staged plan for JOY approval.',
      inputSchema: z.object({}).strict(),
      execute: async () => boundedResult(await bridge.submitPlan(), maxPayloadBytes),
    }),
  };
}
