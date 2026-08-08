/**
 * @joy-media/render-ir — Renderer-independent evaluated scene description.
 *
 * WP-01.3 state: v1 visual nodes plus groups, and a separate editor-overlay contract.
 */
export const PACKAGE_NAME = '@joy-media/render-ir' as const;

export type {
  Rgba,
  Viewport,
  Transform2D,
  SpriteNode,
  VideoFrameNode,
  TextNode,
  TextSpan,
  GroupNode,
  TransitionNode,
  EffectKindIR,
  EffectInstanceIR,
  EffectNode,
  ColorGradeIR,
  GradeNode,
  RenderNode,
  VisualRenderNode,
  RenderFrameIR,
  EditorOverlayIR,
} from './model.js';
export { flattenRenderNodes, validateRenderFrameIR } from './model.js';
export type { TextPlateBounds } from './text-layout.js';
export { textPlateBounds } from './text-layout.js';
