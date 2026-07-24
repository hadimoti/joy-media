import type { SpikeCommand } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import type { Clip } from '@joy-media/project-schema';
import type { EditorContext } from './context.js';
import type { JsonValue, Precondition, ToolDefinition, ToolDiff, ToolResult } from './types.js';

/**
 * Dispatches a real transaction when the context is bound to a live command
 * bus (editor-web always binds one; planning/test contexts may not). Returns
 * `undefined` when there is nothing to check (no dispatcher bound) so the
 * caller falls back to its historical preview-shaped result; returns a real
 * failure `ToolResult` when the bound bus rejects the transaction.
 */
function dispatchOrUndefined(
  context: EditorContext,
  commands: readonly SpikeCommand[],
  label: string,
): ToolResult | undefined {
  if (!context.dispatch) return undefined;
  const result = context.dispatch.dispatchTimeline(commands, label);
  if (!result.success) {
    return { success: false, error: result.error ?? `${label} failed` };
  }
  return undefined;
}

export interface EditTool {
  readonly name: string;
  readonly description: string;
  readonly commandType: string;
  readonly definition: ToolDefinition;
  execute(context: EditorContext, input: JsonValue): ToolResult;
  dryRun(context: EditorContext, input: JsonValue): ToolDiff;
  checkPreconditions(context: EditorContext, input: JsonValue): readonly Precondition[];
}

export function createInsertClipTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'insertClip',
    description: 'Insert a non-overlapping clip into a track',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        compositionId: { type: 'string' },
        trackId: { type: 'string' },
        clip: { type: 'object' },
      },
      required: ['compositionId', 'trackId', 'clip'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: true,
      affectsTimeline: true,
      affectsAudio: false,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'timeline.insertClip',
    definition,
    execute: (context, input) => {
      const preconditions = checkInsertClipPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || !isRecord(input.clip) || typeof input.clip.id !== 'string') {
        return { success: false, error: 'invalid clip structure' };
      }

      if (context.dispatch) {
        if (typeof input.compositionId !== 'string' || typeof input.trackId !== 'string') {
          return { success: false, error: 'compositionId and trackId are required to dispatch' };
        }
        const failure = dispatchOrUndefined(
          context,
          [
            {
              type: 'timeline.insertClip',
              payload: {
                compositionId: input.compositionId,
                trackId: input.trackId,
                clip: input.clip as unknown as Clip,
              },
            },
          ],
          `Insert clip ${input.clip.id}`,
        );
        if (failure) return failure;
      }

      return {
        success: true,
        stableIds: [input.clip.id],
        diff: {
          created: [input.clip.id],
          modified: [],
          deleted: [],
          summary: `Inserted clip ${input.clip.id}`,
        },
      };
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || !isRecord(input.clip) || typeof input.clip.id !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [input.clip.id],
        modified: [],
        deleted: [],
        summary: `Would insert clip ${input.clip.id}`,
      };
    },
    checkPreconditions: (context, input) => checkInsertClipPreconditions(context, input),
  };
}

function checkInsertClipPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.compositionId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'compositionId is required',
    });
  }

  if (typeof input.trackId !== 'string') {
    preconditions.push({
      type: 'track-exists',
      message: 'trackId is required',
    });
  }

  if (!isRecord(input.clip)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'clip is required',
    });
  }

  return preconditions;
}

