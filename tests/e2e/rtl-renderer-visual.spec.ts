import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('Chromium Pixi RTL text preserves Arabic dots, Persian yeh, and URL order', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const rendererModule = `/@fs/${resolve(process.cwd(), 'packages/renderer-pixi/src/browser.ts').replaceAll('\\', '/')}`;
  const directionModule = `/@fs/${resolve(process.cwd(), 'packages/renderer-pixi/src/text-direction.ts').replaceAll('\\', '/')}`;
  const result = await page.evaluate(
    async ({ rendererModuleUrl, directionModuleUrl }) => {
      const { createBrowserPixiRenderer } = await import(rendererModuleUrl);
      const { wrapTextByWords } = await import(directionModuleUrl);
      const width = 640;
      const height = 430;
      const fontFamily = 'Vazirmatn Variable';
      const arabic = '\u0639\u0644\u064a \u0643\u0631\u0633\u064a';
      const persian = '\u0639\u0644\u06cc \u06a9\u0631\u0633\u06cc';
      const url = 'https://example.com/a-very-long-path?q=42';
      const urlLine = `عنوان ${url} پایان`;
      await document.fonts.load(`100px "${fontFamily}"`, `${arabic} ${persian}`);
      const renderer = await createBrowserPixiRenderer({ width, height, resolution: 1 });
      const textNode = (
        id: string,
        text: string,
        x: number,
        y: number,
        fontSizePx: number,
        maxWidth: number,
        direction: 'rtl' | 'ltr' = 'rtl',
      ) => ({
        kind: 'text' as const,
        id,
        zIndex: 0,
        opacity: 1,
        transform: { translateX: x, translateY: y, scaleX: 1, scaleY: 1 },
        text,
        direction,
        align: 'right' as const,
        fontFamily,
        fontSizePx,
        maxWidth,
        color: { r: 255, g: 255, b: 255, a: 255 },
      });
      renderer.render({
        version: 1,
        compositionId: 'rtl-visual-regression',
        timeUs: 0,
        viewport: { width, height, dpr: 1 },
        background: { r: 12, g: 16, b: 28, a: 255 },
        nodes: [
          textNode('arabic', arabic, 600, 8, 100, 560),
          textNode('persian', persian, 600, 132, 100, 560),
          textNode('latin', 'JOY MEDIA', 600, 252, 100, 560, 'ltr'),
          textNode('mixed-url', urlLine, 450, 370, 28, 330),
        ],
      });
      await document.fonts.ready;
      const waitForRendererInk = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (performance.now() < deadline) {
          const pixels = renderer.readPixels(width, height);
          if (pixels?.data.some((channel, index) => index % 4 === 0 && channel > 120)) return;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        throw new Error('Timed out waiting for the renderer text font load to redraw.');
      };
      await waitForRendererInk();

      const browserReference = document.createElement('canvas');
      browserReference.width = width;
      browserReference.height = height;
      const context = browserReference.getContext('2d');
      if (context === null) throw new Error('2D canvas context unavailable');
      context.fillStyle = 'rgb(12 16 28)';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#fff';
      context.font = `100px "${fontFamily}"`;
      context.direction = 'rtl';
      context.textAlign = 'right';
      context.textBaseline = 'alphabetic';
      const referenceFont = context.measureText('|ÉqÅيM');
      const normalReferenceFont = context.measureText('|ÉqÅM');
      const arabicMetrics = context.measureText(arabic);
      const persianMetrics = context.measureText(persian);
      context.fillText(arabic, 600, 8 + referenceFont.actualBoundingBoxAscent);
      context.fillText(persian, 600, 132 + normalReferenceFont.actualBoundingBoxAscent);
      context.direction = 'ltr';
      context.fillText('JOY MEDIA', 600, 252 + normalReferenceFont.actualBoundingBoxAscent);
      context.direction = 'rtl';

      context.font = `28px "${fontFamily}"`;
      const wrapped = wrapTextByWords(
        urlLine,
        330,
        (text: string) => context.measureText(text).width,
        'rtl',
      );
      const browserReferenceUrlLines = ['عنوان', `\u2066${url}\u2069`, 'پایان'];
      context.textBaseline = 'alphabetic';
      const referenceUrlLines = browserReferenceUrlLines;
      const urlFontMetrics = context.measureText('|ÉqÅM');
      referenceUrlLines.forEach((line: string, index: number) => {
        context.fillText(
          line,
          450,
          370 +
            urlFontMetrics.actualBoundingBoxAscent +
            index *
              (urlFontMetrics.actualBoundingBoxAscent + urlFontMetrics.actualBoundingBoxDescent),
        );
      });

      const rendered = renderer.readPixels(width, height);
      if (rendered === undefined) throw new Error('Renderer did not return pixels');
      const pixels = document.createElement('canvas');
      pixels.width = width;
      pixels.height = height;
      const pixelsContext = pixels.getContext('2d');
      if (pixelsContext === null) throw new Error('2D pixel context unavailable');
      const imageData = pixelsContext.createImageData(width, height);
      imageData.data.set(rendered.data);
      pixelsContext.putImageData(imageData, 0, 0);
      const referencePixels = context.getImageData(0, 0, width, height).data;
      const maskOverlap = (top: number, bottom: number): number => {
        let intersection = 0;
        let union = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const rendererInk = rendered.data[offset]! > 120;
            const browserInk = referencePixels[offset]! > 120;
            if (rendererInk || browserInk) union += 1;
            if (rendererInk && browserInk) intersection += 1;
          }
        }
        return union === 0 ? 1 : intersection / union;
      };
      const inkCount = (data: Uint8ClampedArray, top: number, bottom: number): number => {
        let count = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4]! > 120) count += 1;
          }
        }
        return count;
      };
      const countBelowBaseline = (
        data: Uint8ClampedArray,
        baseline: number,
        bottom: number,
      ): number => {
        let count = 0;
        for (let y = baseline; y < bottom; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4]! > 120) count += 1;
          }
        }
        return count;
      };
      const result = {
        rendererPng: pixels.toDataURL(),
        referencePng: browserReference.toDataURL(),
        arabicDescent: arabicMetrics.actualBoundingBoxDescent,
        arabicMetricDescent: referenceFont.actualBoundingBoxDescent,
        arabicNodeHeight: renderer.nodeBounds('arabic')?.aabb.height,
        persianNodeHeight: renderer.nodeBounds('persian')?.aabb.height,
        latinNodeHeight: renderer.nodeBounds('latin')?.aabb.height,
        arabicReferenceHeight:
          referenceFont.actualBoundingBoxAscent + referenceFont.actualBoundingBoxDescent,
        normalReferenceHeight: (() => {
          return (
            normalReferenceFont.actualBoundingBoxAscent +
            normalReferenceFont.actualBoundingBoxDescent
          );
        })(),
        normalFontHeight: (() => {
          const metrics = context.measureText('|ÉqÅM');
          return metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
        })(),
        wrappedUrlText: wrapped.text,
        urlLineCount: referenceUrlLines.length,
        arabicMaskIou: maskOverlap(0, 128),
        persianMaskIou: maskOverlap(124, 250),
        latinMaskIou: maskOverlap(248, 365),
        urlMaskIou: maskOverlap(360, height),
        rendererArabicInk: inkCount(rendered.data, 0, 128),
        referenceArabicInk: inkCount(referencePixels, 0, 128),
        arabicDotsBelowBaseline: countBelowBaseline(
          rendered.data,
          8 + referenceFont.actualBoundingBoxAscent,
          8 + referenceFont.actualBoundingBoxAscent + arabicMetrics.actualBoundingBoxDescent,
        ),
        persianDotsBelowBaseline: countBelowBaseline(
          rendered.data,
          132 + normalReferenceFont.actualBoundingBoxAscent,
          132 +
            normalReferenceFont.actualBoundingBoxAscent +
            persianMetrics.actualBoundingBoxDescent,
        ),
      };
      renderer.destroy();
      return result;
    },
    { rendererModuleUrl: rendererModule, directionModuleUrl: directionModule },
  );

  await testInfo.attach('pixi-renderer.png', {
    body: Buffer.from(result.rendererPng!.split(',')[1]!, 'base64'),
    contentType: 'image/png',
  });
  await testInfo.attach('browser-reference.png', {
    body: Buffer.from(result.referencePng!.split(',')[1]!, 'base64'),
    contentType: 'image/png',
  });
  expect(result.arabicDescent).toBeGreaterThan(0);
  expect(result.arabicMetricDescent).toBeGreaterThan(21);
  expect(result.arabicNodeHeight).toBeGreaterThan(result.persianNodeHeight ?? 0);
  expect(result.arabicNodeHeight).toBeCloseTo(result.arabicReferenceHeight ?? 0, 0);
  expect(result.persianNodeHeight).toBeCloseTo(result.normalReferenceHeight ?? 0, 0);
  expect(result.latinNodeHeight).toBeCloseTo(result.normalReferenceHeight ?? 0, 0);
  expect(result.arabicDotsBelowBaseline).toBeGreaterThan(0);
  expect(result.arabicDotsBelowBaseline).toBeGreaterThan(
    (result.persianDotsBelowBaseline ?? 0) + 500,
  );
  expect(result.wrappedUrlText).toContain(
    `\u2068${'https://example.com/a-very-long-path?q=42'}\u2069`,
  );
  expect(result.wrappedUrlText.split('\n')).toContain(
    `\u2068${'https://example.com/a-very-long-path?q=42'}\u2069`,
  );
  expect(result.urlLineCount).toBeGreaterThan(1);
  expect(result.arabicMaskIou).toBeGreaterThan(0.65);
  expect(result.persianMaskIou).toBeGreaterThan(0.65);
  expect(result.latinMaskIou).toBeGreaterThan(0.65);
  expect(result.urlMaskIou).toBeGreaterThan(0.5);
  expect(result.rendererPng).toMatch(/^data:image\/png;base64,/u);
  expect(result.referencePng).toMatch(/^data:image\/png;base64,/u);
});

