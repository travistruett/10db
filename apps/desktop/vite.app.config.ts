import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The phone's served app (`pnpm --filter @10db/desktop build:app`): the page app.html and its entry src/served/,
// built under /app/ into dist-app/, which the daemon serves on the share listener.
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()], targets: { safari: '18' } })],
  clearScreen: false,
  base: '/app/',
  publicDir: 'served-public',
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'safari18',
    outDir: 'dist-app',
    emptyOutDir: true,
    rolldownOptions: { input: resolve(import.meta.dirname, 'app.html') },
  },
});
