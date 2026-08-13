/**
 * P00 spike subset of the project model (master plan §10.2–§10.5, §36-P0-1).
 *
 * Deliberately minimal: video clips with source ranges and nested composition
 * clips — just enough for exact frame evaluation tests. Schema v1 with the full
 * clip taxonomy, migrations, and generated validators lands in P01 (WP-01.1).
 * `schemaVersion: 0` marks documents produced by this spike.
 */

import type { Rational, TimeUs } from './time.js';
import { clipTimeRange, rational } from './time.js';

export type ProjectId = string;
export type CompositionId = string;
export type TrackId = string;
export type ClipId = string;
export type AssetId = string;

export interface SpikeProject {
  readonly schemaVersion: 0;
  readonly id: ProjectId;
  readonly rootCompositionId: CompositionId;
  readonly compositions: Readonly<Record<CompositionId, Composition>>;
}

export interface Composition {
  readonly id: CompositionId;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly durationUs: number;
  readonly tracks: readonly Track[];
}

export interface Track {
  readonly id: TrackId;
  readonly kind: 'video';
  /** Draw order: ascending = bottom to top. */
  readonly order: number;
  readonly enabled: boolean;
  readonly clips: readonly Clip[];
}

interface ClipBase {
  readonly id: ClipId;
  readonly startUs: TimeUs;
  readonly durationUs: number;
}

/**
 * Legal video playback rates: `0` = freeze/hold (source frame locked at
 * `sourceInUs`); otherwise `0.1…8`. Missing/`undefined` means `1`.
 *
 * Timeline duration stays `durationUs`. Source advance over the clip is
 * `durationUs * playbackRate` (freeze advances 0). Direction is deliberately
 * represented separately by {@link VideoClip.reversed}: a positive rate keeps
 * the audio/video scheduler APIs simple while the source-time mapper applies
 * the sign in one typed place.
 */
export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 8;

export function normalizePlaybackRate(rate: number | undefined): number {
  return rate === undefined ? 1 : rate;
}

export function isValidPlaybackRate(rate: number): boolean {
  if (!Number.isFinite(rate)) return false;
  if (rate === 0) return true;
  return rate >= MIN_PLAYBACK_RATE && rate <= MAX_PLAYBACK_RATE;
}

export type TimeRemapKeyframe = {
  readonly timeUs: TimeUs;
  readonly sourceTimeUs: TimeUs;
  readonly interpolation: 'hold' | 'linear';
}

/** Explicit monotonic output-local to absolute source-time mapping. */
export type TimeRemapV2 = {
  readonly version: 2;
  readonly direction: 'forward' | 'reverse';
  readonly keyframes: readonly TimeRemapKeyframe[];
}

export function validateTimeRemap(remap: TimeRemapV2, clipDurationUs: TimeUs): readonly string[] {
  const errors: string[] = [];
  if (remap.version !== 2) errors.push('version must be 2');
  if (remap.keyframes.length === 0) errors.push('keyframes must not be empty');
  let previousTime = -1;
  let previousSource: number | undefined;
  remap.keyframes.forEach((keyframe, index) => {
    if (!Number.isSafeInteger(keyframe.timeUs) || keyframe.timeUs < 0)
      errors.push(`keyframe ${index} timeUs must be a non-negative safe integer`);
    if (keyframe.timeUs > clipDurationUs)
      errors.push(`keyframe ${index} timeUs exceeds clip duration`);
    if (keyframe.timeUs <= previousTime) errors.push('keyframe times must be strictly increasing');
    previousTime = keyframe.timeUs;
    if (!Number.isSafeInteger(keyframe.sourceTimeUs) || keyframe.sourceTimeUs < 0)
      errors.push(`keyframe ${index} sourceTimeUs must be a non-negative safe integer`);
    if (previousSource !== undefined) {
      const monotonic =
        remap.direction === 'forward'
          ? keyframe.sourceTimeUs >= previousSource
          : keyframe.sourceTimeUs <= previousSource;
      if (!monotonic) errors.push(`source times must be monotonic for ${remap.direction} remap`);
    }
    previousSource = keyframe.sourceTimeUs;
  });
  if (remap.keyframes[0]?.timeUs !== 0)
    errors.push('first keyframe must start at clip-local time 0');
  return errors;
}

function sampleTimeRemap(remap: TimeRemapV2, clipLocalUs: TimeUs): TimeUs {
  const first = remap.keyframes[0];
  if (first === undefined) return 0;
  if (clipLocalUs <= first.timeUs) return first.sourceTimeUs;
  for (let index = 1; index < remap.keyframes.length; index += 1) {
    const right = remap.keyframes[index]!;
    const left = remap.keyframes[index - 1]!;
    if (clipLocalUs > right.timeUs) continue;
    if (left.interpolation === 'hold') return left.sourceTimeUs;
    const progress = (clipLocalUs - left.timeUs) / (right.timeUs - left.timeUs);
    return Math.round(left.sourceTimeUs + (right.sourceTimeUs - left.sourceTimeUs) * progress);
  }
  return remap.keyframes[remap.keyframes.length - 1]!.sourceTimeUs;
}

