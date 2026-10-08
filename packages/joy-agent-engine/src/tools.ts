import { tool, type ToolSet } from 'ai';
import type { ToolCapability } from '@joy-media/agent-tools';
import { z } from 'zod';
import { DEFAULT_JOY_AGENT_LIMITS, type JoyAgentLimits } from './limits.js';
import type { JoyAgentSurface } from './contracts.js';
import { KILO_MODEL_PRESETS } from './provider-presets.js';
import {
  JOY_LOOK_PRESETS,
  normalizeDocumentOperationAliases,
  normalizeTimelineOperationAliases,
} from './aliases.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
/**
 * Models often add the clip's timeline start to a submit_plan checklist item (BUGS.md 9).
 * It is accepted so the plan isn't rejected, then dropped: start positions are verified by
 * the CLI from the user's request, not from the checklist.
 */
const checklistStartHint = {
  timelineStartUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};
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
      sourceInUs: z.number().int().nonnegative(),
      sourceOutUs: z.number().int().positive(),
      timelineStartUs: z.number().int().nonnegative().optional(),
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
      kind: z.literal('create-text'),
      id,
      trackId: id.optional(),
      text: boundedText,
      startUs: z.number().int().nonnegative(),
      durationUs: z.number().int().positive().max(86_400_000_000),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      size: z.number().finite().min(0.1).max(8).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
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
      effectId: z.enum(JOY_LOOK_PRESETS),
      intensity: z.number().finite().min(0).max(1).optional(),
      scanlineStrength: z.number().finite().min(0).max(1).optional(),
      noiseAmount: z.number().finite().min(0).max(1).optional(),
      dependsOn: z.array(id).max(32).default([]),
    })
    .strict(),
]);

export type JoyTimelineOperation = z.infer<typeof timelineOperation>;
export type JoyDocumentOperation = z.infer<typeof documentOperation>;
export type JoyPlanChecklistItem =
  | {
      readonly kind: 'trim';
      readonly clipId: string;
      readonly sourceInUs: number;
      readonly sourceOutUs: number;
    }
  | { readonly kind: 'text'; readonly text: string; readonly position?: 'center' | undefined }
  | {
      readonly kind: 'look';
      readonly clipId: string;
      readonly look: 'crt' | 'bw' | 'warm' | 'cool';
    };

export interface JoyAgentToolBridge {
  readonly hasSubmittedPlan?: () => boolean;
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
  readonly submitPlan: (input?: {
    readonly checklist: readonly JoyPlanChecklistItem[];
  }) => Promise<unknown>;
  /** Optional domain readers/proposers keep media surfaces on the same bridge. */
  readonly readBrief?: () => Promise<unknown>;
  readonly readScene3d?: () => Promise<unknown>;
  readonly readFrame?: (input: { readonly atUs: number; readonly maxEdge?: number }) => Promise<
    | {
        readonly mediaType: 'image/png' | 'image/jpeg';
        readonly base64: string;
        readonly width: number;
        readonly height: number;
      }
    | { readonly unavailable: string }
  >;
  readonly proposeAsset?: (input: {
    readonly assetId: string;
    readonly summary: string;
  }) => Promise<unknown>;
  readonly proposeBrief?: (input: { readonly summary: string }) => Promise<unknown>;
  readonly proposeScene3d?: (input: {
    readonly sceneId: string;
    readonly summary: string;
  }) => Promise<unknown>;
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
    read_brief: {
      access: 'read',
      capability: 'timeline.read',
      activityCode: 'read.brief',
      surface: 'creative-brief',
      parallel: true,
    },
    read_scene_3d: {
      access: 'read',
      capability: 'render.preview',
      activityCode: 'read.scene-3d',
      surface: 'scene-3d',
      parallel: true,
    },
    read_frame: {
      access: 'read',
      capability: 'assets.read',
      activityCode: 'read.frame',
      surface: 'joy-code',
      parallel: false,
    },
    propose_asset: {
      access: 'preview',
      capability: 'assets.import',
      activityCode: 'preview.asset',
      surface: 'asset-library',
      parallel: false,
    },
    propose_brief: {
      access: 'preview',
      capability: 'timeline.write',
      activityCode: 'preview.brief',
      surface: 'creative-brief',
      parallel: false,
    },
    propose_scene_3d: {
      access: 'preview',
      capability: 'render.preview',
      activityCode: 'preview.scene-3d',
      surface: 'scene-3d',
      parallel: false,
    },
  });

