import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
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

export default defineConfig({
  plugins: [react()],
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
    rollupOptions: {
      output: {
        /**
         * Split stable vendor modules into separately-cached chunks (JOY-009):
         * the app shipped as one ~2.4 MB `index` bundle. Separating React,
         * dockview, and three.js means an app-only release reuses the cached
         * vendor files and the 3D viewer's heavy three.js payload only loads
         * when that panel mounts. Build-only; no runtime coupling introduced.
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
          dockview: ['dockview'],
          three: [
            'three',
            'three/examples/jsm/controls/OrbitControls.js',
            'three/examples/jsm/loaders/GLTFLoader.js',
          ],
        },
      },
    },
  },
});