export function createRemoveClipTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'removeClip',
    description: 'Remove a clip while preserving it in the inverse',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        compositionId: { type: 'string' },
        trackId: { type: 'string' },
        clipId: { type: 'string' },
      },
      required: ['compositionId', 'trackId', 'clipId'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: true,
      affectsTimeline: true,
      affectsAudio: false,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'timeline.removeClip',
    definition,
    execute: (context, input) => {
      const preconditions = checkRemoveClipPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { success: false, error: 'invalid input' };
      }

      if (context.dispatch) {
        if (typeof input.compositionId !== 'string' || typeof input.trackId !== 'string') {
          return { success: false, error: 'compositionId and trackId are required to dispatch' };
        }
        const failure = dispatchOrUndefined(
          context,
          [
            {
              type: 'timeline.removeClip',
              payload: {
                compositionId: input.compositionId,
                trackId: input.trackId,
                clipId: input.clipId,
              },
            },
          ],
          `Remove clip ${input.clipId}`,
        );
        if (failure) return failure;
      }

      return {
        success: true,
        stableIds: [input.clipId],
        diff: {
          created: [],
          modified: [],
          deleted: [input.clipId],
          summary: `Removed clip ${input.clipId}`,
        },
      };
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [],
        deleted: [input.clipId],
        summary: `Would remove clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkRemoveClipPreconditions(context, input),
  };
}

function checkRemoveClipPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  return preconditions;
}

export function createMoveClipTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'moveClip',
    description: 'Move a clip within its track',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        compositionId: { type: 'string' },
        trackId: { type: 'string' },
        clipId: { type: 'string' },
        newStartUs: { type: 'number' },
      },
      required: ['compositionId', 'trackId', 'clipId', 'newStartUs'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: true,
      affectsTimeline: true,
      affectsAudio: false,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'timeline.moveClip',
    definition,
    execute: (context, input) => {
      const preconditions = checkMoveClipPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (
        !isRecord(input) ||
        typeof input.clipId !== 'string' ||
        typeof input.newStartUs !== 'number'
      ) {
        return { success: false, error: 'invalid input' };
      }

      if (context.dispatch) {
        if (typeof input.compositionId !== 'string' || typeof input.trackId !== 'string') {
          return { success: false, error: 'compositionId and trackId are required to dispatch' };
        }
        const failure = dispatchOrUndefined(
          context,
          [
            {
              type: 'timeline.moveClip',
              payload: {
                compositionId: input.compositionId,
                trackId: input.trackId,
                clipId: input.clipId,
                newStartUs: input.newStartUs,
              },
            },
          ],
          `Move clip ${input.clipId}`,
        );
        if (failure) return failure;
      }

      return {
        success: true,
        stableIds: [input.clipId],
        diff: {
          created: [],
          modified: [input.clipId],
          deleted: [],
          summary: `Moved clip ${input.clipId}`,
        },
      };
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.clipId],
        deleted: [],
        summary: `Would move clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkMoveClipPreconditions(context, input),
  };
}

function checkMoveClipPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  if (typeof input.newStartUs !== 'number' || input.newStartUs < 0) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'newStartUs must be a non-negative number',
    });
  }

  return preconditions;
}

export function createTrimClipTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'trimClip',
    description: 'Trim a clip start or end',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        compositionId: { type: 'string' },
        trackId: { type: 'string' },
        clipId: { type: 'string' },
        newStartUs: { type: 'number' },
        newEndUs: { type: 'number' },
      },
      required: ['compositionId', 'trackId', 'clipId'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: true,
      affectsTimeline: true,
      affectsAudio: false,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'timeline.trimClip',
    definition,
    execute: (context, input) => {
      const preconditions = checkTrimClipPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { success: false, error: 'invalid input' };
      }

      if (context.dispatch) {
        if (typeof input.compositionId !== 'string' || typeof input.trackId !== 'string') {
          return { success: false, error: 'compositionId and trackId are required to dispatch' };
        }
        const commands: SpikeCommand[] = [];
        if (typeof input.newStartUs === 'number') {
          commands.push({
            type: 'timeline.trimClipStart',
            payload: {
              compositionId: input.compositionId,
              trackId: input.trackId,
              clipId: input.clipId,
              newStartUs: input.newStartUs,
            },
          });
        }
        if (typeof input.newEndUs === 'number') {
          commands.push({
            type: 'timeline.trimClipEnd',
            payload: {
              compositionId: input.compositionId,
              trackId: input.trackId,
              clipId: input.clipId,
              newEndUs: input.newEndUs,
            },
          });
        }
        if (commands.length > 0) {
          const failure = dispatchOrUndefined(context, commands, `Trim clip ${input.clipId}`);
          if (failure) return failure;
        }
      }

      return {
        success: true,
        stableIds: [input.clipId],
        diff: {
          created: [],
          modified: [input.clipId],
          deleted: [],
          summary: `Trimmed clip ${input.clipId}`,
        },
      };
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.clipId],
        deleted: [],
        summary: `Would trim clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkTrimClipPreconditions(context, input),
  };
}

function checkTrimClipPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  const hasStart = typeof input.newStartUs === 'number';
  const hasEnd = typeof input.newEndUs === 'number';

  if (!hasStart && !hasEnd) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'must provide newStartUs or newEndUs',
    });
  }

  if (hasStart && (input.newStartUs as number) < 0) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'newStartUs must be non-negative',
    });
  }

  if (hasEnd && (input.newEndUs as number) < 0) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'newEndUs must be non-negative',
    });
  }

  return preconditions;
}

export function createSplitClipTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'splitClip',
    description: 'Split a clip into source-continuous halves',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        compositionId: { type: 'string' },
        trackId: { type: 'string' },
        clipId: { type: 'string' },
        atUs: { type: 'number' },
        newClipId: { type: 'string' },
      },
      required: ['compositionId', 'trackId', 'clipId', 'atUs', 'newClipId'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: true,
      affectsTimeline: true,
      affectsAudio: false,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'timeline.splitClip',
    definition,
    execute: (context, input) => {
      const preconditions = checkSplitClipPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (
        !isRecord(input) ||
        typeof input.clipId !== 'string' ||
        typeof input.newClipId !== 'string'
      ) {
        return { success: false, error: 'invalid input' };
      }

      if (context.dispatch) {
        if (
          typeof input.compositionId !== 'string' ||
          typeof input.trackId !== 'string' ||
          typeof input.atUs !== 'number'
        ) {
          return {
            success: false,
            error: 'compositionId, trackId, and atUs are required to dispatch',
          };
        }
        const failure = dispatchOrUndefined(
          context,
          [
            {
              type: 'timeline.splitClip',
              payload: {
                compositionId: input.compositionId,
                trackId: input.trackId,
                clipId: input.clipId,
                atUs: input.atUs,
                newClipId: input.newClipId,
              },
            },
          ],
          `Split clip ${input.clipId}`,
        );
        if (failure) return failure;
      }

      return {
        success: true,
        stableIds: [input.clipId, input.newClipId],
        diff: {
          created: [input.newClipId],
          modified: [input.clipId],
          deleted: [],
          summary: `Split clip ${input.clipId} into ${input.clipId} and ${input.newClipId}`,
        },
      };
    },
    dryRun: (context, input) => {
      if (
        !isRecord(input) ||
        typeof input.clipId !== 'string' ||
        typeof input.newClipId !== 'string'
      ) {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [input.newClipId],
        modified: [input.clipId],
        deleted: [],
        summary: `Would split clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkSplitClipPreconditions(context, input),
  };
}

function checkSplitClipPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  if (typeof input.newClipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'newClipId is required',
    });
  }

  if (typeof input.atUs !== 'number' || input.atUs < 0) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'atUs must be a non-negative number',
    });
  }

  return preconditions;
}

export function createJoinClipsTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'joinClips',
    description: 'Join adjacent source-continuous clips',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        compositionId: { type: 'string' },
        trackId: { type: 'string' },
        firstClipId: { type: 'string' },
        secondClipId: { type: 'string' },
      },
      required: ['compositionId', 'trackId', 'firstClipId', 'secondClipId'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: true,
      affectsTimeline: true,
      affectsAudio: false,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'timeline.joinClips',
    definition,
    execute: (context, input) => {
      const preconditions = checkJoinClipsPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (
        !isRecord(input) ||
        typeof input.firstClipId !== 'string' ||
        typeof input.secondClipId !== 'string'
      ) {
        return { success: false, error: 'invalid input' };
      }

      if (context.dispatch) {
        if (typeof input.compositionId !== 'string' || typeof input.trackId !== 'string') {
          return { success: false, error: 'compositionId and trackId are required to dispatch' };
        }
        const failure = dispatchOrUndefined(
          context,
          [
            {
              type: 'timeline.joinClips',
              payload: {
                compositionId: input.compositionId,
                trackId: input.trackId,
                firstClipId: input.firstClipId,
                secondClipId: input.secondClipId,
              },
            },
          ],
          `Join clips ${input.firstClipId} and ${input.secondClipId}`,
        );
        if (failure) return failure;
      }

      return {
        success: true,
        stableIds: [input.firstClipId],
        diff: {
          created: [],
          modified: [input.firstClipId],
          deleted: [input.secondClipId],
          summary: `Joined clips ${input.firstClipId} and ${input.secondClipId}`,
        },
      };
    },
    dryRun: (context, input) => {
      if (
        !isRecord(input) ||
        typeof input.firstClipId !== 'string' ||
        typeof input.secondClipId !== 'string'
      ) {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.firstClipId],
        deleted: [input.secondClipId],
        summary: `Would join clips ${input.firstClipId} and ${input.secondClipId}`,
      };
    },
    checkPreconditions: (context, input) => checkJoinClipsPreconditions(context, input),
  };
}

function checkJoinClipsPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.firstClipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'firstClipId is required',
    });
  }

  if (typeof input.secondClipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'secondClipId is required',
    });
  }

  return preconditions;
}

// Audio tools require `context.liveAudio` (editor mixer graph). Without it they
// fail honestly instead of fabricating success diffs.

