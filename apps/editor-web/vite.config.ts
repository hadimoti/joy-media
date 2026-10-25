import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Aliases for workspace entry points vite cannot resolve on its own — either a
 * subpath export the bundler does not follow, or a source file consumed
 * directly.
 *
 * These used to be absolute `/opt/joy-media/repo/...` paths, which pinned the
 * build to the VPS checkout: `pnpm dev` and `pnpm build` failed in any other
 * clone. They resolve from this file now, so the editor builds anywhere.
 */
const pkg = (relative: string): string =>
  fileURLToPath(new URL(`../../packages/${relative}`, import.meta.url));

// Dockview imports react-dom as an undeclared optional peer. pnpm's strict
// linker therefore does not place it beside Dockview's package, even though
// the editor declares react-dom directly. Resolve it from this app's manifest
// so clean Windows and Linux installs produce the same deterministic bundle.
const editorDependency = (name: string): string =>
  fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

const CHUNK_BUDGET_KIB = 640;
const FONT_ASSET_URL = '/packages/html-scene-runtime/assets/fonts/';
const FONT_ASSET_ROOT = fileURLToPath(
  new URL('../../packages/html-scene-runtime/assets/fonts/', import.meta.url),
);
const FONT_ASSET_FILES = [
  'noto-sans-arabic/noto-sans-arabic-arabic-400-normal.woff2',
  'noto-sans-arabic/noto-sans-arabic-arabic-700-normal.woff2',
  'noto-sans-arabic/noto-sans-arabic-latin-400-normal.woff2',
  'noto-sans-arabic/noto-sans-arabic-latin-700-normal.woff2',
  'noto-sans-arabic/manifest.json',
  'noto-sans-arabic/LICENSE-OFL.txt',
];

function p0FontAssets(): Plugin {
  const fontFileForRequest = (url: string | undefined): string | undefined => {
    if (!url?.startsWith(FONT_ASSET_URL)) return undefined;
    const assetName = url.slice(FONT_ASSET_URL.length).split('?')[0];
    return FONT_ASSET_FILES.includes(assetName) ? resolve(FONT_ASSET_ROOT, assetName) : undefined;
  };
  const serveFont = (
    request: { url?: string },
    response: {
      statusCode: number;
      setHeader(name: string, value: string): void;
      end(data?: Uint8Array | string): void;
    },
    next: () => void,
  ): void => {
    const path = fontFileForRequest(request.url);
    if (!path) {
      next();
      return;
    }
    try {
      const bytes = readFileSync(path);
      response.statusCode = 200;
      response.setHeader(
        'Content-Type',
        path.endsWith('.woff2')
          ? 'font/woff2'
          : path.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8',
      );
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.end(bytes);
    } catch {
      response.statusCode = 404;
      response.end('Not found');
    }
  };

  return {
    name: 'joy-p0-font-assets',
    configureServer(server) {
      server.middlewares.use(serveFont);
    },
    generateBundle() {
      for (const assetName of FONT_ASSET_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `packages/html-scene-runtime/assets/fonts/${assetName}`,
          source: readFileSync(resolve(FONT_ASSET_ROOT, assetName)),
        });
      }
    },
  };
}

