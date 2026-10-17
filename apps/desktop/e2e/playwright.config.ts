import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  DEFAULT_BOOK,
  DESKTOP_DIR,
  E2E_DAEMON_PORT,
  E2E_DATA,
  E2E_TOKEN,
  E2E_UI_PORT,
} from './paths';

const daemonUrl = `http://127.0.0.1:${String(E2E_DAEMON_PORT)}`;
const uiUrl = `http://localhost:${String(E2E_UI_PORT)}`;
// The red-first run points this at a script book whose session crashes.
const book = process.env['E2E_BOOK'] ?? DEFAULT_BOOK;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: resolve(DESKTOP_DIR, 'test-results'),
  use: { baseURL: uiUrl, colorScheme: 'dark', trace: 'retain-on-failure' },
  // WebKit, because the shipped app renders in WKWebView.
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
  webServer: [
    {
      command: 'pnpm --filter @10db/daemon exec tsx src/main.ts',
      url: `${daemonUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        TENDB_DATA_DIR: E2E_DATA,
        TENDB_PORT: String(E2E_DAEMON_PORT),
        TENDB_FAKE_SCRIPTS: book,
        TENDB_DEV_UI_TOKEN: E2E_TOKEN,
        TENDB_LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm vite --port ${String(E2E_UI_PORT)} --strictPort`,
      cwd: DESKTOP_DIR,
      url: uiUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_DAEMON_URL: daemonUrl, VITE_DAEMON_TOKEN: E2E_TOKEN },
    },
  ],
});
