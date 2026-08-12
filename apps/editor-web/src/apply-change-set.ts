/**
 * Turning approved specialist proposals into real project changes.
 *
 * ADR-0026 recorded change sets but did not apply them, which left the product
 * claim half-true: the review could tell you what should change and then not
 * change it. This closes that, and the reason it needed a new mechanism is that
 * applying a change set touches two things at once — the creative document and
 * the change-set record — and those have to undo together.
 *
 * What a specialist proposes is deliberately narrow. Each `targetId` names a
 * thing the editor already owns (a caption clip, a timeline clip's audio
 * config, the master grade), and every parameter is validated against the
 * schema before it lands. A proposal naming something unknown is reported as
 * unapplied rather than dropped silently, because a change set that claims to
 * have been applied and was not is worse than one that admits it could not be.
 */

import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { applyTransaction } from '@joy-media/commands';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';
import type { ChangeSetProposal, ProposedEdit } from '@joy-media/agent-tools';

export interface UnappliedEdit {
  readonly targetId: string;
  readonly reason: string;
}

export interface ApplyChangeSetResult {
  readonly document: JoyProjectV1;
  readonly applied: readonly string[];
  /** Edits that named something this editor cannot resolve. */
  readonly unapplied: readonly UnappliedEdit[];
}

export interface TimelineChangeSetResult {
  /** Absent when nothing in the change set reached the timeline. */
  readonly transaction?: CommandTransaction;
  readonly applied: readonly string[];
  readonly unapplied: readonly UnappliedEdit[];
}

export interface ChangeSetPlan {
  readonly document: JoyProjectV1;
  readonly timeline?: CommandTransaction;
  readonly applied: readonly string[];
  readonly unapplied: readonly UnappliedEdit[];
}

