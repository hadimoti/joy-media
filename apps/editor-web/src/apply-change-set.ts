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

import type { JoyProjectV1 } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import type { ChangeSetProposal, ProposedEdit } from '@joy-media/agent-tools';

export interface ApplyChangeSetResult {
  readonly document: JoyProjectV1;
  readonly applied: readonly string[];
  /** Edits that named something this editor cannot resolve. */
  readonly unapplied: readonly { readonly targetId: string; readonly reason: string }[];
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
  const unapplied: { targetId: string; reason: string }[] = [];

  for (const proposal of proposals) {
    for (const edit of proposal.edits) {
      if (edit.domain !== 'parameters') {
        unapplied.push({ targetId: edit.targetId, reason: `${edit.domain} edits are not applied` });
        continue;
      }

      if (edit.targetId === 'colorGrade') {
        const base = next.colorGrade ?? { lift: 0, gamma: 1, gain: 1, saturation: 1 };
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

function applyCaptionTiming(
  document: JoyProjectV1,
  edit: ProposedEdit,
): JoyProjectV1 | undefined {
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