export type JoyAgentToolName = keyof typeof JOY_AGENT_TOOL_METADATA;

export function parseJoyTimelineOperations(value: unknown): readonly JoyTimelineOperation[] {
  return parseJoyTimelineOperationsDetailed(value).operations;
}

export function parseJoyTimelineOperationsDetailed(input: unknown): {
  readonly operations: readonly JoyTimelineOperation[];
  readonly deprecationNote?: string;
} {
  const withKinds = normalizeTimelineOperationAliases(input);
  if (!Array.isArray(withKinds))
    return { operations: parseOperations(timelineOperation, withKinds) };
  const aliases = new Set<string>();
  const acceptedFields = [
    'kind',
    'id',
    'clipId',
    'sourceInUs',
    'sourceOutUs',
    'timelineStartUs',
    'startUs',
    'endUs',
    'trimStartUs',
    'trimEndUs',
    'inUs',
    'outUs',
    'trimLeftUs',
    'trimRightUs',
    'dependsOn',
  ];
  const normalized = withKinds.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      (candidate as { kind?: unknown }).kind !== 'trim'
    )
      return candidate;
    const record = candidate as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !acceptedFields.includes(key));
    const amountAliases = ['trimLeftUs', 'trimRightUs', 'trimStartUs', 'trimEndUs'].filter(
      (key) => record[key] !== undefined,
    );
    if (amountAliases.length)
      throw new Error(
        `${amountAliases.join(', ')} are trim amounts, not source positions; use sourceInUs/sourceOutUs explicitly.`,
      );
    if (unknown.length)
      throw new Error(
        `Unknown trim field(s): ${unknown.join(', ')}. Valid fields: sourceInUs, sourceOutUs, timelineStartUs (aliases: startUs/endUs, trimStartUs/trimEndUs, inUs/outUs, trimLeftUs/trimRightUs).`,
      );
    const choose = (primary: string, choices: string[]) => {
      if (record[primary] !== undefined) return record[primary];
      for (const alias of choices)
        if (record[alias] !== undefined) {
          aliases.add(alias);
          return record[alias];
        }
      return undefined;
    };
    const {
      startUs: _start,
      endUs: _end,
      trimStartUs: _trimStart,
      trimEndUs: _trimEnd,
      inUs: _in,
      outUs: _out,
      trimLeftUs: _left,
      trimRightUs: _right,
      ...rest
    } = record;
    return {
      ...rest,
      sourceInUs: choose('sourceInUs', ['startUs', 'trimStartUs', 'inUs', 'trimLeftUs']),
      sourceOutUs: choose('sourceOutUs', ['endUs', 'trimEndUs', 'outUs', 'trimRightUs']),
    };
  });
  return {
    operations: parseOperations(timelineOperation, normalized),
    ...(aliases.size
      ? {
          deprecationNote: `Deprecated trim aliases used (${[...aliases].join(', ')}); use sourceInUs/sourceOutUs and optional timelineStartUs.`,
        }
      : {}),
  };
}

const proposalInput = (operationLimit: number) =>
  z.object({ operations: z.array(z.unknown()).max(operationLimit) }).strict();

function proposalErrorResult(
  errors: readonly string[],
  attempts: number,
): {
  accepted: false;
  retryable: boolean;
  validationErrors: readonly string[];
} {
  return {
    accepted: false,
    retryable: attempts < 3,
    validationErrors: errors.slice(0, 32),
  };
}