export function createSetGainTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'setGain',
    description: 'Set audio clip gain',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        gain: { type: 'number' },
      },
      required: ['clipId', 'gain'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: false,
      affectsTimeline: false,
      affectsAudio: true,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'audioClip.setGain',
    definition,
    execute: (context, input) => {
      const preconditions = checkSetGainPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { success: false, error: 'invalid input' };
      }

      if (context.liveAudio === undefined) {
        return {
          success: false,
          error: 'No live audio graph bound — open the Audio panel in the editor',
        };
      }

      try {
        const gain = typeof input.gain === 'number' ? input.gain : Number(input.gain);
        const { state } = applyAudioCommand(context.liveAudio, {
          type: 'audioClip.setGain',
          payload: { clipId: input.clipId, gain },
        });
        return {
          success: true,
          stableIds: [input.clipId],
          diff: {
            created: [],
            modified: [input.clipId],
            deleted: [],
            summary: `Set gain for clip ${input.clipId} → ${gain} (graph clips=${Object.keys(state.clips).length})`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.clipId],
        deleted: [],
        summary: `Would set gain for clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkSetGainPreconditions(context, input),
  };
}

function requireLiveAudio(context: EditorContext): ToolResult | undefined {
  if (context.liveAudio !== undefined) return undefined;
  return {
    success: false,
    error: 'No live audio graph bound — open the Audio panel in the editor',
  };
}

function checkSetGainPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  if (typeof input.gain !== 'number') {
    preconditions.push({
      type: 'entity-exists',
      message: 'gain must be a number',
    });
  }

  return preconditions;
}

export function createSetPanTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'setPan',
    description: 'Set audio clip pan',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        pan: { type: 'number' },
      },
      required: ['clipId', 'pan'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: false,
      affectsTimeline: false,
      affectsAudio: true,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'audioClip.setPan',
    definition,
    execute: (context, input) => {
      const preconditions = checkSetPanPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { success: false, error: 'invalid input' };
      }

      const missing = requireLiveAudio(context);
      if (missing) return missing;
      try {
        const pan = typeof input.pan === 'number' ? input.pan : Number(input.pan);
        applyAudioCommand(context.liveAudio!, {
          type: 'audioClip.setPan',
          payload: { clipId: input.clipId, pan },
        });
        return {
          success: true,
          stableIds: [input.clipId],
          diff: {
            created: [],
            modified: [input.clipId],
            deleted: [],
            summary: `Set pan for clip ${input.clipId} → ${pan}`,
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.clipId],
        deleted: [],
        summary: `Would set pan for clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkSetPanPreconditions(context, input),
  };
}

function checkSetPanPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  if (typeof input.pan !== 'number') {
    preconditions.push({
      type: 'entity-exists',
      message: 'pan must be a number',
    });
  }

  return preconditions;
}

