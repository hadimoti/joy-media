import type { JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import type { JoyCodePlanOperationV1 } from '@joy-media/agent-tools';

const CURATED_TRANSITION_IDS = ['dissolve', 'wipe', 'slide'] as const;
const MIN_TRANSITION_US = 100_000;
const MAX_TRANSITION_US = 1_500_000;

export interface JoyCodeTransitionOperationInput {
  readonly project: JoyProjectV1;
  readonly planId: string;
  readonly operationIndex: number;
  readonly operation: Extract<
    JoyCodePlanOperationV1,
    { kind: 'transition.addAtJunction' | 'transition.remove' }
  >;
}

export type JoyCodeTransitionOperationResult =
  | {
      readonly ok: true;
      readonly project: JoyProjectV1;
      readonly affectedIds: readonly string[];
      readonly summary: string;
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export function compileJoyCodeTransitionOperation(
  input: JoyCodeTransitionOperationInput,
): JoyCodeTransitionOperationResult {
  const operation = input.operation;
  const transitions = input.project.transitions ?? [];
  if (operation.kind === 'transition.remove') {
    if (!transitions.some((transition) => transition.id === operation.transitionId))
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TRANSITION_UNKNOWN',
          message: `transition "${operation.transitionId}" does not exist`,
        },
      };
    return {
      ok: true,
      project: {
        ...input.project,
        transitions: transitions.filter((transition) => transition.id !== operation.transitionId),
      },
      affectedIds: [operation.transitionId],
      summary: `Remove transition ${operation.transitionId}`,
    };
  }
  if (!(CURATED_TRANSITION_IDS as readonly string[]).includes(operation.transitionId))
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TRANSITION_NOT_CURATED',
        message: `transition "${operation.transitionId}" is not in the curated catalog`,
      },
    };
  if (
    !Number.isSafeInteger(operation.durationUs) ||
    operation.durationUs < MIN_TRANSITION_US ||
    operation.durationUs > MAX_TRANSITION_US
  )
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TRANSITION_DURATION_INVALID',
        message: 'transition duration is outside safe bounds',
      },
    };
  const junction = findJunction(input.project, operation.outgoingClipId, operation.incomingClipId);
  if (junction === undefined)
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TRANSITION_JUNCTION_INVALID',
        message: 'transition clips must be visual and adjacent on one track',
      },
    };
  if (operation.durationUs > Math.min(junction.left.durationUs, junction.right.durationUs) / 2)
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TRANSITION_DURATION_INVALID',
        message: 'transition duration must be at most half of either clip',
      },
    };
  if (
    transitions.some(
      (transition) =>
        transition.trackId === junction.trackId &&
        transition.leftClipId === operation.outgoingClipId &&
        transition.rightClipId === operation.incomingClipId,
    )
  )
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TRANSITION_DUPLICATE',
        message: 'a transition already exists at this junction',
      },
    };
  const transition: TransitionV1 = {
    id: `transition-${input.planId}-${input.operationIndex}`,
    trackId: junction.trackId,
    leftClipId: operation.outgoingClipId,
    rightClipId: operation.incomingClipId,
    type: operation.transitionId,
    durationUs: operation.durationUs,
  };
  return {
    ok: true,
    project: { ...input.project, transitions: [...transitions, transition] },
    affectedIds: [transition.id, junction.left.id, junction.right.id],
    summary: `Add ${operation.transitionId} transition`,
  };
}

function findJunction(
  project: JoyProjectV1,
  leftId: string,
  rightId: string,
):
  | {
      readonly trackId: string;
      readonly left: { readonly id: string; readonly startUs: number; readonly durationUs: number };
      readonly right: {
        readonly id: string;
        readonly startUs: number;
        readonly durationUs: number;
      };
    }
  | undefined {
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      if (track.kind !== 'video' || track.locked === true) continue;
      const left = track.clips.find((clip) => clip.id === leftId && clip.kind === 'video');
      const right = track.clips.find((clip) => clip.id === rightId && clip.kind === 'video');
      if (
        left !== undefined &&
        right !== undefined &&
        left.startUs + left.durationUs === right.startUs
      )
        return { trackId: track.id, left, right };
    }
  }
  return undefined;
}
