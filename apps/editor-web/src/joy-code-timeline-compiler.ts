import { applyTransaction } from '@joy-media/commands';
import type { SpikeCommand } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import type { JoyCodePlanOperationV1, JoyCodeSplitClipOperationV1 } from '@joy-media/agent-tools';

export interface JoyCodeTimelineCompilerInput {
  readonly planId: string;
  readonly project: SpikeProject;
  readonly operations: readonly JoyCodePlanOperationV1[];
  readonly registeredAssetIds: readonly string[];
}

export interface JoyCodeTimelineDiffEntry {
  readonly operationId: string;
  readonly kind: JoyCodePlanOperationV1['kind'];
  readonly affectedIds: readonly string[];
  readonly summary: string;
}

export interface JoyCodeTimelineCompileError {
  readonly code:
    | 'JOY_CODE_TIMELINE_INVALID_OPERATION'
    | 'JOY_CODE_TIMELINE_DEPENDENCY_MISSING'
    | 'JOY_CODE_TIMELINE_DEPENDENCY_CYCLE'
    | 'JOY_CODE_TIMELINE_ASSET_UNAVAILABLE'
    | 'JOY_CODE_TIMELINE_COMMAND_REJECTED';
  readonly message: string;
  readonly operationId?: string;
}

export type JoyCodeTimelineCompileResult =
  | {
      readonly ok: true;
      readonly commands: readonly SpikeCommand[];
      readonly diffs: readonly JoyCodeTimelineDiffEntry[];
      readonly affectedIds: readonly string[];
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: JoyCodeTimelineCompileError };

