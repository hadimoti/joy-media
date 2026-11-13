import { useSyncExternalStore } from 'react';
import type { ColorGradeV2, JoyProjectV1 } from '@joy-media/project-schema';
import type { VideoFrameNode } from '@joy-media/render-ir';
import { evaluateColorGradeAtTime } from '@joy-media/evaluator';
import { normalizeColorGrade } from '@joy-media/visual-object-renderer';

/**
 * The live values of a colour gesture (T-K02).
 *
 * While a wheel is dragged, the Monitor draws with these values and the
 * document stays as it was; the grade is written once, when the gesture ends,
 * so one Undo puts the whole drag back.
 */
export interface ColorGradePreview {
  /** Which grade the gesture is changing. */
  readonly scope: 'output' | 'clip';
  /** The clip whose grade is changing, for the clip scope. */
  readonly clipId?: string;
  readonly grade: ColorGradeV2;
}

export interface ColorGradePreviewStore {
  readonly get: () => ColorGradePreview | undefined;
  readonly set: (preview: ColorGradePreview | undefined) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createColorGradePreviewStore(): ColorGradePreviewStore {
  let current: ColorGradePreview | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(preview) {
      if (preview === current) return;
      current = preview;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The editor's one live colour store, shared by the panel and the Monitor. */
export const colorGradePreview: ColorGradePreviewStore = createColorGradePreviewStore();

/** The live preview (the Monitor redraws when it changes). */
export function useColorGradePreview(
  store: ColorGradePreviewStore = colorGradePreview,
): ColorGradePreview | undefined {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The project with the live grade in place (the same project when there is none). */
export function withColorGradePreview(
  project: JoyProjectV1,
  preview: ColorGradePreview | undefined,
): JoyProjectV1 {
  if (preview === undefined) return project;
  if (preview.scope === 'clip') {
    if (preview.clipId === undefined) return project;
    return {
      ...project,
      clipColorGrades: {
        ...(project.clipColorGrades ?? {}),
        [preview.clipId]: preview.grade,
      },
    };
  }
  return { ...project, colorGrade: preview.grade };
}

/**
 * The video node with the live clip grade (the node itself when there is none).
 *
 * A clip's grade is baked into its video node when the frame is decoded, so a
 * live clip grade has to be put back onto the node for the preview to show it.
 */
export function withColorGradePreviewNode(
  node: VideoFrameNode,
  preview: ColorGradePreview | undefined,
  project: JoyProjectV1,
  timeUs: number,
  clip?: { readonly startUs: number; readonly durationUs: number },
): VideoFrameNode {
  if (preview === undefined || preview.scope !== 'clip') return node;
  if (preview.clipId === undefined || node.id !== preview.clipId) return node;
  const evaluated = evaluateColorGradeAtTime(
    preview.grade,
    project.propertyAnimations,
    { scope: 'clip', clipId: preview.clipId },
    {
      compositionTimeUs: timeUs,
      outputTimeUs: timeUs,
      ...(clip === undefined ? {} : { clip }),
    },
  );
  return { ...node, colorGrade: normalizeColorGrade(evaluated) };
}
