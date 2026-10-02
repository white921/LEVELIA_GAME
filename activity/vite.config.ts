import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const activityRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDirectory = fileURLToPath(new URL('../activity-dist', import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: activityRoot,
  base: './',
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