export function compileJoyCodeTimelineOperations(
  input: JoyCodeTimelineCompilerInput,
): JoyCodeTimelineCompileResult {
  const byId = new Map(input.operations.map((operation) => [operation.id, operation]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: JoyCodePlanOperationV1[] = [];

  const visit = (id: string): JoyCodeTimelineCompileError | undefined => {
    if (visiting.has(id))
      return {
        code: 'JOY_CODE_TIMELINE_DEPENDENCY_CYCLE',
        message: 'operation dependencies contain a cycle',
        operationId: id,
      };
    if (visited.has(id)) return undefined;
    const operation = byId.get(id);
    if (operation === undefined)
      return {
        code: 'JOY_CODE_TIMELINE_DEPENDENCY_MISSING',
        message: `operation dependency "${id}" does not exist`,
        operationId: id,
      };
    visiting.add(id);
    for (const dependency of operation.dependsOn) {
      const error = visit(dependency);
      if (error !== undefined) return error;
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(operation);
    return undefined;
  };

  for (const operation of input.operations) {
    const error = visit(operation.id);
    if (error !== undefined) return { ok: false, error };
  }

  let staged = input.project;
  const commands: SpikeCommand[] = [];
  const diffs: JoyCodeTimelineDiffEntry[] = [];
  const affectedIds = new Set<string>();

  for (const operation of ordered) {
    const operationIndex = input.operations.findIndex((candidate) => candidate.id === operation.id);
    const result = commandsForOperation(operation, input, operationIndex);
    if (!result.ok) return result;
    try {
      const transaction = applyTransaction(staged, {
        label: `Joy Code ${operation.kind}`,
        commands: result.commands,
      });
      staged = transaction.project;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED',
          message: error instanceof Error ? error.message : 'timeline command rejected',
          operationId: operation.id,
        },
      };
    }
    commands.push(...result.commands);
    diffs.push({
      operationId: operation.id,
      kind: operation.kind,
      affectedIds: result.affectedIds,
      summary: result.summary,
    });
    for (const id of result.affectedIds) affectedIds.add(id);
  }

  return { ok: true, commands, diffs, affectedIds: [...affectedIds], warnings: [] };
}

type OperationCommandResult =
  | {
      readonly ok: true;
      readonly commands: readonly SpikeCommand[];
      readonly affectedIds: readonly string[];
      readonly summary: string;
    }
  | { readonly ok: false; readonly error: JoyCodeTimelineCompileError };

function commandsForOperation(
  operation: JoyCodePlanOperationV1,
  input: JoyCodeTimelineCompilerInput,
  operationIndex: number,
): OperationCommandResult {
  const target = operation as JoyCodePlanOperationV1 & Record<string, unknown>;
  switch (operation.kind) {
    case 'timeline.trimClip':
      return {
        ok: true,
        commands: [
          {
            type: 'timeline.trimClipStart',
            payload: {
              compositionId: operation.compositionId,
              trackId: operation.trackId,
              clipId: operation.clipId,
              newStartUs: operation.newStartUs,
            },
          },
          {
            type: 'timeline.trimClipEnd',
            payload: {
              compositionId: operation.compositionId,
              trackId: operation.trackId,
              clipId: operation.clipId,
              newEndUs: operation.newEndUs,
            },
          },
        ],
        affectedIds: [operation.clipId],
        summary: `Trim ${operation.clipId}`,
      };
    case 'timeline.splitClip': {
      const split = operation as JoyCodeSplitClipOperationV1;
      const newClipId = `${input.planId}-split-${operationIndex}`;
      return {
        ok: true,
        commands: [
          {
            type: 'timeline.splitClip',
            payload: {
              compositionId: split.compositionId,
              trackId: split.trackId,
              clipId: split.clipId,
              atUs: split.atUs,
              newClipId,
            },
          },
        ],
        affectedIds: [split.clipId, newClipId],
        summary: `Split ${split.clipId}`,
      };
    }
    case 'timeline.moveClip':
      return {
        ok: true,
        commands: [
          operation.sourceTrackId === operation.targetTrackId
            ? {
                type: 'timeline.moveClip',
                payload: {
                  compositionId: operation.compositionId,
                  trackId: operation.sourceTrackId,
                  clipId: operation.clipId,
                  newStartUs: operation.newStartUs,
                },
              }
            : {
                type: 'timeline.moveElement',
                payload: {
                  compositionId: operation.compositionId,
                  sourceTrackId: operation.sourceTrackId,
                  targetTrackId: operation.targetTrackId,
                  clipId: operation.clipId,
                  newStartUs: operation.newStartUs,
                  expectedFamily: 'visual',
                },
              },
        ],
        affectedIds: [operation.clipId],
        summary: `Move ${operation.clipId}`,
      };
    case 'timeline.removeClip':
      return {
        ok: true,
        commands: [
          {
            type: 'timeline.removeClip',
            payload: {
              compositionId: operation.compositionId,
              trackId: operation.trackId,
              clipId: operation.clipId,
            },
          },
        ],
        affectedIds: [operation.clipId],
        summary: `Remove ${operation.clipId}`,
      };
    case 'timeline.insertExistingAsset': {
      if (!input.registeredAssetIds.includes(operation.assetId))
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_TIMELINE_ASSET_UNAVAILABLE',
            message: `asset "${operation.assetId}" is not registered and playable`,
            operationId: operation.id,
          },
        };
      const clipId = `${input.planId}-asset-${operationIndex}`;
      return {
        ok: true,
        commands: [
          {
            type: 'timeline.insertClip',
            payload: {
              compositionId: operation.compositionId,
              trackId: operation.targetTrackId,
              expectedFamily: 'visual',
              clip: {
                kind: 'video',
                id: clipId,
                startUs: operation.startUs,
                durationUs: operation.durationUs,
                assetId: operation.assetId,
                sourceInUs: 0,
              },
            },
          },
        ],
        affectedIds: [clipId, operation.assetId],
        summary: `Insert ${operation.assetId}`,
      };
    }
    default:
      void target;
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TIMELINE_INVALID_OPERATION',
          message: `operation ${operation.kind} is not a timeline operation`,
          operationId: operation.id,
        },
      };
  }
}