export interface VideoClip extends ClipBase {
  readonly kind: 'video';
  readonly assetId: AssetId;
  /**
   * Source time at the visual clip's timeline start. Composition time `t`
   * maps to `sourceInUs ± (t - startUs) * playbackRate`; the minus direction
   * is used when {@link reversed} is true (rate 0 remains a locked frame).
   *
   * Keeping this as the source time at the *timeline* start makes trim, split,
   * and reverse commands deterministic: toggling reverse adjusts `sourceInUs`
   * so the same source window remains visible in the opposite order.
   */
  readonly sourceInUs: TimeUs;
  /** See {@link normalizePlaybackRate}. Omit for 1×. */
  readonly playbackRate?: number;
  /** When true, source time runs backwards while `playbackRate` stays positive. */
  readonly reversed?: boolean;
  /** Optional explicit monotonic output-local to source-time mapping. */
  readonly timeRemap?: TimeRemapV2;
}

/**
 * Resolve a video clip's source position at a composition time. This is the
 * canonical mapping for preview, render, and command code. Callers normally
 * pass a time inside the clip; values outside are still useful for deterministic
 * boundary calculations.
 */
export function sourceTimeAtVideoClipTime(clip: VideoClip, compositionTimeUs: TimeUs): TimeUs {
  if (clip.timeRemap !== undefined)
    return sampleTimeRemap(clip.timeRemap, compositionTimeUs - clip.startUs);
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) return clip.sourceInUs;
  const deltaUs = Math.round((compositionTimeUs - clip.startUs) * rate);
  return clip.reversed === true ? clip.sourceInUs - deltaUs : clip.sourceInUs + deltaUs;
}

export interface CompositionClip extends ClipBase {
  readonly kind: 'composition';
  readonly compositionId: CompositionId;
  /** Child-composition time at the clip's start (0 = child plays from its beginning). */
  readonly childOffsetUs: TimeUs;
}

export type Clip = VideoClip | CompositionClip;

export interface ProjectDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/**
 * Structural validation for the spike model. Returns diagnostics instead of
 * throwing so callers can report all problems at once (§28.3 spirit).
 */
export function validateSpikeProject(project: SpikeProject): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];

  const root = project.compositions[project.rootCompositionId];
  if (root === undefined) {
    diagnostics.push({
      code: 'PROJECT_SCHEMA_MISSING_ROOT',
      message: `rootCompositionId "${project.rootCompositionId}" is not in compositions`,
      path: 'rootCompositionId',
    });
  }

  for (const [compId, comp] of Object.entries(project.compositions)) {
    try {
      rational(comp.frameRate.num, comp.frameRate.den);
    } catch (error) {
      diagnostics.push({
        code: 'PROJECT_SCHEMA_BAD_FRAME_RATE',
        message: (error as Error).message,
        path: `compositions.${compId}.frameRate`,
      });
    }
    for (const track of comp.tracks) {
      for (const clip of track.clips) {
        const path = `compositions.${compId}.tracks.${track.id}.clips.${clip.id}`;
        try {
          clipTimeRange(clip.startUs, clip.durationUs);
        } catch (error) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_BAD_CLIP_RANGE',
            message: (error as Error).message,
            path,
          });
        }
        if (clip.kind === 'composition' && project.compositions[clip.compositionId] === undefined) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_MISSING_COMPOSITION',
            message: `clip references unknown composition "${clip.compositionId}"`,
            path,
          });
        }
        if (
          clip.kind === 'video' &&
          clip.playbackRate !== undefined &&
          !isValidPlaybackRate(clip.playbackRate)
        ) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_BAD_PLAYBACK_RATE',
            message: `playbackRate ${clip.playbackRate} must be 0 (freeze) or in [${MIN_PLAYBACK_RATE}, ${MAX_PLAYBACK_RATE}]`,
            path,
          });
        }
        if (clip.kind === 'video' && clip.timeRemap !== undefined) {
          for (const message of validateTimeRemap(clip.timeRemap, clip.durationUs)) {
            diagnostics.push({
              code: 'PROJECT_SCHEMA_BAD_TIME_REMAP',
              message,
              path: `${path}.timeRemap`,
            });
          }
        }
      }
    }
  }

  diagnostics.push(...detectCompositionCycles(project));
  return diagnostics;
}

/** Nested compositions must not recurse (§19.6). */
function detectCompositionCycles(project: SpikeProject): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  const visiting = new Set<CompositionId>();
  const done = new Set<CompositionId>();

  const visit = (compId: CompositionId, path: readonly CompositionId[]): void => {
    if (done.has(compId)) return;
    if (visiting.has(compId)) {
      diagnostics.push({
        code: 'PROJECT_SCHEMA_COMPOSITION_CYCLE',
        message: `composition cycle: ${[...path, compId].join(' -> ')}`,
        path: `compositions.${compId}`,
      });
      return;
    }
    const comp = project.compositions[compId];
    if (comp === undefined) return;
    visiting.add(compId);
    for (const track of comp.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'composition') {
          visit(clip.compositionId, [...path, compId]);
        }
      }
    }
    visiting.delete(compId);
    done.add(compId);
  };

  for (const compId of Object.keys(project.compositions)) {
    visit(compId, []);
  }
  return diagnostics;
}
