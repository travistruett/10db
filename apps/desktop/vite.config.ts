import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { IMG_SRC_DIRECTIVE } from './window-csp.ts';

// The browser modes get the window's img-src policy (window-csp.ts).
const pageHeaders = { 'Content-Security-Policy': IMG_SRC_DIRECTIVE };

// Tauri expects a fixed dev port and serves the build from ../dist.
export default defineConfig({
  plugins: [
    react(),
    // Babel targets what the build targets. Named here, it also never looks for a browserslist
    // config above the checkout, where a sandbox refuses even a stat.
    babel({ presets: [reactCompilerPreset()], targets: { safari: '18' } }),
  ],
  clearScreen: false,
  server: { port: 1420, strictPort: true, headers: pageHeaders },
  preview: { headers: pageHeaders },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari18', sourcemap: true },
});
