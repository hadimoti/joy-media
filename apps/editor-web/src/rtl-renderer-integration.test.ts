import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderFrameIR, RenderNode } from '@joy-media/render-ir';
import { layoutTemplatedCaptionNodes, rtlStressCues } from '@joy-media/captions-core';
import { visualObjectToRenderNode } from '@joy-media/visual-object-renderer';
import type { ResolvedObject } from '@joy-media/visual-object-renderer';
import {
  createBrowserPixiRenderer,
  pixiTextDirectionOf,
} from '@joy-media/renderer-pixi/browser';
import { withCaptionBurnIn, withCaptionBurnInNodes } from './caption-burn-in.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { TEXT_TEMPLATES } from './text-template-catalog.js';

const harness = vi.hoisted(() => ({
  stages: [] as unknown[],
  fontLoads: [] as string[],
  fontsAtInit: [] as string[],
}));

class FakeContainerBase {
  label = '';
  zIndex = 0;
  get width(): number {
    return 0;
  }
  set width(_value: number) {}
  get height(): number {
    return 0;
  }
  set height(_value: number) {}
  addChild(..._children: FakeContainerBase[]): void {}
  getChildByLabel(_label: string, _deep?: boolean): FakeContainerBase | null {
    return null;
  }
}

vi.mock('../../../packages/renderer-pixi/node_modules/pixi.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Container = actual.Container as typeof FakeContainerBase;
  class FakeApplication {
    readonly canvas = { width: 0, height: 0, style: { width: '', height: '' } };
    readonly stage = new Container();
    readonly renderer = {
      resolution: 1,
      resize: (width: number, height: number, resolution = 1): void => {
        this.canvas.width = Math.round(width * resolution);
        this.canvas.height = Math.round(height * resolution);
      },
      render: (): void => {},
    };
    async init(options: { width: number; height: number; resolution: number }): Promise<void> {
      this.renderer.resize(options.width, options.height, options.resolution);
      harness.fontsAtInit = [...harness.fontLoads];
      harness.stages.push(this.stage);
    }
    destroy(): void {}
  }

  class FakeText extends Container {
    text = '';
    style: unknown = {};
    readonly anchor = {
      x: 0,
      y: 0,
      set(x: number, y: number): void {
        this.x = x;
        this.y = y;
      },
    };
    override get width(): number {
      return this.text.length * 10;
    }
    override set width(_value: number) {}
    override get height(): number {
      return 20;
    }
    override set height(_value: number) {}
  }

  return { ...actual, Application: FakeApplication, Text: FakeText };
});

vi.mock('./effects-pixi.js', () => ({
  buildPixiColorGradeFilter: vi.fn(() => undefined),
  buildPixiEffectFilters: vi.fn(() => []),
  colorGradeSignature: vi.fn(() => ''),
  disposePixiColorGradeFilter: vi.fn(),
  effectsSignature: vi.fn(() => ''),
}));

vi.mock('./gl-transition-filter.js', () => ({
  createGlTransitionFilter: vi.fn(() => undefined),
}));

vi.mock('./transition-bitmaps.js', () => ({
  dualTextureBitmapsReady: vi.fn(async () => true),
}));

const WHITE = { r: 255, g: 255, b: 255, a: 255 };

function frame(nodes: readonly RenderNode[]): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 1080, height: 1920, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes,
  };
}

function renderedText(id: string): {
  style: { direction?: string; align?: string; fontFamily?: readonly string[]; wordWrap?: boolean };
} {
  const stage = harness.stages.at(-1) as FakeContainerBase;
  const text = stage.getChildByLabel(`text:${id}`, true);
  if (text === null) throw new Error(`text ${id} was not rendered`);
  return text as unknown as {
    style: {
      direction?: string;
      align?: string;
      fontFamily?: readonly string[];
      wordWrap?: boolean;
    };
  };
}

/** Pixi 8 has no style.direction: the adapter registers the direction per style object. */
function directionOfRendered(text: { style: object }): string | undefined {
  return pixiTextDirectionOf(text.style)?.direction;
}

function renderedTextContent(id: string): string {
  const stage = harness.stages.at(-1) as FakeContainerBase;
  const text = stage.getChildByLabel(`text:${id}`, true);
  if (text === null) throw new Error(`text ${id} was not rendered`);
  return (text as unknown as { text: string }).text;
}

function renderedTextNode(id: string): { text: string; style: Record<string, unknown> } {
  const stage = harness.stages.at(-1) as FakeContainerBase;
  const text = stage.getChildByLabel(`text:${id}`, true);
  if (text === null) throw new Error(`text ${id} was not rendered`);
  return text as unknown as { text: string; style: Record<string, unknown> };
}

