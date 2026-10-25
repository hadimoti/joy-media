import { normalizeUniversalTimeline } from '@joy-media/project-schema';
import type { JsonValue } from '@joy-media/project-schema';
import type { RenderFrameIR, RenderNode } from '@joy-media/render-ir';
import type { HtmlSceneProjectContext } from './html-scene-surfaces.js';

const VISUAL_ELEMENT_KINDS = new Set([
  'video',
  'image',
  'text',
  'shape',
  'overlay',
  'sticker',
  'html-scene',
  'scene3d',
  'composition',
]);

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : {};
}

function objectIdForItem(
  item: ReturnType<typeof normalizeUniversalTimeline>['items'][number],
  clipObjects: Readonly<Record<string, JsonValue>>,
): string | undefined {
  if (item.source.kind === 'object') return item.source.id;
  const linked = clipObjects[item.id];
  return typeof linked === 'string' ? linked : undefined;
}

/** Resolve P0 desktop visual nodes against enabled timeline layers without mutating the frame. */
export function applyP0DesktopLayers(
  frame: RenderFrameIR,
  context: HtmlSceneProjectContext,
  timeUs: number,
): RenderFrameIR {
  const normalized = normalizeUniversalTimeline(context.visual);
  const clipObjects = record(context.visual.pluginData['joy.clipObjects']);
  const layerIndexByNodeId = new Map<string, number>();
  const activeP0TitleIds = new Set<string>();
  let layerIndex = 0;

  for (const item of normalized.items) {
    if (item.compositionId !== frame.compositionId || !item.trackEnabled) continue;
    const objectId = objectIdForItem(item, clipObjects);
    const object = objectId === undefined ? undefined : context.visual.visualObjects[objectId];
    const isP0Title =
      object?.kind === 'html-scene' && object.scenePackageId?.startsWith('joy.p0.') === true;
    const isActive = timeUs >= item.startUs && timeUs < item.startUs + item.durationUs;

    if (isP0Title) {
      if (!isActive || objectId === undefined) continue;
      activeP0TitleIds.add(objectId);
    } else if (!isActive || !VISUAL_ELEMENT_KINDS.has(item.elementKind)) {
      continue;
    }

    const nodeId = isP0Title ? objectId : item.id;
    if (nodeId !== undefined) layerIndexByNodeId.set(nodeId, layerIndex);
    if (objectId !== undefined && !isP0Title) layerIndexByNodeId.set(objectId, layerIndex);
    layerIndex += 1;
  }

  const nodes: RenderNode[] = [];
  for (const node of frame.nodes) {
    const object = context.visual.visualObjects[node.id];
    if (
      object?.kind === 'html-scene' &&
      object.scenePackageId?.startsWith('joy.p0.') === true &&
      !activeP0TitleIds.has(node.id)
    ) {
      continue;
    }
    const zIndex = layerIndexByNodeId.get(node.id);
    nodes.push(zIndex === undefined || zIndex === node.zIndex ? node : { ...node, zIndex });
  }

  return { ...frame, nodes };
}