function editorChunk(id: string): string | undefined {
  const moduleId = id.replaceAll('\\', '/');
  if (moduleId.includes('/node_modules/three/examples/')) return 'three-addons';
  if (moduleId.includes('/node_modules/three/')) return 'three-core';
  if (moduleId.includes('/node_modules/react') || moduleId.includes('/node_modules/scheduler/')) {
    return 'react';
  }
  if (moduleId.includes('/node_modules/dockview/')) return 'dockview';
  if (
    moduleId.includes('/node_modules/pixi.js/') ||
    moduleId.includes('/node_modules/earcut/') ||
    moduleId.includes('/node_modules/eventemitter3/')
  ) {
    return 'pixi';
  }

  // The timeline is a self-contained Dockview panel with its own interaction
  // and editing-command surface. Keeping it independently cacheable avoids
  // making every editor-shell release invalidate the main entry chunk.
  if (moduleId.includes('/apps/editor-web/src/TimelinePanel')) return 'joy-timeline';

  // Keep the large Dockview panel implementations out of the application
  // bootstrap. They are still eagerly available to the shell, but their code
  // is fetched as one independently cacheable panel bundle instead of pushing
  // the entry chunk over the release budget whenever a panel grows.
  if (
    [
      'InspectorPanel',
      'AssetLibraryPanel',
      'AudioPanel',
      'MotionPanel',
      'AgentPanel',
      'ColorPanel',
    ].some((panel) => moduleId.includes(`/apps/editor-web/src/${panel}`))
  )
    return 'joy-panels-core';
  if (
    [
      'JobsPanel',
      'CaptionsPanel',
      'DualLensPanel',
      'MaskInspector',
      'TextPanel',
      'ProjectLibrary',
    ].some((panel) => moduleId.includes(`/apps/editor-web/src/${panel}`))
  )
    return 'joy-panels-media';

  const packageMatch = moduleId.match(/\/packages\/([^/]+)\//);
  const packageName = packageMatch?.[1];
  if (packageName === undefined) return undefined;
  // Render IR is consumed by both playback/editing and the renderers. Keeping
  // it in the renderer chunk creates a rendering -> editing -> rendering
  // Rollup cycle once visual-object-renderer imports the evaluator.
  if (packageName === 'render-ir') return 'joy-render-contract';
  if (
    [
      'renderer-headless',
      'renderer-pixi',
      'transition-shaders',
      'visual-effects',
      'visual-object-renderer',
    ].includes(packageName)
  ) {
    return 'joy-rendering';
  }
  if (
    [
      'audio-core',
      'camera-core',
      'captions-core',
      'commands',
      'evaluator',
      'motion-core',
      'playback-engine',
      'property-system',
      'timeline-engine',
    ].includes(packageName)
  ) {
    return 'joy-editing';
  }
  if (packageName === 'html-scene-runtime') return 'joy-scenes';
  if (packageName === 'agent-tools' || packageName === 'workflow-engine') {
    return 'joy-automation';
  }
  return 'joy-platform';
}

function bundlePolicy(): Plugin {
  return {
    name: 'joy-bundle-policy',
    generateBundle(_options, bundle) {
      const oversized: string[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const outputBytes = Buffer.byteLength(output.code);
        if (outputBytes > CHUNK_BUDGET_KIB * 1024) {
          oversized.push(`${output.fileName} (${(outputBytes / 1024).toFixed(1)} KiB)`);
        }
        if (process.env.JOY_BUNDLE_ANALYZE !== '1') continue;
        const modules = Object.entries(output.modules)
          .map(([id, details]) => ({ id, bytes: details.renderedLength }))
          .sort((left, right) => right.bytes - left.bytes)
          .slice(0, 15);
        this.info(
          `${output.fileName} (${outputBytes} bytes)\n${modules
            .map(({ id, bytes }) => `  ${bytes.toString().padStart(8)} ${id}`)
            .join('\n')}`,
        );
      }
      if (oversized.length > 0) {
        this.error(
          `Editor chunks exceed the ${CHUNK_BUDGET_KIB} KiB budget:\n${oversized
            .map((chunk) => `  - ${chunk}`)
            .join('\n')}`,
        );
      }
    },
  };
}

const apiProxy = {
  '/api': {
    target: process.env.JOY_MEDIA_E2E_API_URL ?? 'http://127.0.0.1:4174',
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react(), bundlePolicy(), p0FontAssets()],
  server: { proxy: apiProxy },
  // `vite preview` serves the production `dist/` for the prod-build smoke lane;
  // it needs the same `/api` proxy the dev server has so the shipped bundle can
  // talk to the isolated e2e API server.
  preview: { proxy: apiProxy },
  resolve: {
    alias: {
      'react-dom': editorDependency('react-dom'),
      '@joy-media/workflow-engine': pkg('workflow-engine/dist/index.js'),
      '@joy-media/plugin-sdk/browser': pkg('plugin-sdk/dist/browser.js'),
      '@joy-media/plugin-sdk': pkg('plugin-sdk/dist/index.js'),
      '@joy-media/audio-core/normalize': pkg('audio-core/dist/normalization.js'),
      '@joy-media/audio-core/analysis': pkg('audio-core/dist/analysis.js'),
      '@joy-media/audio-core/effects': pkg('audio-core/dist/effects.js'),
      '@joy-media/html-scene-runtime/browser': pkg('html-scene-runtime/src/browser-preview.ts'),
      '@joy-media/html-scene-runtime/first-party': pkg('html-scene-runtime/src/first-party.ts'),
      '@joy-media/media-core/observation': pkg('media-core/src/observation.ts'),
    },
  },
  build: {
    chunkSizeWarningLimit: CHUNK_BUDGET_KIB,
    rollupOptions: {
      output: {
        /**
         * Split stable vendor modules into separately-cached chunks (JOY-009):
         * the app shipped as one ~2.4 MB `index` bundle. Separating React,
         * dockview, and three.js means an app-only release reuses the cached
         * vendor files and the 3D viewer's heavy three.js payload only loads
         * when that panel mounts. Build-only; no runtime coupling introduced.
         */
        manualChunks: editorChunk,
      },
    },
  },
});