function proposalValidationErrors(result: unknown): string[] {
  if (result === null || typeof result !== 'object') return [];
  const record = result as { accepted?: unknown; errors?: unknown };
  if (record.accepted !== false) return [];
  if (Array.isArray(record.errors)) return record.errors.map(String).slice(0, 32);
  return ['Proposal was rejected by project validation.'];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseJoyDocumentOperations(value: unknown): readonly JoyDocumentOperation[] {
  return parseOperations(documentOperation, normalizeDocumentOperationAliases(value));
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
  options: {
    readonly modelId?: string;
    readonly allowFrames?: boolean;
    readonly vision?: boolean;
    readonly onFrameRead?: (frame: {
      readonly mediaType: 'image/png' | 'image/jpeg';
      readonly base64: string;
      readonly width: number;
      readonly height: number;
    }) => void;
  } = {},
): ToolSet {
  const reads = new ReadConcurrencyGate(
    Math.min(limits.maxConcurrentReads, DEFAULT_JOY_AGENT_LIMITS.maxConcurrentReads),
  );
  const maxPayloadBytes = Math.min(
    limits.toolPayloadBytes,
    DEFAULT_JOY_AGENT_LIMITS.toolPayloadBytes,
  );
  const maxFrameReads = Math.min(limits.maxFrameReads, DEFAULT_JOY_AGENT_LIMITS.maxFrameReads);
  const runRead = <T>(operation: () => Promise<T>): Promise<T> => reads.run(operation);
  const operationLimit = Math.min(limits.maxOperations, DEFAULT_JOY_AGENT_LIMITS.maxOperations);
  const tools: ToolSet = {
    read_project_summary: tool({
      description: 'Read a bounded project summary.',
      inputSchema: z.object({}).strict(),
      execute: async () =>
        boundedResult(await runRead(() => bridge.readProjectSummary()), maxPayloadBytes),
    }),
    read_selection: tool({
      description: 'Read the current bounded selection.',
      inputSchema: z.object({}).strict(),
      execute: async () =>
        boundedResult(await runRead(() => bridge.readSelection()), maxPayloadBytes),
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
      execute: async () =>
        boundedResult(await runRead(() => bridge.readStyleCatalog()), maxPayloadBytes),
    }),
    propose_timeline_operations: tool({
      description:
        'Propose timeline operations. Each operation needs a unique id and schema-valid fields; the tool returns validation errors for repair and retry (up to three invalid proposals). Time values use integer microseconds. For trim, sourceInUs/sourceOutUs are positions into the SOURCE media, and timelineStartUs is optional. Example: keep source 7 s to 17 s => sourceInUs: 7000000, sourceOutUs: 17000000. Trimming changes the visible duration; use move to change timeline position.',
      inputSchema: proposalInput(operationLimit),
      execute: async (input) => {
        let operations: readonly JoyTimelineOperation[];
        let deprecationNote: string | undefined;
        try {
          const parsed = parseJoyTimelineOperationsDetailed(input.operations);
          operations = parsed.operations;
          deprecationNote = parsed.deprecationNote;
          validateOperationDependencies(operations);
        } catch (error) {
          const attempts = ++invalidTimelineProposals;
          return proposalErrorResult(
            [error instanceof Error ? error.message : String(error)],
            attempts,
          );
        }
        const result = await bridge.proposeTimelineOperations({ operations });
        const invalid = proposalValidationErrors(result);
        if (invalid.length > 0) {
          const attempts = ++invalidTimelineProposals;
          const rejected = proposalErrorResult(invalid, attempts);
          return deprecationNote ? { ...rejected, note: deprecationNote } : rejected;
        }
        return boundedResult(
          deprecationNote ? { ...asRecord(result), note: deprecationNote } : result,
          maxPayloadBytes,
        );
      },
    }),
    propose_document_operations: tool({
      description:
        'Propose document operations. Batch all requested changes in one call, then submit_plan once. add-effect applies one of the supported looks (crt, bw, warm, cool) to a video clip; optional intensity, scanlineStrength, and noiseAmount are each 0..1. For create-text, x and y are editor-normalized frame fractions in [-0.4, 0.4]; 0 is centered and omitted values default to center. size is a template multiplier from 0.1 to 8. durationUs is an integer number of microseconds (10 seconds = 10000000) and must be at least one frame at project fps. Schema and project validation errors are returned so you can repair and retry (up to three invalid proposals).',
      inputSchema: proposalInput(operationLimit),
      execute: async (input) => {
        let operations: readonly JoyDocumentOperation[];
        try {
          operations = parseJoyDocumentOperations(input.operations);
          validateOperationDependencies(operations);
        } catch (error) {
          const attempts = ++invalidDocumentProposals;
          return proposalErrorResult(
            [error instanceof Error ? error.message : String(error)],
            attempts,
          );
        }
        const result = await bridge.proposeDocumentOperations({ operations });
        const invalid = proposalValidationErrors(result);
        if (invalid.length > 0) {
          const attempts = ++invalidDocumentProposals;
          return proposalErrorResult(invalid, attempts);
        }
        return boundedResult(result, maxPayloadBytes);
      },
    }),
    read_brief: tool({
      description: 'Read the current bounded Creative Brief state.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        if (bridge.readBrief === undefined) throw new Error('JOY_AGENT_UNAVAILABLE');
        return boundedResult(await runRead(() => bridge.readBrief!()), maxPayloadBytes);
      },
    }),
    read_scene_3d: tool({
      description: 'Read the current bounded 3D scene state.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        if (bridge.readScene3d === undefined) throw new Error('JOY_AGENT_UNAVAILABLE');
        return boundedResult(await runRead(() => bridge.readScene3d!()), maxPayloadBytes);
      },
    }),
    propose_asset: tool({
      description: 'Stage a bounded asset edit for explicit approval.',
      inputSchema: z.object({ assetId: id, summary: boundedText }).strict(),
      execute: async (input) => {
        if (bridge.proposeAsset === undefined) throw new Error('JOY_AGENT_UNAVAILABLE');
        return boundedResult(await bridge.proposeAsset(input), maxPayloadBytes);
      },
    }),
    propose_brief: tool({
      description: 'Stage a bounded Creative Brief hand-off for review.',
      inputSchema: z.object({ summary: boundedText }).strict(),
      execute: async (input) => {
        if (bridge.proposeBrief === undefined) throw new Error('JOY_AGENT_UNAVAILABLE');
        return boundedResult(await bridge.proposeBrief(input), maxPayloadBytes);
      },
    }),
    propose_scene_3d: tool({
      description: 'Stage a bounded 3D scene operation for explicit approval.',
      inputSchema: z.object({ sceneId: id, summary: boundedText }).strict(),
      execute: async (input) => {
        if (bridge.proposeScene3d === undefined) throw new Error('JOY_AGENT_UNAVAILABLE');
        return boundedResult(await bridge.proposeScene3d(input), maxPayloadBytes);
      },
    }),
    submit_plan: tool({
      description:
        'Finalize the staged plan for JOY approval. Include a non-empty checklist that covers every staged operation type and each requested outcome (trim source range, centered text, look, start position, or duration) so the CLI can verify the final timeline. The CLI independently checks explicit outcomes from the user request.',
      inputSchema: z
        .object({
          checklist: z
            .array(
              z.discriminatedUnion('kind', [
                z
                  .object({
                    kind: z.literal('trim'),
                    clipId: id,
                    sourceInUs: z.number().int().nonnegative(),
                    sourceOutUs: z.number().int().positive(),
                    ...checklistStartHint,
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal('text'),
                    text: boundedText,
                    position: z.literal('center').optional(),
                    ...checklistStartHint,
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal('look'),
                    clipId: id,
                    look: z.enum(JOY_LOOK_PRESETS),
                    ...checklistStartHint,
                  })
                  .strict(),
              ]),
            )
            .min(1)
            .max(12)
            .default([]),
        })
        .strict(),
      execute: async (input) =>
        boundedResult(
          await bridge.submitPlan({
            // The start hint is informational: the CLI checks start positions from the request.
            checklist: input.checklist.map(
              ({ timelineStartUs: _timelineStartUs, ...item }) => item,
            ),
          }),
          maxPayloadBytes,
        ),
    }),
  };
  let invalidTimelineProposals = 0;
  let invalidDocumentProposals = 0;
  // An explicit vision flag always wins (the host warns for routed/text-only models);
  // otherwise only presets known to accept images get frame reads. openrouter/free routes
  // to an unknown model, so it stays text-only by default.
  const visionCapable =
    options.vision ??
    KILO_MODEL_PRESETS.some((preset) => preset.id === options.modelId && preset.vision);
  if (bridge.readFrame && visionCapable && options.allowFrames) {
    let frameReads = 0;
    tools.read_frame = tool({
      description: 'Read one bounded frame from the local timeline for visual inspection.',
      inputSchema: z
        .object({
          atUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          maxEdge: z.number().int().positive().max(1024).optional(),
        })
        .strict(),
      execute: async (input) => {
        if (frameReads >= maxFrameReads) return { unavailable: 'Frame read limit reached.' };
        frameReads += 1;
        const maxEdge = Math.min(input.maxEdge ?? 1024, 1024);
        const result = await runRead(() => bridge.readFrame!({ atUs: input.atUs, maxEdge }));
        if ('unavailable' in result) return result;
        if (
          !Number.isSafeInteger(result.width) ||
          !Number.isSafeInteger(result.height) ||
          result.width < 1 ||
          result.height < 1 ||
          result.width > maxEdge ||
          result.height > maxEdge
        )
          return { unavailable: 'Frame dimensions exceed the requested edge limit.' };
        if (new TextEncoder().encode(result.base64).byteLength > maxPayloadBytes)
          return { unavailable: 'Frame exceeds the tool payload limit.' };
        options.onFrameRead?.(result);
        return { acknowledgement: 'Frame attached in the next user message.' };
      },
    });
  }
  return tools;
}
