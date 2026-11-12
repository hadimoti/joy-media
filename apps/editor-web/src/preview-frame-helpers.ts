import type { ImageDataLike } from '@joy-media/playback-engine';
import type { ColorGradeIR } from '@joy-media/render-ir';
import type {
  JoyProjectV1,
  SpikeProject,
  TransitionV1,
  VideoClip,
} from '@joy-media/project-schema';
import { evaluateColorGradeAtTime } from '@joy-media/evaluator';
import {
  clipTimesFromTracks,
  isTransitionActive,
  normalizeColorGrade,
  type BuildRenderFrameOptions,
  type ClipTimingLookup,
} from '@joy-media/visual-object-renderer';
import { applyColorGradeToPixels, type ParsedCubeLut } from '@joy-media/renderer-pixi';
import { rootTimelineVideoClipById } from './timeline-nested-playback.js';
import { effectsByObjectIdAt } from './adjustment-render.js';
import { stickerImageCache } from './editor-runtime-singletons.js';

/**
 * Frame-building helpers shared by the monitor preview and the export path.
 * Moved out of App.tsx unchanged (T-M02a).
 */

/** IR options for preview/export: effects, grade, and clip-timed transitions. */
export function renderFrameOptions(
  project: JoyProjectV1,
  timeline: SpikeProject,
  timeUs: number,
  imageSizesByObjectId?: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >,
): BuildRenderFrameOptions {
  const outputGrade =
    project.colorGrade !== undefined &&
    'version' in project.colorGrade &&
    project.colorGrade.version === 2
      ? evaluateColorGradeAtTime(
          project.colorGrade,
          project.propertyAnimations,
          { scope: 'output' },
          { compositionTimeUs: timeUs, outputTimeUs: timeUs },
        )
      : project.colorGrade;
  return {
    effectsByObjectId: effectsByObjectIdAt(project, timeline, timeUs),
    propertyAnimations: project.propertyAnimations,
    ...(outputGrade !== undefined ? { colorGrade: outputGrade } : {}),
    ...(project.transitions !== undefined ? { transitions: project.transitions } : {}),
    clipTimes: transitionClipTimes(timeline),
    ...(imageSizesByObjectId !== undefined ? { imageSizesByObjectId } : {}),
  };
}

export function imageSizesFromCache(
  timeUs = 0,
): Readonly<Record<string, { readonly width: number; readonly height: number }>> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [id, bitmap] of stickerImageCache.bitmaps(timeUs)) {
    sizes[id] = { width: bitmap.width, height: bitmap.height };
  }
  return sizes;
}

export function rgbaBase64(data: Uint8ClampedArray): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize)
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

export function colorGradeForClipAtTime(
  project: JoyProjectV1,
  clip: VideoClip,
  timeUs: number,
): ColorGradeIR | undefined {
  const grade = project.clipColorGrades?.[clip.id];
  if (grade === undefined) return undefined;
  const evaluated = evaluateColorGradeAtTime(
    grade,
    project.propertyAnimations,
    { scope: 'clip', clipId: clip.id },
    {
      compositionTimeUs: timeUs,
      outputTimeUs: timeUs,
      clip: { startUs: clip.startUs, durationUs: clip.durationUs },
    },
  );
  return normalizeColorGrade(evaluated);
}

/**
 * Clip start times for transition windows. The video clips live in the timeline project; the visual
 * project's root composition holds no video tracks, so reading it found no clip and no transition.
 */
export function transitionClipTimes(timeline: SpikeProject): ClipTimingLookup {
  const composition = timeline.compositions[timeline.rootCompositionId];
  return composition === undefined ? new Map() : clipTimesFromTracks(composition.tracks);
}

/** Active transition (if any) at composition time. */
export function activeTransitionAt(
  project: JoyProjectV1,
  playheadUs: number,
  clipTimes: ClipTimingLookup,
): TransitionV1 | undefined {
  if (project.transitions === undefined) return undefined;
  return project.transitions.find((transition) =>
    isTransitionActive(transition, playheadUs, clipTimes),
  );
}

/**
 * Transition inputs are uploaded as independent textures, so they do not
 * pass through the ordinary video-frame layer filters. Apply each source
 * clip's grade to a private bitmap copy before the transition blends it.
 */
export function applyClipGradesToTransitionBitmaps(
  project: JoyProjectV1,
  transition: TransitionV1 | undefined,
  timeUs: number,
  bitmaps: Map<string, ImageDataLike>,
  resolveColorLut?: (grade: ColorGradeIR) => ParsedCubeLut | undefined,
): void {
  if (transition === undefined) return;
  for (const clipId of [transition.leftClipId, transition.rightClipId]) {
    const clip = findVideoClipById(project, clipId);
    const bitmap = bitmaps.get(clipId);
    if (clip === undefined || bitmap === undefined) continue;
    const grade = colorGradeForClipAtTime(project, clip, timeUs);
    if (grade === undefined) continue;
    const data = new Uint8ClampedArray(bitmap.data);
    const normalizedGrade = normalizeColorGrade(grade);
    applyColorGradeToPixels(data, normalizedGrade, resolveColorLut?.(normalizedGrade));
    bitmaps.set(clipId, { ...bitmap, data });
  }
}

export function findVideoClipById(
  project: SpikeProject | JoyProjectV1,
  clipId: string,
): VideoClip | undefined {
  return rootTimelineVideoClipById(project as SpikeProject, clipId);
}
