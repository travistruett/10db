import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { IMG_SRC_DIRECTIVE } from './window-csp.ts';

// The browser modes get the window's img-src policy (window-csp.ts).
const pageHeaders = { 'Content-Security-Policy': IMG_SRC_DIRECTIVE };

// The dev server answers an address under /app/ with the served app's page, as the daemon does on the share
// listener, so `pnpm dev` shows the phone's screens at http://localhost:1420/app/inbox. An address with a file
// extension is left to Vite.
const servedAppInDev: Plugin = {
  name: 'tendb-served-app-in-dev',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = req.url?.split('?')[0] ?? '';
      if ((path === '/app' || path.startsWith('/app/')) && !/\.[a-z0-9]+$/i.test(path)) {
        req.url = '/app.html';
      }
      next();
    });
  },
};

// Tauri expects a fixed dev port and serves the build from ../dist.
export default defineConfig({
  plugins: [
    react(),
    // Babel targets what the build targets. Named here, it also never looks for a browserslist
    // config above the checkout, where a sandbox refuses even a stat.
    babel({ presets: [reactCompilerPreset()], targets: { safari: '18' } }),
    servedAppInDev,
  ],
  clearScreen: false,
  server: { port: 1420, strictPort: true, headers: pageHeaders },
  preview: { headers: pageHeaders },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari18', sourcemap: true },
});