export function createSetMuteTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'setMute',
    description: 'Set audio clip mute state',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        mute: { type: 'boolean' },
      },
      required: ['clipId', 'mute'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: false,
      affectsTimeline: false,
      affectsAudio: true,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'audioClip.setMute',
    definition,
    execute: (context, input) => {
      const preconditions = checkSetMutePreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { success: false, error: 'invalid input' };
      }

      const missing = requireLiveAudio(context);
      if (missing) return missing;
      try {
        const mute = Boolean(input.mute);
        applyAudioCommand(context.liveAudio!, {
          type: 'audioClip.setMute',
          payload: { clipId: input.clipId, mute },
        });
        return {
          success: true,
          stableIds: [input.clipId],
          diff: {
            created: [],
            modified: [input.clipId],
            deleted: [],
            summary: `Set mute for clip ${input.clipId} → ${mute}`,
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.clipId],
        deleted: [],
        summary: `Would set mute for clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkSetMutePreconditions(context, input),
  };
}

function checkSetMutePreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  if (typeof input.mute !== 'boolean') {
    preconditions.push({
      type: 'entity-exists',
      message: 'mute must be a boolean',
    });
  }

  return preconditions;
}

export function createSetFadeTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'setFade',
    description: 'Set audio clip fade in/out',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        fadeInUs: { type: 'number' },
        fadeOutUs: { type: 'number' },
      },
      required: ['clipId'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: false,
      affectsTimeline: false,
      affectsAudio: true,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'audioClip.setFade',
    definition,
    execute: (context, input) => {
      const preconditions = checkSetFadePreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { success: false, error: 'invalid input' };
      }

      const missing = requireLiveAudio(context);
      if (missing) return missing;
      try {
        const payload: {
          readonly clipId: string;
          readonly fadeInUs?: number;
          readonly fadeOutUs?: number;
          readonly fadeInUsWasSet?: boolean;
          readonly fadeOutUsWasSet?: boolean;
        } = { clipId: input.clipId };
        const next = { ...payload };
        if (typeof input.fadeInUs === 'number') {
          Object.assign(next, { fadeInUs: input.fadeInUs, fadeInUsWasSet: true });
        }
        if (typeof input.fadeOutUs === 'number') {
          Object.assign(next, { fadeOutUs: input.fadeOutUs, fadeOutUsWasSet: true });
        }
        applyAudioCommand(context.liveAudio!, {
          type: 'audioClip.setFade',
          payload: next,
        });
        return {
          success: true,
          stableIds: [input.clipId],
          diff: {
            created: [],
            modified: [input.clipId],
            deleted: [],
            summary: `Set fade for clip ${input.clipId}`,
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.clipId !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [],
        modified: [input.clipId],
        deleted: [],
        summary: `Would set fade for clip ${input.clipId}`,
      };
    },
    checkPreconditions: (context, input) => checkSetFadePreconditions(context, input),
  };
}

function checkSetFadePreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.clipId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'clipId is required',
    });
  }

  const hasFadeIn = typeof input.fadeInUs === 'number';
  const hasFadeOut = typeof input.fadeOutUs === 'number';

  if (!hasFadeIn && !hasFadeOut) {
    preconditions.push({
      type: 'entity-exists',
      message: 'must provide fadeInUs or fadeOutUs',
    });
  }

  if (hasFadeIn && (input.fadeInUs as number) < 0) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'fadeInUs must be non-negative',
    });
  }

  if (hasFadeOut && (input.fadeOutUs as number) < 0) {
    preconditions.push({
      type: 'time-range-valid',
      message: 'fadeOutUs must be non-negative',
    });
  }

  return preconditions;
}

export function createAddEffectTool(): EditTool {
  const definition: ToolDefinition = {
    name: 'addEffect',
    description: 'Add audio effect to clip or bus',
    category: 'edit',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        targetId: { type: 'string' },
        effect: { type: 'object' },
      },
      required: ['id', 'targetId', 'effect'],
    },
    outputSchema: { type: 'object' },
    scope: {
      affectsTracks: false,
      affectsTimeline: false,
      affectsAudio: true,
      affectsCaptions: false,
      affectsVoice: false,
      requiresProvider: false,
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: true,
    returnsStableIds: true,
  };

  return {
    name: definition.name,
    description: definition.description,
    commandType: 'audioEffect.add',
    definition,
    execute: (context, input) => {
      const preconditions = checkAddEffectPreconditions(context, input);
      if (preconditions.length > 0) {
        return {
          success: false,
          error: preconditions.map((p) => p.message).join(', '),
        };
      }

      if (
        !isRecord(input) ||
        typeof input.id !== 'string' ||
        typeof input.targetId !== 'string' ||
        !isRecord(input.effect)
      ) {
        return { success: false, error: 'invalid input' };
      }

      const missing = requireLiveAudio(context);
      if (missing) return missing;
      try {
        applyAudioCommand(context.liveAudio!, {
          type: 'audioEffect.add',
          payload: {
            id: input.id,
            targetId: input.targetId,
            effect: input.effect as never,
          },
        });
        return {
          success: true,
          stableIds: [input.id],
          diff: {
            created: [input.id],
            modified: [],
            deleted: [],
            summary: `Added effect ${input.id}`,
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    dryRun: (context, input) => {
      if (!isRecord(input) || typeof input.id !== 'string') {
        return { created: [], modified: [], deleted: [], summary: 'invalid input' };
      }
      return {
        created: [input.id],
        modified: [],
        deleted: [],
        summary: `Would add effect ${input.id}`,
      };
    },
    checkPreconditions: (context, input) => checkAddEffectPreconditions(context, input),
  };
}

function checkAddEffectPreconditions(
  context: EditorContext,
  input: JsonValue,
): readonly Precondition[] {
  const preconditions: Precondition[] = [];

  if (!isRecord(input)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'input must be an object',
    });
    return preconditions;
  }

  if (typeof input.id !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'id is required',
    });
  }

  if (typeof input.targetId !== 'string') {
    preconditions.push({
      type: 'entity-exists',
      message: 'targetId is required',
    });
  }

  if (!isRecord(input.effect)) {
    preconditions.push({
      type: 'entity-exists',
      message: 'effect is required',
    });
  }

  return preconditions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
