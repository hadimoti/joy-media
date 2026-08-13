/**
 * Caption burn-in preference + Render IR helpers (P14.6).
 *
 * When enabled, caption template layout nodes are merged into the preview/export
 * frame so burned-in captions match the Captions panel preview.
 */

import { captionCuesAt, layoutTemplatedCaptionNodes } from '@joy-media/captions-core';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { RenderFrameIR, RenderNode, TextNode } from '@joy-media/render-ir';

export const CAPTION_BURN_IN_KEY = 'joy.captions.burnIn' as const;

export function readCaptionBurnIn(project: JoyProjectV1): boolean {
  return project.pluginData[CAPTION_BURN_IN_KEY] === true;
}

export function withCaptionBurnIn(project: JoyProjectV1, enabled: boolean): JoyProjectV1 {
  return {
    ...project,
    pluginData: {
      ...project.pluginData,
      [CAPTION_BURN_IN_KEY]: enabled,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function captionBurnInNodes(project: JoyProjectV1, timeUs: number): readonly TextNode[] {
  if (!readCaptionBurnIn(project)) return [];
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return [];
  const cues = captionCuesAt(
    composition,
    project.captionDocuments,
    timeUs,
    project.propertyAnimations,
  );
  return layoutTemplatedCaptionNodes(cues, {
    viewportWidth: composition.width,
    viewportHeight: composition.height,
  }) as readonly TextNode[];
}

/** Append burn-in caption nodes onto a frame (zIndex above content). */
export function withCaptionBurnInNodes(frame: RenderFrameIR, project: JoyProjectV1): RenderFrameIR {
  const captions = captionBurnInNodes(project, frame.timeUs);
  if (captions.length === 0) return frame;
  const nodes: RenderNode[] = [
    ...frame.nodes,
    ...captions.map((node, index) => ({
      ...node,
      zIndex: Math.max(node.zIndex, 900 + index),
    })),
  ];
  return { ...frame, nodes };
}
