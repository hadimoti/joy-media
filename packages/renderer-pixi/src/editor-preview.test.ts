import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { renderPixiEditorPreview, renderPixiPreview } from './index.js';

const content: RenderFrameIR = {
  version: 1,
  compositionId: 'root',
  timeUs: 0,
  viewport: { width: 2, height: 2, dpr: 1 },
  background: { r: 0, g: 0, b: 0, a: 255 },
  nodes: [],
};

describe('Pixi editor preview host', () => {
  it('keeps editor overlays out of content pixels', () => {
    const contentPreview = renderPixiPreview(content);
    const editorPreview = renderPixiEditorPreview(content, {
      version: 1,
      selections: [{ nodeId: 'not-a-content-node', x: 0, y: 0, width: 2, height: 2 }],
    });
    expect(editorPreview.pixels).toEqual(contentPreview.pixels);
    expect(editorPreview.overlay.selections).toHaveLength(1);
  });
});
