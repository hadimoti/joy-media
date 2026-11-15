/**
 * Commits one QC repair plan as ONE editor transaction (card T-B06, ADR-0045
 * section 7): the timeline commands, the title moves and the master-bus gain go
 * through a single `dispatchCompound`, so one Undo restores the prior state.
 *
 * Nothing is written before every part has been checked: the timeline commands
 * are applied to a scratch copy first, and the document is built and validated
 * by the session before it persists anything.
 */

import { applyAudioCommand, applyTransaction, CommandError } from '@joy-media/commands';
import type { AudioState, CommandTransaction } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import {
  applyVisualObjectProjectTransaction,
  removeClipPropertyAnimations,
} from '@joy-media/property-system';
import { withProjectAudio } from '../audio-session.js';
import { updateUniversalTimelineForTransaction } from '../universal-placement.js';
import type { QcRepairPlan } from './qc-repair-plan.js';

/** The slice of `EditorSession` a repair commit needs. */
export interface QcRepairCommitTarget {
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly projectRevisionId: string;
  dispatchCompound(
    label: string,
    parts: { readonly timeline?: CommandTransaction; readonly document?: JoyProjectV1 },
  ): void;
}

export const QC_REPAIR_TRANSACTION_LABEL = 'Fix quality check findings';

export interface CompiledQcRepair {
  readonly label: string;
  readonly timeline?: CommandTransaction;
  readonly document?: JoyProjectV1;
  /** The mixer graph after the plan (equal to the input when no gain changes). */
  readonly audio: AudioState;
}

export type QcRepairApplyResult =
  | { readonly ok: true; readonly audio: AudioState; readonly commandCount: number }
  | {
      readonly ok: false;
      readonly code: 'stale-revision' | 'empty-plan' | 'invalid-plan';
      readonly message: string;
    };

/** Builds the one compound the session will commit. Pure; throws on an invalid plan. */
export function compileQcRepair(
  plan: QcRepairPlan,
  target: Pick<QcRepairCommitTarget, 'timelineProject' | 'visualProject'>,
  audio: AudioState,
  label = QC_REPAIR_TRANSACTION_LABEL,
): CompiledQcRepair {
  let document = target.visualProject;
  let timeline: CommandTransaction | undefined;
  if (plan.timelineCommands.length > 0) {
    timeline = { label, commands: [...plan.timelineCommands] };
    applyTransaction(target.timelineProject, timeline);
    // The normal editor path drops the animations a removed clip owned; a repair that removes a clip must too.
    for (const command of plan.timelineCommands) {
      if (command.type === 'timeline.removeClip') {
        document = removeClipPropertyAnimations(document, command.payload.clipId);
      }
    }
    document = updateUniversalTimelineForTransaction(document, timeline, target.timelineProject);
  }
  if (plan.visualCommands.length > 0)
    document = applyVisualObjectProjectTransaction(document, {
      label,
      commands: [...plan.visualCommands],
    });
  let nextAudio = audio;
  for (const command of plan.audioCommands) nextAudio = applyAudioCommand(nextAudio, command).state;
  if (plan.audioCommands.length > 0) document = withProjectAudio(document, nextAudio);
  return {
    label,
    ...(timeline === undefined ? {} : { timeline }),
    ...(document === target.visualProject ? {} : { document }),
    audio: nextAudio,
  };
}

/**
 * Commits an approved plan. `baseRevision` is the revision the plan was built
 * against; a project that moved on since is refused rather than overwritten.
 */
export function applyQcRepairPlan(
  target: QcRepairCommitTarget,
  plan: QcRepairPlan,
  audio: AudioState,
  baseRevision: string,
): QcRepairApplyResult {
  if (plan.edits.length === 0)
    return { ok: false, code: 'empty-plan', message: 'The plan has nothing to apply.' };
  if (target.projectRevisionId !== baseRevision)
    return {
      ok: false,
      code: 'stale-revision',
      message: 'The project changed after the plan was made; check it again.',
    };
  let compiled: CompiledQcRepair;
  try {
    compiled = compileQcRepair(plan, target, audio);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid-plan',
      message:
        error instanceof CommandError
          ? 'The plan no longer fits the timeline.'
          : 'The plan could not be prepared.',
    };
  }
  target.dispatchCompound(compiled.label, {
    ...(compiled.timeline === undefined ? {} : { timeline: compiled.timeline }),
    ...(compiled.document === undefined ? {} : { document: compiled.document }),
  });
  return {
    ok: true,
    audio: compiled.audio,
    commandCount:
      plan.timelineCommands.length + plan.visualCommands.length + plan.audioCommands.length,
  };
}
