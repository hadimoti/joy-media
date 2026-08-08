import { fileURLToPath } from 'node:url';
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

const CHUNK_BUDGET_KIB = 640;

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

  const packageMatch = moduleId.match(/\/packages\/([^/]+)\//);
  const packageName = packageMatch?.[1];
  if (packageName === undefined) return undefined;
  if (
    [
      'render-ir',
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

export default defineConfig({
  plugins: [react(), bundlePolicy()],
  resolve: {
    alias: {
      '@joy-media/workflow-engine': pkg('workflow-engine/dist/index.js'),
      '@joy-media/plugin-sdk/browser': pkg('plugin-sdk/dist/browser.js'),
      '@joy-media/plugin-sdk': pkg('plugin-sdk/dist/index.js'),
      '@joy-media/audio-core/normalize': pkg('audio-core/dist/normalization.js'),
      '@joy-media/audio-core/analysis': pkg('audio-core/dist/analysis.js'),
      '@joy-media/audio-core/effects': pkg('audio-core/dist/effects.js'),
      '@joy-media/html-scene-runtime/browser': pkg('html-scene-runtime/src/browser-preview.ts'),
      '@joy-media/html-scene-runtime/first-party': pkg('html-scene-runtime/src/first-party.ts'),
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
