import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@joy-media/workflow-engine': '/opt/joy-media/repo/packages/workflow-engine/dist/index.js',
    },
  },
});