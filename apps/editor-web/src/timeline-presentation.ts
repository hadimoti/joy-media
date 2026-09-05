import { applyTransaction, type AudioState, type CommandTransaction } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { removeClipPropertyAnimations } from '@joy-media/property-system';
import { buildDerivedClipPresentation } from './speed-ramp.js';
import { updateUniversalTimelineForTransaction } from './universal-placement.js';

export interface TimelinePresentationPreparation {
  readonly project: JoyProjectV1;
  readonly audio: AudioState;
}

function findClip(project: SpikeProject, clipId: string) {
  return Object.values(project.compositions)
    .flatMap((composition) => composition.tracks)
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId);
}

/** Applies the same derived-document/universal-placement preparation as the human timeline bus. */
export function prepareTimelinePresentation(
  project: JoyProjectV1,
  audio: AudioState,
  beforeTimeline: SpikeProject,
  transaction: CommandTransaction,
): TimelinePresentationPreparation {
  let preparedProject = project;
  let preparedAudio = audio;
  let scratchTimeline = beforeTimeline;
  // Apply presentation preparation one command at a time so a transaction
  // containing more than one removal cannot orphan clip-owned state. The
  // timeline command transaction is still committed atomically by the caller.
  for (const command of transaction.commands) {
    const commandTransaction: CommandTransaction = {
      label: transaction.label,
      commands: [command],
    };
    switch (command.type) {
      case 'timeline.splitClip': {
        const source = findClip(scratchTimeline, command.payload.clipId);
        const splitLocalUs =
          source === undefined ? undefined : command.payload.atUs - source.startUs;
        const presentation = buildDerivedClipPresentation(
          preparedProject,
          preparedAudio,
          command.payload.clipId,
          [command.payload.newClipId],
          splitLocalUs === undefined ? {} : { splitLocalUs },
        );
        preparedProject = presentation.project;
        preparedAudio = presentation.audio;
        break;
      }
      case 'timeline.duplicateClip': {
        const presentation = buildDerivedClipPresentation(
          preparedProject,
          preparedAudio,
          command.payload.clipId,
          [command.payload.newClipId],
        );
        preparedProject = presentation.project;
        preparedAudio = presentation.audio;
        break;
      }
      case 'timeline.freezeFrame': {
        const presentation = buildDerivedClipPresentation(
          preparedProject,
          preparedAudio,
          command.payload.clipId,
          [command.payload.freezeClipId, command.payload.rightClipId],
        );
        preparedProject = presentation.project;
        preparedAudio = presentation.audio;
        break;
      }
      case 'timeline.removeClip':
        preparedProject = removeClipPropertyAnimations(preparedProject, command.payload.clipId);
        break;
      default:
        break;
    }
    // Keep source ranges and derived-clip lookup truthful for later commands
    // in the same transaction (for example move → split or split → split).
    scratchTimeline = applyTransaction(scratchTimeline, commandTransaction).project;
    preparedProject = updateUniversalTimelineForTransaction(
      preparedProject,
      commandTransaction,
      scratchTimeline,
    );
  }
  return { project: preparedProject, audio: preparedAudio };
}

export function audioStateFromProject(project: Pick<JoyProjectV1, 'audio'>): AudioState {
  const audio = project.audio;
  if (audio === undefined)
    return {
      clips: {},
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    };
  return {
    clips: audio.clips,
    buses: audio.buses,
    effects: audio.effects.map((effect) => ({
      id: effect.id,
      targetId: effect.targetId,
      effect: effect.effect as unknown as AudioState['effects'][number]['effect'],
    })),
  };
}
