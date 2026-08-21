import type { BrowserPixiRenderer } from '@joy-media/renderer-pixi/browser';
import { createBrowserPixiRenderer } from '@joy-media/renderer-pixi/browser';
import type { RenderFramePlan } from '@joy-media/render-planner';

export interface OfflineRenderPage {
  readonly canvas: HTMLCanvasElement;
  paint(plan: RenderFramePlan): void;
  destroy(): void;
}

/**
 * Browser-side page entry used by pinned Chromium hosts. The Worker drives this
 * page with preplanned frames and private media captures; the page only sees
 * opaque render plans plus transient decoded bitmaps.
 */
export async function createOfflineRenderPage(parent?: HTMLElement): Promise<OfflineRenderPage> {
  const renderer: BrowserPixiRenderer = await createBrowserPixiRenderer({
    autoStart: false,
    backgroundAlpha: 1,
    ...(parent === undefined ? {} : { parent }),
  });
  return {
    canvas: renderer.canvas,
    paint(plan) {
      renderer.render(plan.frame);
    },
    destroy() {
      renderer.destroy();
    },
  };
}
