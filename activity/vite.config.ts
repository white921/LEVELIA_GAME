import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const activityRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDirectory = fileURLToPath(new URL('../activity-dist', import.meta.url));

export default defineConfig({
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
