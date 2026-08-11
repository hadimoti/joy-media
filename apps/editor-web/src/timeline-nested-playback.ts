import {
  sourceTimeAtVideoClipTime,
  type Composition,
  type SpikeProject,
  type TimeUs,
  type VideoClip,
} from '@joy-media/project-schema';
import { timelineEffectiveDurationUs } from './timeline-layout.js';

/**
 * A video leaf projected into the root timeline coordinate space. Compound
 * clips are ordinary nested compositions in the project model; the browser
 * media layer needs this flattened view so they remain playable and exportable.
 */
export interface RootTimelineVideoClip extends VideoClip {
  readonly compositionPath: readonly string[];
}

function flattenComposition(
  project: SpikeProject,
  composition: Composition,
  baseUs: number,
  visibleStartUs: number,
  visibleEndUs: number,
  path: readonly string[],
  visiting: ReadonlySet<string>,
  output: RootTimelineVideoClip[],
): void {
  for (const track of composition.tracks) {
    if (!track.enabled) continue;
    for (const clip of track.clips) {
      const absoluteStartUs = baseUs + clip.startUs;
      const absoluteEndUs = absoluteStartUs + clip.durationUs;
      const startUs = Math.max(absoluteStartUs, visibleStartUs);
      const endUs = Math.min(absoluteEndUs, visibleEndUs);
      if (endUs <= startUs) continue;
      if (clip.kind === 'video') {
        const localCompositionTimeUs = clip.startUs + (startUs - absoluteStartUs);
        output.push({
          ...clip,
          startUs,
          durationUs: endUs - startUs,
          sourceInUs: sourceTimeAtVideoClipTime(clip, localCompositionTimeUs),
          compositionPath: [...path, clip.id],
        });
        continue;
      }
      if (visiting.has(clip.compositionId)) continue;
      const child = project.compositions[clip.compositionId];
      if (child === undefined) continue;
      // Parent time t maps to child time `childOffsetUs + (t - startUs)`.
      // Therefore child local time 0 maps to the root coordinate below.
      const childBaseUs = absoluteStartUs - clip.childOffsetUs;
      flattenComposition(
        project,
        child,
        childBaseUs,
        startUs,
        Math.min(endUs, childBaseUs + timelineEffectiveDurationUs(child)),
        [...path, clip.id],
        new Set([...visiting, clip.compositionId]),
        output,
      );
    }
  }
}

/** Returns all enabled video leaves in root-time order, including compounds. */
export function flattenRootTimelineVideoClips(
  project: SpikeProject,
): readonly RootTimelineVideoClip[] {
  const root = project.compositions[project.rootCompositionId];
  if (root === undefined) return [];
  const output: RootTimelineVideoClip[] = [];
  flattenComposition(
    project,
    root,
    0,
    0,
    timelineEffectiveDurationUs(root),
    [],
    new Set([root.id]),
    output,
  );
  return output.sort(
    (a, b) =>
      a.startUs - b.startUs ||
      a.compositionPath.join('/').localeCompare(b.compositionPath.join('/')),
  );
}

/**
 * Projects nested video leaves onto a tiny root-only timeline for existing
 * playback helper functions. It never mutates the authoring project.
 */
export function withFlattenedRootTimeline(project: SpikeProject): SpikeProject {
  const root = project.compositions[project.rootCompositionId];
  if (root === undefined) return project;
  return {
    ...project,
    compositions: {
      ...project.compositions,
      [root.id]: {
        ...root,
        tracks: [
          {
            id: '__root-playback-leaves__',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: flattenRootTimelineVideoClips(project),
          },
        ],
      },
    },
  };
}

/** Finds the leaf clip as it is seen by the root Program Monitor. */
export function rootTimelineVideoClipById(
  project: SpikeProject,
  clipId: string,
): RootTimelineVideoClip | undefined {
  return flattenRootTimelineVideoClips(project).find((clip) => clip.id === clipId);
}

/** Resolve a leaf at an explicit root playhead without depending on UI state. */
export function rootTimelineVideoClipAt(
  project: SpikeProject,
  playheadUs: TimeUs,
): RootTimelineVideoClip | undefined {
  return flattenRootTimelineVideoClips(project).find(
    (clip) => playheadUs >= clip.startUs && playheadUs < clip.startUs + clip.durationUs,
  );
}
