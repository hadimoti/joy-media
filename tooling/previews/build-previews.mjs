#!/usr/bin/env node
/**
 * Builds WebP still previews for all effects/filters and 24-frame WebP strips
 * for all transitions using @joy-media/renderer-pixi/browser inside headless Chromium,
 * then writes tooling/previews/manifest.json with per-entry input/output hashes.
 *
 * Usage: node tooling/previews/build-previews.mjs [--only=all|effects|transitions] [--filter=<id>]
 * The manifest is rewritten only by an unfiltered run, and only after verification passes.
 * Every run fails on a page error or console.error from the harness.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUILDER_VERSION,
  DEFAULT_EFFECT_SOURCE,
  DEFAULT_SECOND_SOURCE_EFFECT_IDS,
  EFFECT_PREVIEW_PUBLIC_DIR,
  EFFECT_STILL_SPEC,
  PREVIEW_CROP,
  PREVIEW_MANIFEST_PATH,
  PREVIEW_MIN_MEAN_DIFF_FROM_BEFORE,
  PREVIEW_MIN_STDDEV,
  PREVIEW_SIZE_BUDGETS,
  PREVIEW_SOURCES_DIR,
  SECOND_SOURCE_PHOTO,
  TRANSITION_PIC1_SOURCE,
  TRANSITION_PIC2_SOURCE,
  TRANSITION_STRIP_SPEC,
  computeExpectedPreviewHashes,
  inspectEffectStillsMetrics,
  sha256Hex,
  transitionStripProgresses,
  verifyPreviewManifest,
} from './src/manifest.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');

const require = createRequire(import.meta.url);
const viteEntry = pathToFileURL(
  require.resolve('vite', { paths: [resolve(REPO_ROOT, 'apps/editor-web'), REPO_ROOT] }),
).href;
const playwrightEntry = pathToFileURL(require.resolve('playwright', { paths: [REPO_ROOT] })).href;
const prettierBin = resolve(REPO_ROOT, 'node_modules/prettier/bin/prettier.cjs');

function parseArgs(argv) {
  const secondSource = new Set(DEFAULT_SECOND_SOURCE_EFFECT_IDS);
  let only = 'all';
  let filterPattern = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--second-source' && i + 1 < argv.length) {
      for (const id of argv[++i].split(',')) {
        const trimmed = id.trim();
        if (trimmed.length > 0) secondSource.add(trimmed);
      }
    } else if (arg.startsWith('--second-source=')) {
      for (const id of arg.slice('--second-source='.length).split(',')) {
        const trimmed = id.trim();
        if (trimmed.length > 0) secondSource.add(trimmed);
      }
    } else if (arg === '--only' && i + 1 < argv.length) {
      only = argv[++i];
    } else if (arg.startsWith('--only=')) {
      only = arg.slice('--only='.length);
    } else if (arg === '--filter' && i + 1 < argv.length) {
      filterPattern = argv[++i];
    } else if (arg.startsWith('--filter=')) {
      filterPattern = arg.slice('--filter='.length);
    }
  }

  if (!['all', 'effects', 'transitions'].includes(only)) {
    throw new Error(`--only must be all, effects or transitions (got "${only}")`);
  }

  return {
    secondSourceEffectIds: [...secondSource].sort(),
    only,
    filterPattern,
  };
}

function cropSourceToPng(sourcePath, cropExpr, width, height) {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      sourcePath,
      '-vf',
      `${cropExpr},scale=${width}:${height}:flags=lanczos`,
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ],
    { maxBuffer: 30 * 1024 * 1024 },
  );
}

function encodePngToWebp(pngBuffer, outputPath, quality) {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-i',
      'pipe:0',
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      '-quality',
      String(quality),
      '-compression_level',
      '6',
      outputPath,
    ],
    { input: pngBuffer, maxBuffer: 30 * 1024 * 1024 },
  );
}

function decodeDataUrlPng(dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error(`Expected PNG data URL, got prefix "${dataUrl.slice(0, 40)}"`);
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

function harnessHtml() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>JOY Preview Builder</title></head>
  <body style="margin:0;background:#181818;">
    <script type="module" src="/__joy_preview_harness.ts"></script>
  </body>
</html>`;
}

function harnessModuleSource() {
  return `
import { createBrowserPixiRenderer } from '@joy-media/renderer-pixi/browser';

const bitmapCache = new Map();
const renderers = new Map();

async function getSourceBitmap(key, url) {
  const existing = bitmapCache.get(key);
  if (existing) return existing;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Failed to load source image: ' + url));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bitmap = { width: canvas.width, height: canvas.height, data: imageData.data };
  bitmapCache.set(key, bitmap);
  return bitmap;
}

async function getRenderer(width, height) {
  const key = width + 'x' + height;
  const existing = renderers.get(key);
  if (existing) return existing;
  const renderer = await createBrowserPixiRenderer({
    width,
    height,
    background: '#181818',
    antialias: true,
    preference: 'webgl',
  });
  document.body.appendChild(renderer.canvas);
  renderers.set(key, renderer);
  return renderer;
}

window.__joyRenderEffect = async ({ width, height, sourceKey, sourceUrl, effectId, params }) => {
  const renderer = await getRenderer(width, height);
  const bitmap = await getSourceBitmap(sourceKey, sourceUrl);
  const bitmaps = new Map([['clip-main', bitmap]]);
  const frame = {
    version: 1,
    compositionId: 'preview-still',
    timeUs: 0,
    viewport: { width, height, dpr: 1 },
    background: { r: 24, g: 24, b: 24, a: 255 },
    nodes: [
      {
        kind: 'video-frame',
        id: 'clip-main',
        zIndex: 0,
        opacity: 1,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        width,
        height,
        sourceTimeUs: 0,
        color: { r: 255, g: 255, b: 255, a: 255 },
        effects: effectId
          ? [{ id: 'fx-preview', kind: effectId, enabled: true, params: params ?? {} }]
          : undefined,
      },
    ],
  };
  await renderer.render(frame, bitmaps);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.drawImage(renderer.canvas, 0, 0, width, height);
  return out.toDataURL('image/png');
};

window.__joyRenderTransitionStrip = async ({
  frameWidth,
  frameHeight,
  pic1Key,
  pic1Url,
  pic2Key,
  pic2Url,
  transitionId,
  progresses,
}) => {
  const renderer = await getRenderer(frameWidth, frameHeight);
  const leftBitmap = await getSourceBitmap(pic1Key, pic1Url);
  const rightBitmap = await getSourceBitmap(pic2Key, pic2Url);
  const bitmaps = new Map([
    ['left-clip', leftBitmap],
    ['right-clip', rightBitmap],
  ]);

  const strip = document.createElement('canvas');
  strip.width = frameWidth * progresses.length;
  strip.height = frameHeight;
  const stripCtx = strip.getContext('2d');

  for (let i = 0; i < progresses.length; i++) {
    const progress = progresses[i];
    const frame = {
      version: 1,
      compositionId: 'preview-transition',
      timeUs: i * 40000,
      viewport: { width: frameWidth, height: frameHeight, dpr: 1 },
      background: { r: 24, g: 24, b: 24, a: 255 },
      nodes: [
        {
          kind: 'video-frame',
          id: 'left-clip',
          zIndex: 0,
          opacity: 1,
          transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
          width: frameWidth,
          height: frameHeight,
          sourceTimeUs: 0,
          color: { r: 255, g: 255, b: 255, a: 255 },
        },
        {
          kind: 'video-frame',
          id: 'right-clip',
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
          width: frameWidth,
          height: frameHeight,
          sourceTimeUs: 0,
          color: { r: 255, g: 255, b: 255, a: 255 },
        },
        {
          kind: 'transition',
          id: 'tr-preview',
          zIndex: 2,
          opacity: 1,
          transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
          width: frameWidth,
          height: frameHeight,
          color: { r: 255, g: 255, b: 255, a: 255 },
          transitionType: transitionId,
          shaderId: transitionId,
          progress,
          leftClipId: 'left-clip',
          rightClipId: 'right-clip',
        },
      ],
    };
    await renderer.render(frame, bitmaps);
    stripCtx.drawImage(renderer.canvas, i * frameWidth, 0, frameWidth, frameHeight);
  }

  return strip.toDataURL('image/png');
};
`;
}

async function main() {
  const { secondSourceEffectIds, only, filterPattern } = parseArgs(process.argv.slice(2));
  const { createServer } = await import(viteEntry);
  const pw = await import(playwrightEntry);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) {
    throw new Error('Failed to load Playwright chromium launcher');
  }

  const ownerCrop = `crop=${PREVIEW_CROP.width}:${PREVIEW_CROP.height}:${PREVIEW_CROP.x}:${PREVIEW_CROP.y}`;
  // Autumn path is 1672x941 landscape: center 4:3 crop is 1252x939 at x=210, y=1.
  const photoCrop = 'crop=1252:939:210:1';

  const croppedPngs = new Map([
    [
      'effect-default',
      cropSourceToPng(
        resolve(REPO_ROOT, PREVIEW_SOURCES_DIR, DEFAULT_EFFECT_SOURCE),
        ownerCrop,
        EFFECT_STILL_SPEC.width,
        EFFECT_STILL_SPEC.height,
      ),
    ],
    [
      'effect-photo',
      cropSourceToPng(
        resolve(REPO_ROOT, PREVIEW_SOURCES_DIR, SECOND_SOURCE_PHOTO),
        photoCrop,
        EFFECT_STILL_SPEC.width,
        EFFECT_STILL_SPEC.height,
      ),
    ],
    [
      'transition-pic1',
      cropSourceToPng(
        resolve(REPO_ROOT, PREVIEW_SOURCES_DIR, TRANSITION_PIC1_SOURCE),
        ownerCrop,
        TRANSITION_STRIP_SPEC.frameWidth,
        TRANSITION_STRIP_SPEC.frameHeight,
      ),
    ],
    [
      'transition-pic2',
      cropSourceToPng(
        resolve(REPO_ROOT, PREVIEW_SOURCES_DIR, TRANSITION_PIC2_SOURCE),
        ownerCrop,
        TRANSITION_STRIP_SPEC.frameWidth,
        TRANSITION_STRIP_SPEC.frameHeight,
      ),
    ],
  ]);

  const vitePlugin = {
    name: 'joy-preview-builder-harness',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/__joy_preview_harness.html') {
          res.setHeader('Content-Type', 'text/html');
          res.end(harnessHtml());
          return;
        }
        if (path.startsWith('/__sources/')) {
          const key = path.slice('/__sources/'.length).replace(/\.png$/, '');
          const png = croppedPngs.get(key);
          if (png) {
            res.setHeader('Content-Type', 'image/png');
            res.end(png);
            return;
          }
        }
        next();
      });
    },
    resolveId(id) {
      if (id === '/__joy_preview_harness.ts') return '\0joy_preview_harness.ts';
      return null;
    },
    load(id) {
      if (id === '\0joy_preview_harness.ts') return harnessModuleSource();
      return null;
    },
  };

  const server = await createServer({
    root: REPO_ROOT,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { include: ['pixi.js'] },
    resolve: {
      alias: {
        '@joy-media/renderer-pixi/browser': resolve(
          REPO_ROOT,
          'packages/renderer-pixi/src/browser.ts',
        ),
        '@joy-media/renderer-pixi': resolve(REPO_ROOT, 'packages/renderer-pixi/src/index.ts'),
        '@joy-media/render-ir': resolve(REPO_ROOT, 'packages/render-ir/src/index.ts'),
        '@joy-media/visual-effects': resolve(REPO_ROOT, 'packages/visual-effects/src/index.ts'),
        '@joy-media/transition-shaders': resolve(
          REPO_ROOT,
          'packages/transition-shaders/src/index.ts',
        ),
        '@joy-media/project-schema': resolve(REPO_ROOT, 'packages/project-schema/src/index.ts'),
      },
    },
    plugins: [vitePlugin],
  });

  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind ephemeral Vite preview server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const visualEffectsMod = await server.ssrLoadModule('/packages/visual-effects/src/index.ts');
  const transitionShadersMod = await server.ssrLoadModule(
    '/packages/transition-shaders/src/index.ts',
  );

  const effects = visualEffectsMod.listBuiltinEffects();
  const transitions = transitionShadersMod.listTransitionShaders();
  const expected = computeExpectedPreviewHashes({
    repoRoot: REPO_ROOT,
    effects,
    transitions,
    secondSourceEffectIds,
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const existingManifestPath = resolve(REPO_ROOT, PREVIEW_MANIFEST_PATH);
  let previousManifest = null;
  try {
    previousManifest = JSON.parse(readFileSync(existingManifestPath, 'utf8'));
  } catch {
    previousManifest = null;
  }

  try {
    const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', (err) => {
      browserErrors.push(`pageerror: ${err.message}`);
      console.error('[harness pageerror]', err);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        browserErrors.push(`console.error: ${text}`);
        console.error('[harness console.error]', text);
      }
    });
    await page.goto(`${baseUrl}/__joy_preview_harness.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction("typeof globalThis.__joyRenderEffect === 'function'");

    let beforeEntry = previousManifest?.before;
    const effectEntries = [];
    const transitionEntries = [];

    if (only === 'all' || only === 'effects') {
      if (!filterPattern) {
        const beforeDataUrl = await page.evaluate((args) => globalThis['__joyRenderEffect'](args), {
          width: EFFECT_STILL_SPEC.width,
          height: EFFECT_STILL_SPEC.height,
          sourceKey: 'effect-default',
          sourceUrl: `${baseUrl}/__sources/effect-default.png`,
          effectId: null,
          params: {},
        });
        const beforeRelPath = `${EFFECT_PREVIEW_PUBLIC_DIR}/before.webp`;
        const beforeAbsPath = resolve(REPO_ROOT, beforeRelPath);
        encodePngToWebp(decodeDataUrlPng(beforeDataUrl), beforeAbsPath, EFFECT_STILL_SPEC.quality);
        const beforeWebp = readFileSync(beforeAbsPath);
        beforeEntry = {
          outputPath: beforeRelPath,
          width: EFFECT_STILL_SPEC.width,
          height: EFFECT_STILL_SPEC.height,
          bytes: beforeWebp.length,
          outputSha256: sha256Hex(beforeWebp),
          inputHash: expected.beforeInputHash,
          inputs: expected.beforeInputs,
        };
      }

      for (const effect of effects) {
        if (filterPattern && !effect.id.includes(filterPattern)) continue;
        const exp = expected.effects.get(effect.id);
        const useSecond = exp.inputs.secondSource;
        const dataUrl = await page.evaluate((args) => globalThis['__joyRenderEffect'](args), {
          width: EFFECT_STILL_SPEC.width,
          height: EFFECT_STILL_SPEC.height,
          sourceKey: useSecond ? 'effect-photo' : 'effect-default',
          sourceUrl: `${baseUrl}/__sources/${useSecond ? 'effect-photo' : 'effect-default'}.png`,
          effectId: effect.id,
          params: exp.inputs.defaultValues,
        });
        const absOut = resolve(REPO_ROOT, exp.outputPath);
        encodePngToWebp(decodeDataUrlPng(dataUrl), absOut, EFFECT_STILL_SPEC.quality);
        const webp = readFileSync(absOut);
        effectEntries.push({
          id: effect.id,
          outputPath: exp.outputPath,
          width: EFFECT_STILL_SPEC.width,
          height: EFFECT_STILL_SPEC.height,
          bytes: webp.length,
          outputSha256: sha256Hex(webp),
          inputHash: exp.inputHash,
          inputs: exp.inputs,
        });
      }
    } else if (previousManifest?.effects) {
      effectEntries.push(...previousManifest.effects);
    }

    if (only === 'all' || only === 'transitions') {
      const progresses = transitionStripProgresses(TRANSITION_STRIP_SPEC);
      for (const transition of transitions) {
        if (filterPattern && !transition.id.includes(filterPattern)) continue;
        const exp = expected.transitions.get(transition.id);
        const stripDataUrl = await page.evaluate(
          (args) => globalThis['__joyRenderTransitionStrip'](args),
          {
            frameWidth: TRANSITION_STRIP_SPEC.frameWidth,
            frameHeight: TRANSITION_STRIP_SPEC.frameHeight,
            pic1Key: 'transition-pic1',
            pic1Url: `${baseUrl}/__sources/transition-pic1.png`,
            pic2Key: 'transition-pic2',
            pic2Url: `${baseUrl}/__sources/transition-pic2.png`,
            transitionId: transition.id,
            progresses: [...progresses],
          },
        );
        const absOut = resolve(REPO_ROOT, exp.outputPath);
        encodePngToWebp(decodeDataUrlPng(stripDataUrl), absOut, TRANSITION_STRIP_SPEC.quality);
        const webp = readFileSync(absOut);
        transitionEntries.push({
          id: transition.id,
          safeId: exp.safeId,
          outputPath: exp.outputPath,
          frameCount: TRANSITION_STRIP_SPEC.frameCount,
          frameWidth: TRANSITION_STRIP_SPEC.frameWidth,
          frameHeight: TRANSITION_STRIP_SPEC.frameHeight,
          width: TRANSITION_STRIP_SPEC.frameWidth * TRANSITION_STRIP_SPEC.frameCount,
          height: TRANSITION_STRIP_SPEC.frameHeight,
          bytes: webp.length,
          outputSha256: sha256Hex(webp),
          inputHash: exp.inputHash,
          inputs: exp.inputs,
        });
      }
    } else if (previousManifest?.transitions) {
      transitionEntries.push(...previousManifest.transitions);
    }

    // Every run, partial or full, fails on a page error or console.error from the harness.
    const errors = [...browserErrors];

    // Only an unfiltered run rewrites the manifest, and only after the whole manifest verifies.
    if (!filterPattern) {
      if (!beforeEntry) {
        throw new Error(
          'The manifest has no "before" still yet: run --only=all or --only=effects first',
        );
      }
      const stillsTotalBytes =
        beforeEntry.bytes + effectEntries.reduce((sum, entry) => sum + entry.bytes, 0);
      const transitionsTotalBytes = transitionEntries.reduce((sum, entry) => sum + entry.bytes, 0);
      const maxTransitionBytes = transitionEntries.reduce(
        (max, entry) => Math.max(max, entry.bytes),
        0,
      );
      const manifest = {
        version: 1,
        builderVersion: BUILDER_VERSION,
        crop: PREVIEW_CROP,
        secondSourceEffectIds,
        before: beforeEntry,
        effects: effectEntries,
        transitions: transitionEntries,
        summary: {
          stillsCount: 1 + effectEntries.length,
          stillsTotalBytes,
          transitionsCount: transitionEntries.length,
          transitionsTotalBytes,
          maxTransitionBytes,
          totalBytes: stillsTotalBytes + transitionsTotalBytes,
        },
      };

      const metricsByEffect = inspectEffectStillsMetrics(manifest, REPO_ROOT);
      console.log(
        `Effect 64x48 RGB metrics (minMeanAbsDiff=${PREVIEW_MIN_MEAN_DIFF_FROM_BEFORE}, minStddev=${PREVIEW_MIN_STDDEV}):`,
      );
      for (const entry of effectEntries) {
        const metrics = metricsByEffect.get(entry.id);
        if (metrics) {
          console.log(
            `  ${entry.id.padEnd(22)} meanAbsDiff=${metrics.meanAbsDiff.toFixed(2).padStart(6)} stddev=${metrics.stddev.toFixed(2).padStart(6)} bytes=${entry.bytes}`,
          );
        }
      }

      errors.push(...verifyPreviewManifest(manifest, expected, REPO_ROOT, { verifyPixels: true }));
      console.log('Preview build summary:', JSON.stringify(manifest.summary));
      console.log(
        `Budgets: stills ${stillsTotalBytes} <= ${PREVIEW_SIZE_BUDGETS.maxStillsTotalBytes}, maxTransition ${maxTransitionBytes} <= ${PREVIEW_SIZE_BUDGETS.maxTransitionBytes}, total ${manifest.summary.totalBytes} < ${PREVIEW_SIZE_BUDGETS.maxTotalBytes}`,
      );

      if (errors.length === 0) {
        writeFileSync(existingManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        // Keep the committed manifest in the prettier format that format:check enforces.
        execFileSync(process.execPath, [prettierBin, '--write', existingManifestPath], {
          stdio: 'pipe',
        });
        console.log(`Wrote ${PREVIEW_MANIFEST_PATH}`);
      }
    }

    if (errors.length > 0) {
      console.error('Verification errors:\n' + errors.join('\n'));
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