beforeEach(() => {
  harness.stages.length = 0;
  harness.fontLoads.length = 0;
  harness.fontsAtInit.length = 0;
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => null }),
    fonts: Object.assign(new EventTarget(), {
      load: async (font: string) => (harness.fontLoads.push(font), []),
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser text direction', () => {
  it('passes the Render IR direction to Pixi text drawing', async () => {
    const node = {
      kind: 'text',
      id: 'rtl-title',
      zIndex: 0,
      opacity: 1,
      transform: { translateX: 540, translateY: 300, scaleX: 1, scaleY: 1 },
      text: 'سلام دنیا',
      color: WHITE,
      direction: 'rtl',
      align: 'right',
    } satisfies RenderNode;
    const renderer = await createBrowserPixiRenderer();

    renderer.render(frame([node]));

    expect(directionOfRendered(renderedText(node.id))).toBe('rtl');
    expect(harness.fontsAtInit).toEqual([
      '16px "Inter Variable"',
      '16px "Vazirmatn Variable"',
      '16px "Noto Sans Arabic"',
      '16px "Noto Naskh Arabic"',
    ]);
    renderer.destroy();
  });

  it('wraps auto-directed paragraphs and keeps logical start alignment', async () => {
    const node = {
      kind: 'text',
      id: 'mixed-paragraphs',
      zIndex: 0,
      opacity: 1,
      transform: { translateX: 540, translateY: 300, scaleX: 1, scaleY: 1 },
      text: 'سلام دنیا\nJOY Media',
      color: WHITE,
      direction: 'auto',
      align: 'start',
      maxWidth: 80,
    } satisfies RenderNode;
    const renderer = await createBrowserPixiRenderer();

    renderer.render(frame([node]));

    expect(renderedText(node.id).style).toMatchObject({ wordWrap: false });
    expect(pixiTextDirectionOf(renderedText(node.id).style)).toMatchObject({
      align: 'start',
      lineDirections: ['rtl', 'rtl', 'ltr', 'ltr'],
    });
    expect(renderedText(node.id).style.fontFamily).toContain('Vazirmatn Variable');
    expect(renderedTextContent(node.id)).toContain('\n');
    renderer.destroy();
  });

  it('keeps the existing LTR text, font, and Pixi word-wrap settings', async () => {
    const node = {
      kind: 'text',
      id: 'ltr-title',
      zIndex: 0,
      opacity: 1,
      transform: { translateX: 80, translateY: 60, scaleX: 1, scaleY: 1 },
      text: 'The story starts here',
      color: WHITE,
      direction: 'ltr',
      align: 'left',
      fontFamily: 'Arial',
      maxWidth: 100,
    } satisfies RenderNode;
    const renderer = await createBrowserPixiRenderer();

    renderer.render(frame([node]));

    const rendered = renderedTextNode(node.id);
    expect(rendered.text).toBe(node.text);
    expect(rendered.style).toMatchObject({
      align: 'left',
      fontFamily: 'Arial',
      wordWrap: true,
      wordWrapWidth: 100,
    });
    renderer.destroy();
  });

  it('routes title templates, motion text, regular captions, and burn-in through one renderer', async () => {
    const rtlTemplate = TEXT_TEMPLATES.find((template) => template.id === 'rtl-editorial-title');
    if (rtlTemplate === undefined) throw new Error('expected the RTL title template');
    const templateTransform = {
      x: 540,
      y: 200,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const asTextNode = (id: string): RenderNode => {
      const object = {
        id,
        kind: 'text',
        transform: templateTransform,
        textDocument: rtlTemplate.document,
        textStyle: rtlTemplate.style,
      } as const;
      const resolved = { object, transform: templateTransform } as ResolvedObject;
      const node = visualObjectToRenderNode(resolved);
      if (node === undefined || node.kind !== 'text') throw new Error('expected a text node');
      return node;
    };
    const titleNode = asTextNode('title-template');
    const motionTextNode = asTextNode('motion-text-template');
    const regularCaptions = layoutTemplatedCaptionNodes(rtlStressCues(), {
      viewportWidth: 1080,
      viewportHeight: 1920,
    });
    const originalCaptionDocument = INITIAL_EDITOR_PROJECT.captionDocuments['captions-fa'];
    if (originalCaptionDocument === undefined)
      throw new Error('expected the editor caption fixture');
    const rtlProject = {
      ...INITIAL_EDITOR_PROJECT,
      captionDocuments: {
        ...INITIAL_EDITOR_PROJECT.captionDocuments,
        'captions-fa': {
          ...originalCaptionDocument,
          language: 'fa' as const,
          direction: 'auto' as const,
          words: {
            ...originalCaptionDocument.words,
            w4: { ...originalCaptionDocument.words.w4!, text: 'سلام' },
            w5: { ...originalCaptionDocument.words.w5!, text: 'دنیا' },
          },
        },
      },
    };
    const initialFrame = {
      ...frame([titleNode, motionTextNode, ...regularCaptions]),
      timeUs: 3_100_000,
    };
    const withBurnIn = withCaptionBurnInNodes(initialFrame, withCaptionBurnIn(rtlProject, true));
    const renderer = await createBrowserPixiRenderer();

    renderer.render(withBurnIn);

    expect(directionOfRendered(renderedText('title-template'))).toBe('rtl');
    expect(directionOfRendered(renderedText('motion-text-template'))).toBe('rtl');
    expect(regularCaptions.length).toBeGreaterThan(0);
    expect(directionOfRendered(renderedText(regularCaptions[0]!.id))).toBe('rtl');
    const burnInNode = withBurnIn.nodes
      .slice(initialFrame.nodes.length)
      .find((node) => node.kind === 'text');
    expect(burnInNode?.kind).toBe('text');
    if (burnInNode?.kind !== 'text') throw new Error('expected a burned-in caption');
    expect(burnInNode).toMatchObject({ direction: 'rtl', text: 'سلام دنیا' });
    expect(directionOfRendered(renderedText(burnInNode.id))).toBe('rtl');
    renderer.destroy();
  });
});
