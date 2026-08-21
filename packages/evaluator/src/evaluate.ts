/**
 * P00 spike evaluator (master plan §14, §36-P0-1).
 *
 * Resolves a spike project at an exact time into a renderer-independent list of
 * active video frames: source time mapping and nested compositions only. Pure —
 * no Pixi, DOM, FFmpeg, providers, or I/O. Property evaluation, effects, and
 * Render IR proper land with WP-00.3/P01.
 */

import type {
  AssetId,
  ClipId,
  Composition,
  CompositionId,
  SpikeProject,
  TimeUs,
} from '@joy-media/project-schema';
import { frameIndexAtUs, rangeContainsUs } from '@joy-media/project-schema';
import { sourceTimeAtPlayhead } from '@joy-media/timeline-engine';

export interface EvaluatedVideoFrame {
  /** Clip IDs from the root composition down to the leaf video clip — stable identity across nesting. */
  readonly clipPath: readonly ClipId[];
  readonly assetId: AssetId;
  /** Exact source-media time for the requested composition time. */
  readonly sourceTimeUs: TimeUs;
}

export interface EvaluatedFrame {
  readonly compositionId: CompositionId;
  readonly timeUs: TimeUs;
  /** Frame index at the evaluated composition's own frame rate. */
  readonly frameIndex: number;
  /** Active frames in draw order (bottom to top). */
  readonly frames: readonly EvaluatedVideoFrame[];
}

/**
 * Evaluates `compositionId` at `timeUs`. The project must already pass
 * `validateSpikeProject` (cycles rejected there); a runtime guard still stops
 * recursion defensively.
 */
export function evaluateFrame(
  project: SpikeProject,
  compositionId: CompositionId,
  timeUs: TimeUs,
): EvaluatedFrame {
  const composition = requireComposition(project, compositionId);
  const frames = collectFrames(project, composition, timeUs, [], new Set([compositionId]));
  return {
    compositionId,
    timeUs,
    frameIndex: frameIndexAtUs(timeUs, composition.frameRate),
    frames,
  };
}

function requireComposition(project: SpikeProject, compositionId: CompositionId): Composition {
  const composition = project.compositions[compositionId];
  if (composition === undefined) {
    throw new Error(`unknown composition "${compositionId}"`);
  }
  return composition;
}

function collectFrames(
  project: SpikeProject,
  composition: Composition,
  timeUs: TimeUs,
  pathPrefix: readonly ClipId[],
  visiting: ReadonlySet<CompositionId>,
): EvaluatedVideoFrame[] {
  const frames: EvaluatedVideoFrame[] = [];
  const tracks = [...composition.tracks].sort((a, b) => a.order - b.order);

  for (const track of tracks) {
    if (!track.enabled) continue;
    for (const clip of track.clips) {
      if (!rangeContainsUs({ startUs: clip.startUs, durationUs: clip.durationUs }, timeUs)) {
        continue;
      }
      const clipLocalUs = timeUs - clip.startUs;
      if (clip.kind === 'video') {
        const sourceTimeUs = sourceTimeAtPlayhead(clip, timeUs);
        if (sourceTimeUs === undefined) continue;
        frames.push({
          clipPath: [...pathPrefix, clip.id],
          assetId: clip.assetId,
          sourceTimeUs,
        });
      } else {
        if (visiting.has(clip.compositionId)) {
          throw new Error(
            `composition recursion at clip "${clip.id}" -> "${clip.compositionId}"; run validateSpikeProject`,
          );
        }
        const child = requireComposition(project, clip.compositionId);
        const childTimeUs = clip.childOffsetUs + clipLocalUs;
        // A nested clip shows nothing beyond its child's duration (no loop/freeze in the spike).
        if (childTimeUs < child.durationUs) {
          frames.push(
            ...collectFrames(
              project,
              child,
              childTimeUs,
              [...pathPrefix, clip.id],
              new Set([...visiting, clip.compositionId]),
            ),
          );
        }
      }
    }
  }
  return frames;
}
