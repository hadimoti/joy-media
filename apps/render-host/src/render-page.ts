import type { BrowserPixiRenderer } from '@joy-media/renderer-pixi/browser';
import type { RenderHostExportRequestV1, RenderHostExportResultV1 } from './protocol.js';
import type { RenderHostFrameInputV1 } from './protocol.js';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';

export interface OfflineRenderPage {
  readonly canvas?: HTMLCanvasElement;
  paint(input: RenderHostFrameInputV1): Uint8Array | Promise<Uint8Array>;
  destroy(): void;
}

/**
 * Browser-side page entry used by pinned Chromium hosts. The Worker drives this
 * page with preplanned frames and private media captures; the page only sees
 * opaque render plans plus transient decoded bitmaps.
 */
export async function createOfflineRenderPage(parent?: HTMLElement): Promise<OfflineRenderPage> {
  if (typeof document === 'undefined') return createDeterministicOfflineRenderPage();
  const { createBrowserPixiRenderer } = await import('@joy-media/renderer-pixi/browser');
  const renderer: BrowserPixiRenderer = await createBrowserPixiRenderer({
    autoStart: false,
    backgroundAlpha: 1,
    ...(parent === undefined ? {} : { parent }),
  });
  return {
    canvas: renderer.canvas,
    paint(input) {
      renderer.render(input.plan.frame);
      return readCanvasRgba(renderer.canvas, input) ?? renderHeadlessFrame(input.plan.frame).pixels;
    },
    destroy() {
      renderer.destroy();
    },
  };
}

function createDeterministicOfflineRenderPage(): OfflineRenderPage {
  let destroyed = false;
  return {
    paint(input) {
      if (destroyed) throw new Error('offline render page has been destroyed');
      return renderHeadlessFrame(input.plan.frame).pixels;
    },
    destroy() {
      destroyed = true;
    },
  };
}

function readCanvasRgba(
  canvas: HTMLCanvasElement,
  input: RenderHostFrameInputV1,
): Uint8Array | undefined {
  const width = input.plan.frame.viewport.width;
  const height = input.plan.frame.viewport.height;
  const context = canvas.getContext('2d');
  if (context === null) return undefined;
  return new Uint8Array(context.getImageData(0, 0, width, height).data);
}

export interface OfflineRenderHostTransport {
  export(request: RenderHostExportRequestV1): Promise<RenderHostExportResultV1>;
}

export async function createOfflineRenderHostTransport(options: {
  readonly createPage?: () => Promise<OfflineRenderPage>;
  readonly exportFile: (
    request: RenderHostExportRequestV1,
    runtime: { readonly page: OfflineRenderPage },
  ) => Promise<RenderHostExportResultV1>;
}): Promise<OfflineRenderHostTransport> {
  return {
    async export(request) {
      const page = await (options.createPage ?? createOfflineRenderPage)();
      try {
        return await options.exportFile(request, { page });
      } finally {
        page.destroy();
      }
    },
  };
}
