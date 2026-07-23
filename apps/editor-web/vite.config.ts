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
    },
  },
});
