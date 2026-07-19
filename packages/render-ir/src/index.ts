/**
 * @joy-media/render-ir — Renderer-independent evaluated scene description.
 *
 * WP-00.3 state: a minimal evaluated frame IR for deterministic preview/export
 * parity. It contains no project-document, DOM, Pixi, or media-decoder values.
 */
export const PACKAGE_NAME = '@joy-media/render-ir' as const;

export type {
  Rgba,
  Viewport,
  Transform2D,
  SpriteNode,
  VideoFrameNode,
  TextNode,
  RenderNode,
  RenderFrameIR,
} from './model.js';
export { validateRenderFrameIR } from './model.js';