test('Chromium draws styled RTL URL fragments on one line in left-to-right order', async ({
  page,
}) => {
  await page.goto('/');
  const rendererModule =
    '/@fs/' + resolve(process.cwd(), 'packages/renderer-pixi/src/browser.ts').replaceAll('\\', '/');
  const result = await page.evaluate(async (rendererModuleUrl) => {
    const { createBrowserPixiRenderer } = await import(rendererModuleUrl);
    const width = 640;
    const height = 300;
    const head = 'https://example.com/';
    const tail = 'long-path?q=42';
    const white = { r: 255, g: 255, b: 255, a: 255 };
    const spans = [
      { text: 'عنوان ', color: white },
      { text: head, color: { r: 230, g: 35, b: 40, a: 255 } },
      { text: tail, color: { r: 30, g: 230, b: 45, a: 255 } },
    ];
    const text = spans.map((span) => span.text).join('');
    const fontFamily = 'Vazirmatn Variable';
    await document.fonts.load('30px "Vazirmatn Variable"', text);
    const renderer = await createBrowserPixiRenderer({ width, height, resolution: 1 });
    try {
      renderer.render({
        version: 1,
        compositionId: 'styled-url-regression',
        timeUs: 0,
        viewport: { width, height, dpr: 1 },
        background: { r: 11, g: 14, b: 25, a: 255 },
        nodes: [
          {
            kind: 'text',
            id: 'styled-url',
            zIndex: 0,
            opacity: 1,
            color: white,
            transform: { translateX: 590, translateY: 10, scaleX: 1, scaleY: 1 },
            text,
            spans,
            direction: 'rtl',
            align: 'right',
            fontFamily,
            fontSizePx: 30,
            maxWidth: 270,
          },
        ],
      });
      const bounds = (points: { x: number; y: number }[]) => ({
        count: points.length,
        left: Math.min(...points.map(({ x }) => x)),
        right: Math.max(...points.map(({ x }) => x)),
        top: Math.min(...points.map(({ y }) => y)),
        bottom: Math.max(...points.map(({ y }) => y)),
      });
      const cutoff = performance.now() + 5_000;
      do {
        const image = renderer.readPixels(width, height);
        const red: { x: number; y: number }[] = [];
        const green: { x: number; y: number }[] = [];
        if (image) {
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const offset = (y * width + x) * 4;
              const r = image.data[offset]!;
              const g = image.data[offset + 1]!;
              if (r > 150 && g < 80) red.push({ x, y });
              if (g > 150 && r < 80) green.push({ x, y });
            }
          }
        }
        if (red.length > 0 && green.length > 0) return { red: bounds(red), green: bounds(green) };
        await new Promise<void>((done) => requestAnimationFrame(() => done()));
      } while (performance.now() < cutoff);
      throw new Error('Styled URL colors were not rendered');
    } finally {
      renderer.destroy();
    }
  }, rendererModule);
  expect(result.red.count).toBeGreaterThan(100);
  expect(result.green.count).toBeGreaterThan(100);
  expect(result.red.right).toBeLessThan(result.green.left);
  expect(Math.min(result.red.bottom, result.green.bottom)).toBeGreaterThan(
    Math.max(result.red.top, result.green.top),
  );
  expect(result.red.top).toBeGreaterThan(38);
});
