import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuPreviewHost } from './gpu-preview-host.js';

const harness = vi.hoisted(() => ({ launch: vi.fn(), events: [] as string[] }));

vi.mock('playwright-core', () => ({ chromium: { launch: harness.launch } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  harness.events.length = 0;
});

function textNode(
  id: string,
  text: string,
  fontFamily: string,
  direction: 'ltr' | 'rtl' | 'auto' | undefined = 'auto',
) {
  return {
    kind: 'text' as const,
    id,
    zIndex: 0,
    opacity: 1,
    transform: { translateX: 20, translateY: 30, scaleX: 1, scaleY: 1 },
    text,
    color: { r: 255, g: 255, b: 255, a: 255 },
    ...(direction === undefined ? {} : { direction }),
    align: 'start' as const,
    fontFamily,
    fontSizePx: 24,
  };
}

describe('GpuPreviewHost text setup', () => {
  it('loads shipped fonts before rendering and sends script-aware styles to the page', async () => {
    const styles: string[] = [];
    const fontLoads: Array<{ font: string; text: string }> = [];
    const gl = {
      RENDERER: 1,
      VENDOR: 2,
      VERSION: 3,
      getExtension: () => null,
      getParameter: (parameter: number) =>
        parameter === 1 ? 'test hardware renderer' : parameter === 2 ? 'test vendor' : 'WebGL 2.0',
    };
    const page = {
      addStyleTag: vi.fn(async ({ content }: { content: string }) => {
        styles.push(content);
        harness.events.push('font-css');
      }),
      evaluate: vi.fn(async (fn: () => unknown, input?: unknown) => {
        if (input !== undefined) {
          harness.events.push('frame');
          return { width: 320, height: 180, pngBase64: 'QQ==' };
        }
        return await fn();
      }),
    };
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: (kind: string) => (kind === 'webgl2' ? gl : null) }),
      fonts: {
        load: async (font: string, text: string) => {
          fontLoads.push({ font, text });
          harness.events.push(`font:${font}`);
          return [{}];
        },
      },
    });
    harness.launch.mockResolvedValue({
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    });

    const host = await GpuPreviewHost.create('C:\\fake\\chrome.exe');
    const request = {
      sessionId: 'session',
      requestId: 'request',
      quality: 'full',
      bitmaps: [],
      frame: {
        version: 1,
        compositionId: 'root',
        timeUs: 0,
        viewport: { width: 320, height: 180, dpr: 1 },
        background: { r: 0, g: 0, b: 0, a: 255 },
        nodes: [
          textNode('persian', '\u0633\u0644\u0627\u0645 \u06F1\u06F2\u06F3', 'Vazirmatn Variable'),
          textNode('arabic', '\u0645\u0631\u062D\u0628\u0627', 'Noto Sans Arabic'),
          textNode('latin', 'JOY Media', 'Inter Variable'),
          textNode('legacy', '\u0633\u0644\u0627\u0645', 'Vazirmatn Variable', undefined),
        ],
      },
    } as unknown as Parameters<GpuPreviewHost['render']>[0];

    await host.render(request);

    expect(styles).toHaveLength(1);
    expect(styles[0]).toContain('@font-face');
    expect(styles[0]).toContain('font-family: "Vazirmatn Variable"');
    expect(styles[0]).toContain('font-family: "Noto Sans Arabic"');
    expect(styles[0]).toContain('data:font/woff2;base64,');
    expect(fontLoads).toContainEqual({
      font: '16px "Vazirmatn Variable"',
      text: '\u0633\u0644\u0627\u0645 \u06F1\u06F2\u06F3',
    });
    expect(fontLoads).toContainEqual({
      font: '16px "Noto Sans Arabic"',
      text: '\u0645\u0631\u062D\u0628\u0627',
    });
    expect(harness.events.indexOf('frame')).toBeGreaterThan(
      harness.events.map((event, index) => (event.startsWith('font:') ? index : -1)).at(-1) ?? -1,
    );

    const renderInput = page.evaluate.mock.calls.at(-1)?.[1] as {
      textStyles?: Record<
        string,
        { lineDirections: string[]; lineAlignments: string[]; fontFamilyStack: string[] }
      >;
    };
    expect(renderInput.textStyles?.persian).toMatchObject({
      lineDirections: ['rtl'],
      lineAlignments: ['right'],
    });
    expect(renderInput.textStyles?.persian?.fontFamilyStack.slice(0, 2)).toEqual([
      'Vazirmatn Variable',
      'Inter Variable',
    ]);
    expect(renderInput.textStyles?.arabic?.fontFamilyStack.slice(0, 2)).toEqual([
      'Noto Sans Arabic',
      'Inter Variable',
    ]);
    expect(renderInput.textStyles?.latin?.fontFamilyStack[0]).toBe('Inter Variable');
    expect(renderInput.textStyles?.legacy?.lineDirections).toEqual(['rtl']);
    await host.destroy();
  });

  it('draws each newline separated text line with its own direction and alignment', async () => {
    const draws: Array<{
      text: string;
      x: number;
      y: number;
      direction: string;
      align: string;
      letterSpacing: string;
      maxWidth?: number;
    }> = [];
    const strokes: Array<{ text: string; x: number; y: number; maxWidth?: number }> = [];
    const gl = {
      ARRAY_BUFFER: 1,
      BLEND: 2,
      COLOR_BUFFER_BIT: 3,
      FLOAT: 4,
      FRAGMENT_SHADER: 5,
      LINK_STATUS: 6,
      ONE_MINUS_SRC_ALPHA: 7,
      RENDERER: 8,
      SRC_ALPHA: 9,
      STATIC_DRAW: 10,
      TRIANGLES: 11,
      VENDOR: 12,
      VERSION: 13,
      VERTEX_SHADER: 14,
      createShader: () => ({}),
      createProgram: () => ({}),
      createBuffer: () => ({}),
      shaderSource: () => undefined,
      compileShader: () => undefined,
      attachShader: () => undefined,
      linkProgram: () => undefined,
      getProgramParameter: () => true,
      getProgramInfoLog: () => '',
      useProgram: () => undefined,
      getAttribLocation: () => 0,
      getUniformLocation: () => ({}),
      bindBuffer: () => undefined,
      bufferData: () => undefined,
      enableVertexAttribArray: () => undefined,
      vertexAttribPointer: () => undefined,
      uniform2f: () => undefined,
      uniform4f: () => undefined,
      enable: () => undefined,
      blendFunc: () => undefined,
      clearColor: () => undefined,
      clear: () => undefined,
      finish: () => undefined,
      drawArrays: () => undefined,
      deleteBuffer: () => undefined,
      deleteProgram: () => undefined,
      deleteShader: () => undefined,
      getExtension: () => null,
      getParameter: (parameter: number) =>
        parameter === 8 ? 'test hardware renderer' : parameter === 12 ? 'test vendor' : 'WebGL 2.0',
    };
    type PreviewCanvasContext = {
      direction: string;
      textAlign: string;
      imageSmoothingEnabled: boolean;
      globalAlpha: number;
      textBaseline: string;
      font: string;
      letterSpacing: string;
      fillStyle: string;
      strokeStyle: string;
      lineWidth: number;
      save: () => void;
      restore: () => void;
      drawImage: () => void;
      measureText: (text: string) => { width: number };
      fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
      strokeText: (text: string, x: number, y: number, maxWidth?: number) => void;
    };
    const context: PreviewCanvasContext = {
      direction: 'ltr',
      textAlign: 'left',
      imageSmoothingEnabled: false,
      globalAlpha: 1,
      textBaseline: 'top',
      font: '',
      letterSpacing: '0px',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      save: () => undefined,
      restore: () => undefined,
      drawImage: () => undefined,
      measureText: (text) => {
        const length = [...text].length;
        const tracking = Number.parseFloat(context.letterSpacing) || 0;
        return { width: length * 10 + Math.max(0, length - 1) * tracking };
      },
      fillText: (text, x, y, maxWidth) =>
        draws.push({
          text,
          x,
          y,
          direction: context.direction,
          align: context.textAlign,
          letterSpacing: context.letterSpacing,
          ...(maxWidth === undefined ? {} : { maxWidth }),
        }),
      strokeText: (text, x, y, maxWidth) =>
        strokes.push({ text, x, y, ...(maxWidth === undefined ? {} : { maxWidth }) }),
    };
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: (kind: string) => (kind === 'webgl2' ? gl : context),
        toDataURL: () => 'data:image/png;base64,QQ==',
      }),
      fonts: { load: async () => [] },
    });
    const page = {
      addStyleTag: vi.fn(async () => undefined),
      evaluate: vi.fn(async (fn: (value?: unknown) => unknown, value?: unknown) =>
        value === undefined ? await fn() : await fn(value),
      ),
    };
    harness.launch.mockResolvedValue({
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    });
    const host = await GpuPreviewHost.create('C:\\fake\\chrome.exe');
    const request = {
      sessionId: 'session',
      requestId: 'request',
      quality: 'full',
      bitmaps: [],
      frame: {
        version: 1,
        compositionId: 'root',
        timeUs: 0,
        viewport: { width: 320, height: 180, dpr: 1 },
        background: { r: 0, g: 0, b: 0, a: 255 },
        nodes: [
          {
            ...textNode('mixed-lines', '\u0633\u0644\u0627\u0645\nJOY', 'Vazirmatn Variable'),
            text: '\u0633\u0644\u0627\u0645\nJOY Media',
            lineHeight: 1.5,
            maxWidth: 60,
            tracking: 2,
            stroke: { widthPx: 1, color: { r: 0, g: 0, b: 0, a: 255 } },
          },
        ],
      },
    } as unknown as Parameters<GpuPreviewHost['render']>[0];

    await host.render(request);

    expect(draws).toEqual([
      {
        text: '\u0633\u0644\u0627\u0645',
        x: 20,
        y: 30,
        direction: 'rtl',
        align: 'right',
        letterSpacing: '2px',
      },
      {
        text: 'JOY',
        x: 20,
        y: 66,
        direction: 'ltr',
        align: 'left',
        letterSpacing: '2px',
      },
      {
        text: 'Media',
        x: 20,
        y: 102,
        direction: 'ltr',
        align: 'left',
        letterSpacing: '2px',
      },
    ]);
    expect(strokes).toEqual([
      { text: '\u0633\u0644\u0627\u0645', x: 20, y: 30 },
      { text: 'JOY', x: 20, y: 66 },
      { text: 'Media', x: 20, y: 102 },
    ]);
    await host.destroy();
  });
});
