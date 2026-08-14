import type { AudioState, CommandTransaction } from '@joy-media/commands';
import {
  normalizePlaybackRate,
  type JoyProjectV1,
  type Track,
  type VideoClip,
} from '@joy-media/project-schema';
import {
  duplicateClipPropertyAnimations,
  removeClipPropertyAnimations,
  splitClipPropertyAnimations,
} from '@joy-media/property-system';
import { withProjectAudio } from './audio-session.js';
import type { SpeedRampPreset } from './InspectorPanel.js';
import {
  readClipObjectMap,
  resolveObjectIdForSelection,
  writeClipObjectMap,
} from './sticker-bindings.js';
import {
  readTimelineElementKindMap,
  writeTimelineElementKindMap,
} from './timeline-element-kind.js';

/**
 * Source-continuous multipliers for the three supported ramps. Their inverse
 * averages are exactly one, so splitting a clip into the three rates retains
 * the original timeline duration and cannot collide with its neighbours.
 */
export const SPEED_RAMP_MULTIPLIERS: Readonly<
  Record<SpeedRampPreset, readonly [number, number, number]>
> = {
  'ease-in': [0.75, 1, 1.5],
  'ease-out': [1.5, 1, 0.75],
  'ease-in-out': [0.8, 2, 0.8],
};

const RAMP_LABELS: Readonly<Record<SpeedRampPreset, string>> = {
  'ease-in': 'Ease In',
  'ease-out': 'Ease Out',
  'ease-in-out': 'Ease In/Out',
};

export interface SpeedRampResult {
  readonly transaction: CommandTransaction;
  readonly segmentIds: readonly [string, string, string];
}

/** The matching visual/audio update for a timeline speed-ramp transaction. */
export interface SpeedRampPresentationResult {
  readonly project: JoyProjectV1;
  readonly audio: AudioState;
}

/**
 * Clones a clip's durable visual binding and mixer/effect configuration onto
 * newly-derived timeline clips. `removeOriginal` is for replacements such as
 * a ramp; split/freeze/duplicate retain the source clip and its configuration.
 */
export function buildDerivedClipPresentation(
  project: JoyProjectV1,
  audio: AudioState,
  originalClipId: string,
  derivedClipIds: readonly string[],
  options: { readonly removeOriginal?: boolean; readonly splitLocalUs?: number } = {},
): SpeedRampPresentationResult {
  let propertyProject = project;
  for (const clipId of derivedClipIds) {
    propertyProject =
      options.splitLocalUs === undefined
        ? duplicateClipPropertyAnimations(propertyProject, originalClipId, clipId)
        : splitClipPropertyAnimations(
            propertyProject,
            originalClipId,
            clipId,
            options.splitLocalUs,
          );
  }
  if (options.removeOriginal) {
    propertyProject = removeClipPropertyAnimations(propertyProject, originalClipId);
  }

  const bindings = { ...readClipObjectMap(propertyProject) };
  const elementKinds = { ...readTimelineElementKindMap(propertyProject) };
  const objectId = resolveObjectIdForSelection(propertyProject, [originalClipId]);
  if (objectId !== undefined) {
    for (const clipId of derivedClipIds) bindings[clipId] = objectId;
  }
  const originalElementKind = elementKinds[originalClipId];
  if (originalElementKind !== undefined) {
    for (const clipId of derivedClipIds) elementKinds[clipId] = originalElementKind;
  }
  if (options.removeOriginal) delete elementKinds[originalClipId];

  const sourceConfig = audio.clips[originalClipId];
  const nextClipAudio: Record<string, (typeof audio.clips)[string]> = { ...audio.clips };
  if (options.removeOriginal) delete nextClipAudio[originalClipId];
  if (sourceConfig !== undefined) {
    for (const clipId of derivedClipIds) nextClipAudio[clipId] = { ...sourceConfig };
  }

  const issuedEffectIds = new Set(audio.effects.map((effect) => effect.id));
  const nextEffects = audio.effects.flatMap((effect) => {
    if (effect.targetId !== originalClipId) return [effect];
    const clones = derivedClipIds.map((clipId, index) => {
      const baseId = `${effect.id}--derived-${index + 1}`;
      let id = baseId;
      let suffix = 2;
      while (issuedEffectIds.has(id)) id = `${baseId}-${suffix++}`;
      issuedEffectIds.add(id);
      return { ...effect, id, targetId: clipId };
    });
    return options.removeOriginal ? clones : [effect, ...clones];
  });
  const nextAudio: AudioState = {
    ...audio,
    clips: nextClipAudio,
    effects: nextEffects,
  };
  return {
    project: withProjectAudio(
      writeTimelineElementKindMap(writeClipObjectMap(propertyProject, bindings), elementKinds),
      nextAudio,
    ),
    audio: nextAudio,
  };
}

