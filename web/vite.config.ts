import { writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    // dist/ is emptied on every build; keep its placeholder, so a fresh clone's Go build always has something to embed
    { name: 'keep-dist', closeBundle: () => writeFileSync('dist/.gitkeep', '') },
  ],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
});
