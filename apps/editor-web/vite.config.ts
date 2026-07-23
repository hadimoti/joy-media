import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@joy-media/workflow-engine': '/opt/joy-media/repo/packages/workflow-engine/dist/index.js',
      '@joy-media/plugin-sdk/browser': '/opt/joy-media/repo/packages/plugin-sdk/dist/browser.js',
      '@joy-media/plugin-sdk': '/opt/joy-media/repo/packages/plugin-sdk/dist/index.js',
      '@joy-media/audio-core/normalize': '/opt/joy-media/repo/packages/audio-core/dist/normalization.js',
      '@joy-media/audio-core/analysis': '/opt/joy-media/repo/packages/audio-core/dist/analysis.js',
      '@joy-media/audio-core/effects': '/opt/joy-media/repo/packages/audio-core/dist/effects.js',
      '@joy-media/html-scene-runtime/browser':
        '/opt/joy-media/repo/packages/html-scene-runtime/src/browser-preview.ts',
      '@joy-media/html-scene-runtime/first-party':
        '/opt/joy-media/repo/packages/html-scene-runtime/src/first-party.ts',
    },
  },
});
