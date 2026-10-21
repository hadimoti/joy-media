import { expect, it, vi } from 'vitest';
import { BufferImageSource, Texture, type Container } from 'pixi.js';
import type * as Pixi from 'pixi.js';
import type { RenderFrameIR, TransitionNode } from '@joy-media/render-ir';
import { createBrowserPixiRenderer } from './browser.js';
import { createGlTransitionFilter } from './gl-transition-filter.js';

const rendered = vi.hoisted(() => ({ stage: undefined as Container | undefined }));

// Replace only GPU application setup. Container lookup, Graphics and the
// production transition lifecycle use real Pixi objects, including null misses.
vi.mock('pixi.js', async (importOriginal) => {
  const pixi = await importOriginal<typeof Pixi>();
  return {
    ...pixi,
    Application: class {
      stage = new pixi.Container();
      renderer = {
        resize() {},
        render(stage: Container) {
          rendered.stage = stage;
        },
      };
      init() {
        return Promise.resolve();
      }
      destroy() {
        this.stage.destroy({ children: true });
      }
    },
  };
});

it('binds and replaces the incoming dissolve texture in the GPU resource group', () => {
  // Only shader precision probing needs a browser. Keep Shader/Filter binding real.
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
  const incoming = new Texture({
    source: new BufferImageSource({
      resource: new Uint8Array([0, 0, 255, 255]),
      width: 1,
      height: 1,
    }),
  });
  const replacement = new Texture({
    source: new BufferImageSource({
      resource: new Uint8Array([0, 255, 0, 255]),
      width: 1,
      height: 1,
    }),
  });
  const handle = createGlTransitionFilter('dissolve')!;
  const boundResources = () =>
    Object.values(handle.filter.groups).flatMap((group) => Object.values(group.resources));
  try {
    handle.setToTexture(incoming);
    expect(boundResources()).toContain(incoming.source);
    handle.setToTexture(replacement);
    expect(boundResources()).toContain(replacement.source);
    expect(boundResources()).not.toContain(incoming.source);
  } finally {
    handle.destroy();
    incoming.destroy(true);
    replacement.destroy(true);
    vi.unstubAllGlobals();
  }
});

it('creates the first dissolve layer on a null lookup, reuses it, and removes it when finished', async () => {
  const transition: TransitionNode = {
    id: 'red-blue',
    kind: 'transition',
    zIndex: 1,
    opacity: 1,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    width: 320,
    height: 180,
    color: { r: 0, g: 0, b: 0, a: 255 },
    transitionType: 'dissolve',
    shaderId: 'dissolve',
    progress: 0,
    leftClipId: 'red',
    rightClipId: 'blue',
  };
  const frame: RenderFrameIR = {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 320, height: 180, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes: [transition],
  };
  const renderer = await createBrowserPixiRenderer();
  try {
    // No decoder bitmaps yet: even the first fallback frame must create a layer.
    expect(renderer.render(frame).drawCalls).toBe(1);
    const content = rendered.stage!.getChildByLabel('renderer-pixi:content')!;
    const transitions = content.getChildByLabel('renderer-pixi:transitions')!;
    expect(transitions.children).toHaveLength(1);
    const first = transitions.getChildByName('transition:red-blue')!;
    expect(first).not.toBeNull();
    expect(first.children).toHaveLength(1);

    expect(
      renderer.render({ ...frame, timeUs: 500_000, nodes: [{ ...transition, progress: 0.5 }] })
        .drawCalls,
    ).toBe(1);
    expect(transitions.children).toHaveLength(1);
    expect(transitions.getChildByName('transition:red-blue')).toBe(first);

    expect(renderer.render({ ...frame, timeUs: 1_000_000, nodes: [] }).drawCalls).toBe(0);
    expect(transitions.children).toHaveLength(0);
    expect(first.destroyed).toBe(true);
  } finally {
    renderer.destroy();
  }
});
