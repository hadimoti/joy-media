import { useSyncExternalStore } from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { VideoFrameNode } from '@joy-media/render-ir';

/**
 * "Hold to compare" (T-K04): while the button is held, the Monitor draws the
 * picture without any colour grade. Nothing is written to the document; the
 * grade comes back the moment the button is let go.
 */
export interface ColorGradeBypassStore {
  readonly get: () => boolean;
  readonly set: (bypassed: boolean) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createColorGradeBypassStore(): ColorGradeBypassStore {
  let current = false;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(bypassed) {
      if (bypassed === current) return;
      current = bypassed;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The editor's one compare switch, shared by the Color panel and the Monitor. */
export const colorGradeBypass: ColorGradeBypassStore = createColorGradeBypassStore();

/** True while the picture is shown without its grade (the Monitor redraws when it changes). */
export function useColorGradeBypass(store: ColorGradeBypassStore = colorGradeBypass): boolean {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The project without its output grade and without any clip grade. */
export function withoutColorGrades(project: JoyProjectV1): JoyProjectV1 {
  if (project.colorGrade === undefined && project.clipColorGrades === undefined) return project;
  const copy: Mutable<JoyProjectV1> = { ...project };
  delete copy.colorGrade;
  delete copy.clipColorGrades;
  return copy;
}

/** The video node without the clip grade baked into it when its frame was decoded. */
export function withoutVideoNodeGrade(node: VideoFrameNode): VideoFrameNode {
  if (node.colorGrade === undefined) return node;
  const copy: Mutable<VideoFrameNode> = { ...node };
  delete copy.colorGrade;
  return copy;
}
