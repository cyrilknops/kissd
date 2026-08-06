import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// package.json is the single source of the version the sidebar shows.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://localhost:8090',
      '/ws': { target: 'ws://localhost:8090', ws: true },
    },
  },
});
