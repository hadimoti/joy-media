import { useSyncExternalStore } from 'react';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { VideoFrameNode } from '@joy-media/render-ir';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { transformToRenderTransform } from '@joy-media/visual-object-renderer';
import { clipIdToObjectId } from './monitor-ids.js';
import type { LocalTransform } from './monitor-transform-maths.js';
import type { TransformPatches } from './monitor-transform-drag.js';

/**
 * The live values of a Monitor drag (T-M05a). While a drag runs, the Monitor
 * draws with them and the Inspector shows them; nothing is written to the
 * document until release, and the export never reads them.
 */
export interface MonitorTransformPreviewStore {
  readonly get: () => TransformPatches | undefined;
  readonly set: (patches: TransformPatches | undefined) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createMonitorTransformPreviewStore(): MonitorTransformPreviewStore {
  let current: TransformPatches | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(patches) {
      const next = patches === undefined || patches.size === 0 ? undefined : patches;
      if (next === current) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The editor's one live-drag store, shared by the Monitor and the Inspector. */
export const monitorTransformPreview: MonitorTransformPreviewStore =
  createMonitorTransformPreviewStore();

/** All live values (the Monitor redraws when they change). */
export function useMonitorTransformPreview(
  store: MonitorTransformPreviewStore = monitorTransformPreview,
): TransformPatches | undefined {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The live values of one object while a Monitor drag moves it (for the Inspector). */
export function useMonitorTransformPreviewFor(
  objectId: string | undefined,
  store: MonitorTransformPreviewStore = monitorTransformPreview,
): LocalTransform | undefined {
  const patches = useMonitorTransformPreview(store);
  return objectId === undefined ? undefined : patches?.get(objectId);
}

/** The project with the given transform values in place (the same project when there are none). */
export function withTransformPatches(
  project: JoyProjectV1,
  patches: TransformPatches | undefined,
): JoyProjectV1 {
  if (patches === undefined || patches.size === 0) return project;
  let visualObjects: Record<string, VisualObjectV1> | undefined;
  for (const [objectId, values] of patches) {
    const object = project.visualObjects[objectId];
    if (object === undefined) continue;
    visualObjects ??= { ...project.visualObjects };
    visualObjects[objectId] = { ...object, transform: { ...object.transform, ...values } };
  }
  return visualObjects === undefined ? project : { ...project, visualObjects };
}

/**
 * The video picture's node with the live values (a video is keyed by its clip
 * id and drawn from its bound object), through the same conversion as the
 * frame builder. The node itself when its object is not being dragged.
 */
export function withPreviewVideoNode(
  node: VideoFrameNode,
  previewProject: JoyProjectV1,
  patches: TransformPatches | undefined,
  timeUs: number,
): VideoFrameNode {
  if (patches === undefined) return node;
  const objectId = clipIdToObjectId(previewProject, node.id);
  if (objectId === undefined || !patches.has(objectId)) return node;
  const composition = previewProject.compositions[previewProject.rootCompositionId];
  const world = evaluateCameraExpressionTransform(
    objectId,
    composition?.activeCameraId,
    previewProject.visualObjects as Readonly<Record<string, VisualObjectV1>>,
    timeUs,
    composition?.height ?? 1920,
  ).transform;
  return { ...node, transform: transformToRenderTransform(world) };
}