/**
 * Preserve the selected clip's visual-object binding and audio mix/effects
 * across the three new ramp segments. This deliberately returns one complete
 * visual document so the App can persist it in the same compound history
 * entry as the timeline replacement.
 */
export function buildSpeedRampPresentation(
  project: JoyProjectV1,
  audio: AudioState,
  originalClipId: string,
  segmentIds: readonly [string, string, string],
): SpeedRampPresentationResult {
  return buildDerivedClipPresentation(project, audio, originalClipId, segmentIds, {
    removeOriginal: true,
  });
}

/**
 * Converts one forward, unfrozen video clip into three source-contiguous
 * clips. The command replaces the entire track atomically, and the existing
 * `restoreTrackClips` inverse restores the original clip with one Undo.
 */
export function buildSpeedRampTransaction({
  compositionId,
  track,
  clip,
  preset,
}: {
  readonly compositionId: string;
  readonly track: Track;
  readonly clip: VideoClip;
  readonly preset: SpeedRampPreset;
}): SpeedRampResult {
  if (!track.clips.some((candidate) => candidate.id === clip.id)) {
    throw new Error(`Speed ramp target "${clip.id}" is not on track "${track.id}".`);
  }
  if (clip.reversed === true) throw new Error('Speed ramps are unavailable for reversed clips.');
  const baseRate = normalizePlaybackRate(clip.playbackRate);
  if (baseRate === 0) throw new Error('Speed ramps are unavailable for freeze frames.');
  const multipliers = SPEED_RAMP_MULTIPLIERS[preset];
  if (multipliers.some((multiplier) => baseRate * multiplier > 8 || baseRate * multiplier < 0.1)) {
    throw new Error('This speed ramp would exceed the supported 0.1×–8× playback range.');
  }

  const segmentIds = [
    `${clip.id}-ramp-${preset}-1`,
    `${clip.id}-ramp-${preset}-2`,
    `${clip.id}-ramp-${preset}-3`,
  ] as const;
  const existingIds = new Set(
    track.clips.filter((candidate) => candidate.id !== clip.id).map((item) => item.id),
  );
  if (segmentIds.some((id) => existingIds.has(id))) {
    throw new Error('This clip already has a speed ramp. Undo it before applying another ramp.');
  }

  const sourceSpanUs = clip.durationUs * baseRate;
  const sourceThirdUs = sourceSpanUs / 3;
  const firstDurationUs = Math.max(1, Math.round(sourceThirdUs / (baseRate * multipliers[0])));
  const secondDurationUs = Math.max(1, Math.round(sourceThirdUs / (baseRate * multipliers[1])));
  const thirdDurationUs = clip.durationUs - firstDurationUs - secondDurationUs;
  if (thirdDurationUs < 1) {
    throw new Error('This clip is too short to create a three-part speed ramp.');
  }
  const segmentDurations = [firstDurationUs, secondDurationUs, thirdDurationUs] as const;
  const segments = segmentDurations.map((durationUs, index) => {
    const startUs =
      clip.startUs + segmentDurations.slice(0, index).reduce((sum, duration) => sum + duration, 0);
    const sourceInUs = clip.sourceInUs + Math.round(sourceThirdUs * index);
    return {
      ...clip,
      id: segmentIds[index]!,
      startUs,
      durationUs,
      sourceInUs,
      playbackRate: baseRate * multipliers[index]!,
    } satisfies VideoClip;
  });
  const clips = track.clips.flatMap((candidate) =>
    candidate.id === clip.id ? segments : [candidate],
  );
  return {
    transaction: {
      label: `Apply ${RAMP_LABELS[preset]} speed ramp to ${clip.id}`,
      commands: [
        {
          type: 'timeline.restoreTrackClips',
          payload: { compositionId, trackId: track.id, clips },
        },
      ],
    },
    segmentIds,
  };
}
