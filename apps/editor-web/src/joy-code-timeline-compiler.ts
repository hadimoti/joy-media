import { applyTransaction } from '@joy-media/commands';
import type { SpikeCommand } from '@joy-media/commands';
import { trimCommand } from '@joy-media/timeline-engine';
import type { Clip, SpikeProject, TimelineTrackFamily, Track } from '@joy-media/project-schema';
import type { JoyCodePlanOperationV1, JoyCodeSplitClipOperationV1 } from '@joy-media/agent-tools';
import {
  resolveJoyCodeInsertableAsset,
  type JoyCodeAssetDescriptor,
} from './joy-code-asset-descriptors.js';
import { buildTimelineClipMoveTransaction } from './timeline-clip-interaction.js';

export interface JoyCodeTimelineCompilerInput {
  readonly planId: string;
  readonly project: SpikeProject;
  readonly operations: readonly JoyCodePlanOperationV1[];
  /** Host-owned descriptors, resolved from the canonical project document. */
  readonly registeredAssets: readonly JoyCodeAssetDescriptor[];
  /** Original plan index used for deterministic IDs when compiling incrementally. */
  readonly operationIndex?: number;
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
    | 'JOY_CODE_TIMELINE_ASSET_UNSUPPORTED'
    | 'JOY_CODE_TIMELINE_INCOMPATIBLE_TRACK'
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
    const operationIndex =
      input.operationIndex ??
      input.operations.findIndex((candidate) => candidate.id === operation.id);
    // Resolve each operation against the staged project, just as a manual
    // timeline interaction resolves its target after the previous gesture.
    // This keeps dependent trim/move operations from validating stale source
    // geometry from the initial project snapshot.
    const result = commandsForOperation(operation, { ...input, project: staged }, operationIndex);
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

/**
 * New tracks persist an explicit family. For a legacy row that does not, a
 * visual default is safe for visual media; audio is inferred only when every
 * source clip has a trusted audio descriptor. We never infer from a track
 * label or an opaque asset ID.
 */
function trustedTrackFamily(
  track: Track,
  assets: readonly JoyCodeAssetDescriptor[],
): TimelineTrackFamily {
  if (track.family !== undefined) return track.family;
  if (track.clips.length === 0) return 'visual';
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const sourceAssets = track.clips.flatMap((clip) =>
    clip.kind === 'video' ? [byId.get(clip.assetId)] : [],
  );
  return sourceAssets.length === track.clips.length &&
    sourceAssets.every((asset) => asset?.kind === 'audio')
    ? 'audio'
    : 'visual';
}

function commandsForOperation(
  operation: JoyCodePlanOperationV1,
  input: JoyCodeTimelineCompilerInput,
  operationIndex: number,
): OperationCommandResult {
  switch (operation.kind) {
    case 'timeline.trimClip': {
      const targetResult = resolveEditableTimelineClip(
        input.project,
        operation.id,
        operation.compositionId,
        operation.trackId,
        operation.clipId,
      );
      if ('error' in targetResult) return { ok: false, error: targetResult.error };
      const target = targetResult.target;
      if (
        !isNonNegativeSafeInteger(operation.newStartUs) ||
        !isNonNegativeSafeInteger(operation.newEndUs) ||
        operation.newEndUs <= operation.newStartUs
      )
        return rejectTimelineOperation(
          operation.id,
          'trim range must use non-negative safe integers with an end after its start',
        );
      const originalEndUs = target.clip.startUs + target.clip.durationUs;
      if (operation.newStartUs === target.clip.startUs && operation.newEndUs === originalEndUs)
        return rejectTimelineOperation(
          operation.id,
          `trim for clip "${target.clip.id}" is a no-op`,
        );
      return {
        ok: true,
        commands: [
          // Use the same command factory as TimelinePanel's start/end trim
          // gestures. The only difference is that the two approved gestures
          // are submitted atomically in one reversible transaction.
          trimCommand(
            target.compositionId,
            target.trackId,
            target.clip.id,
            'start',
            operation.newStartUs,
          ),
          trimCommand(
            target.compositionId,
            target.trackId,
            target.clip.id,
            'end',
            operation.newEndUs,
          ),
        ],
        affectedIds: [operation.clipId],
        summary: `Trim ${operation.clipId}`,
      };
    }
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
    case 'timeline.moveClip': {
      const sourceResult = resolveEditableTimelineClip(
        input.project,
        operation.id,
        operation.compositionId,
        operation.sourceTrackId,
        operation.clipId,
      );
      if ('error' in sourceResult) return { ok: false, error: sourceResult.error };
      const source = sourceResult.target;
      const destinationResult = resolveEditableTimelineTrack(
        input.project,
        operation.id,
        operation.compositionId,
        operation.targetTrackId,
      );
      if ('error' in destinationResult) return { ok: false, error: destinationResult.error };
      const destination = destinationResult.target;
      if (!isNonNegativeSafeInteger(operation.newStartUs))
        return rejectTimelineOperation(
          operation.id,
          'move start must be a non-negative safe integer',
        );
      if (source.track.id !== destination.track.id)
        return rejectTimelineOperation(
          operation.id,
          'cross-track moves require a dedicated verified parity path',
        );
      if (operation.newStartUs === source.clip.startUs)
        return rejectTimelineOperation(
          operation.id,
          `move for clip "${source.clip.id}" is a no-op`,
        );
      const manualTransaction = buildTimelineClipMoveTransaction({
        compositionId: source.compositionId,
        sourceTrackId: source.trackId,
        targetTrackId: destination.trackId,
        clip: source.clip,
        targetClips: destination.track.clips,
        newStartUs: operation.newStartUs,
      });
      if (manualTransaction === undefined)
        return rejectTimelineOperation(
          operation.id,
          `move for clip "${source.clip.id}" overlaps an existing clip`,
        );
      const command = manualTransaction.commands[0];
      if (manualTransaction.commands.length !== 1 || command?.type !== 'timeline.moveClip')
        return rejectTimelineOperation(
          operation.id,
          'manual timeline move did not produce the canonical same-track command',
        );
      return {
        ok: true,
        commands: [command],
        affectedIds: [operation.clipId],
        summary: `Move ${operation.clipId}`,
      };
    }
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
      const asset = resolveJoyCodeInsertableAsset(operation.assetId, input.registeredAssets);
      if (!asset.ok)
        return {
          ok: false,
          error: {
            code: asset.code,
            message: asset.message,
            operationId: operation.id,
          },
        };
      const targetTrack = input.project.compositions[operation.compositionId]?.tracks.find(
        (track) => track.id === operation.targetTrackId,
      );
      const targetFamily =
        targetTrack === undefined
          ? undefined
          : trustedTrackFamily(targetTrack, input.registeredAssets);
      if (targetFamily !== undefined && targetFamily !== asset.trackFamily)
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_TIMELINE_INCOMPATIBLE_TRACK',
            message: `asset "${operation.assetId}" requires a ${asset.trackFamily} track; "${operation.targetTrackId}" is ${targetFamily}`,
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
              expectedFamily: asset.trackFamily,
              clip: {
                // The legacy Spike timeline stores both audio and visual media
                // as video-shaped source clips. The expected family remains
                // the canonical semantic guard and drives universal placement.
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

type ResolvedTimelineTrack = {
  readonly compositionId: string;
  readonly trackId: string;
  readonly track: Track;
};

type ResolvedTimelineClip = ResolvedTimelineTrack & {
  readonly clip: Clip;
};

type TimelineTargetResolution<T> =
  { readonly target: T } | { readonly error: JoyCodeTimelineCompileError };

function resolveEditableTimelineTrack(
  project: SpikeProject,
  operationId: string,
  compositionId: unknown,
  trackId: unknown,
): TimelineTargetResolution<ResolvedTimelineTrack> {
  if (!isNonBlankId(compositionId) || !isNonBlankId(trackId))
    return {
      error: timelineOperationError(
        operationId,
        'timeline target identifiers must be non-blank strings',
      ),
    };
  const composition = project.compositions[compositionId];
  if (composition === undefined)
    return {
      error: timelineOperationError(operationId, `composition "${compositionId}" does not exist`),
    };
  const track = composition.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined)
    return {
      error: timelineOperationError(
        operationId,
        `track "${trackId}" does not exist in composition "${compositionId}"`,
      ),
    };
  if (track.locked === true)
    return { error: timelineOperationError(operationId, `track "${trackId}" is locked`) };
  return { target: { compositionId, trackId, track } };
}

function resolveEditableTimelineClip(
  project: SpikeProject,
  operationId: string,
  compositionId: unknown,
  trackId: unknown,
  clipId: unknown,
): TimelineTargetResolution<ResolvedTimelineClip> {
  const targetResult = resolveEditableTimelineTrack(project, operationId, compositionId, trackId);
  if ('error' in targetResult) return targetResult;
  const target = targetResult.target;
  if (!isNonBlankId(clipId))
    return {
      error: timelineOperationError(operationId, 'clip identifier must be a non-blank string'),
    };
  const clips = target.track.clips.filter((candidate) => candidate.id === clipId);
  if (clips.length !== 1)
    return {
      error: timelineOperationError(
        operationId,
        `clip "${clipId}" has ${clips.length} matches on track "${target.trackId}"`,
      ),
    };
  return { target: { ...target, clip: clips[0]! } };
}

function rejectTimelineOperation(operationId: string, message: string): OperationCommandResult {
  return {
    ok: false,
    error: timelineOperationError(operationId, message),
  };
}

function timelineOperationError(operationId: string, message: string): JoyCodeTimelineCompileError {
  return { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED', message, operationId };
}

function isNonBlankId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