function numberParam(edit: ProposedEdit, key: string): number | undefined {
  const value = edit.parameters?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Applies every edit it recognises, returning a new document.
 *
 * Pure: it never mutates the input, so a rejected result can simply be
 * discarded — the same property that makes the command buses safe.
 */
export function applyChangeSet(
  document: JoyProjectV1,
  proposals: readonly ChangeSetProposal[],
  /**
   * Timeline clip ids. Required because audio settings are keyed by clip and
   * those clips live in the timeline, not this document — without them an edit
   * naming a clip that does not exist would silently create an orphan config.
   */
  knownClipIds: ReadonlySet<string>,
): ApplyChangeSetResult {
  let next = document;
  const applied: string[] = [];
  const unapplied: UnappliedEdit[] = [];

  for (const proposal of proposals) {
    for (const edit of proposal.edits) {
      if (edit.domain !== 'parameters') {
        unapplied.push({ targetId: edit.targetId, reason: `${edit.domain} edits are not applied` });
        continue;
      }

      if (edit.targetId === 'colorGrade') {
        const rawBase = next.colorGrade;
        const base =
          rawBase !== undefined && 'version' in rawBase
            ? {
                lift: rawBase.lift ?? 0,
                gamma: rawBase.gamma ?? 1,
                gain: rawBase.gain ?? 1,
                saturation: rawBase.saturation ?? 1,
                lutId: rawBase.lutId,
              }
            : (rawBase ?? { lift: 0, gamma: 1, gain: 1, saturation: 1 });
        next = {
          ...next,
          colorGrade: {
            lift: numberParam(edit, 'lift') ?? base.lift,
            gamma: numberParam(edit, 'gamma') ?? base.gamma,
            gain: numberParam(edit, 'gain') ?? base.gain,
            saturation: numberParam(edit, 'saturation') ?? base.saturation,
            ...(typeof edit.parameters?.['lutId'] === 'string'
              ? { lutId: edit.parameters['lutId'] as 'none' | 'rec709' | 'contrast' }
              : base.lutId === undefined
                ? {}
                : { lutId: base.lutId }),
          },
        };
        applied.push(edit.targetId);
        continue;
      }

      const captionApplied = applyCaptionTiming(next, edit);
      if (captionApplied !== undefined) {
        next = captionApplied;
        applied.push(edit.targetId);
        continue;
      }

      const audioApplied = knownClipIds.has(edit.targetId)
        ? applyAudioConfig(next, edit)
        : undefined;
      if (audioApplied !== undefined) {
        next = audioApplied;
        applied.push(edit.targetId);
        continue;
      }

      unapplied.push({
        targetId: edit.targetId,
        reason: 'no caption clip, audio clip, or grade with that id',
      });
    }
  }

  // The document has to remain valid; a specialist proposing something the
  // schema refuses must not be able to corrupt the project through this path.
  const diagnostics = validateJoyProjectV1(next);
  if (diagnostics.length > 0) {
    return {
      document,
      applied: [],
      unapplied: [
        ...unapplied,
        { targetId: '(document)', reason: `would be invalid: ${diagnostics[0]!.message}` },
      ],
    };
  }

  return { document: next, applied, unapplied };
}

/**
 * Turns `timeline`-domain edits into one command transaction.
 *
 * These do not belong on the document path: where a clip sits is a timeline
 * command with a real inverse, so routing it through the command bus keeps
 * undo, replay, and validation exactly as they are for a hand edit. Building
 * commands here rather than mutating the project is what makes that possible.
 */
export function buildTimelineChangeSet(
  timeline: SpikeProject,
  proposals: readonly ChangeSetProposal[],
): TimelineChangeSetResult {
  const commands: SpikeCommand[] = [];
  const applied: string[] = [];
  const unapplied: UnappliedEdit[] = [];

  for (const proposal of proposals) {
    for (const edit of proposal.edits) {
      if (edit.domain !== 'timeline') continue;

      const location = findClip(timeline, edit.targetId);
      if (location === undefined) {
        unapplied.push({ targetId: edit.targetId, reason: 'no timeline clip with that id' });
        continue;
      }

      const startUs = numberParam(edit, 'startUs');
      const endUs = numberParam(edit, 'endUs');
      if (startUs === undefined && endUs === undefined) {
        unapplied.push({
          targetId: edit.targetId,
          reason: 'timeline edits must propose startUs or endUs',
        });
        continue;
      }

      if (startUs !== undefined) {
        commands.push({
          type: 'timeline.moveClip',
          payload: {
            compositionId: location.compositionId,
            trackId: location.trackId,
            clipId: edit.targetId,
            newStartUs: startUs,
          },
        });
      }
      if (endUs !== undefined) {
        commands.push({
          type: 'timeline.trimClipEnd',
          payload: {
            compositionId: location.compositionId,
            trackId: location.trackId,
            clipId: edit.targetId,
            newEndUs: endUs,
          },
        });
      }
      applied.push(edit.targetId);
    }
  }

  if (commands.length === 0) return { applied, unapplied };

  const transaction: CommandTransaction = {
    label: `Apply ${applied.length} timeline edit(s)`,
    commands,
  };
  try {
    // Dry run against a copy. The command bus refuses overlaps and out-of-range
    // trims, and a change set that would be refused halfway through must not
    // reach the real project as a partial edit.
    applyTransaction(timeline, transaction);
  } catch (error) {
    return {
      applied: [],
      unapplied: [...unapplied, { targetId: '(timeline)', reason: (error as Error).message }],
    };
  }
  return { transaction, applied, unapplied };
}

function findClip(
  timeline: SpikeProject,
  clipId: string,
): { readonly compositionId: string; readonly trackId: string } | undefined {
  for (const [compositionId, composition] of Object.entries(timeline.compositions)) {
    for (const track of composition.tracks) {
      if (track.clips.some((clip) => clip.id === clipId)) {
        return { compositionId, trackId: track.id };
      }
    }
  }
  return undefined;
}

/**
 * Splits an approved change set across the two buses it can reach.
 *
 * Each half is built independently and validated on its own terms — the
 * document against the v1 validator, the timeline against the command bus —
 * and the caller commits both in one compound transaction so the whole
 * approval is one undo.
 */
export function planChangeSet(
  document: JoyProjectV1,
  timeline: SpikeProject,
  proposals: readonly ChangeSetProposal[],
): ChangeSetPlan {
  // Each half only sees the edits it can act on, so neither reports the other's
  // work as something it failed to apply.
  const parameterProposals = proposals
    .map((proposal) => ({
      ...proposal,
      edits: proposal.edits.filter((edit) => edit.domain === 'parameters'),
    }))
    .filter((proposal) => proposal.edits.length > 0);

  const knownClipIds = new Set(
    Object.values(timeline.compositions).flatMap((composition) =>
      composition.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
    ),
  );

  const documentResult = applyChangeSet(document, parameterProposals, knownClipIds);
  const timelineResult = buildTimelineChangeSet(timeline, proposals);

  return {
    document: documentResult.document,
    ...(timelineResult.transaction === undefined ? {} : { timeline: timelineResult.transaction }),
    applied: [...documentResult.applied, ...timelineResult.applied],
    unapplied: [...documentResult.unapplied, ...timelineResult.unapplied],
  };
}

function applyCaptionTiming(document: JoyProjectV1, edit: ProposedEdit): JoyProjectV1 | undefined {
  const durationUs = numberParam(edit, 'durationUs');
  const startUs = numberParam(edit, 'startUs');
  if (durationUs === undefined && startUs === undefined) return undefined;

  let found = false;
  const compositions = Object.fromEntries(
    Object.entries(document.compositions).map(([id, composition]) => [
      id,
      {
        ...composition,
        tracks: composition.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => {
            if (clip.id !== edit.targetId || clip.kind !== 'caption') return clip;
            found = true;
            return {
              ...clip,
              ...(startUs === undefined ? {} : { startUs }),
              ...(durationUs === undefined ? {} : { durationUs }),
            };
          }),
        })),
      },
    ]),
  );
  return found ? { ...document, compositions } : undefined;
}

function applyAudioConfig(document: JoyProjectV1, edit: ProposedEdit): JoyProjectV1 | undefined {
  const gain = numberParam(edit, 'gain');
  const pan = numberParam(edit, 'pan');
  if (gain === undefined && pan === undefined) return undefined;

  const audio = document.audio ?? { clips: {}, buses: [], effects: [] };
  const existing = audio.clips[edit.targetId] ?? {
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
  };
  return {
    ...document,
    audio: {
      ...audio,
      clips: {
        ...audio.clips,
        [edit.targetId]: {
          ...existing,
          ...(gain === undefined ? {} : { gain }),
          ...(pan === undefined ? {} : { pan }),
        },
      },
    },
  };
}
