import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { DEFAULT_BOOK, DESKTOP_DIR, E2E_DATA, E2E_TOKEN } from './paths';
import { e2ePorts } from './ports';

const ports = await e2ePorts(process.env);
const daemonUrl = `http://127.0.0.1:${String(ports.daemon)}`;
const uiUrl = `http://localhost:${String(ports.ui)}`;
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
      // SIGTERM lets the daemon run its shutdown, which stops a gate's process group.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: {
        // Playwright merges the caller's environment in; blank values are dropped by the daemon's env
        // parser, so nothing from the caller's shell reaches the E2E daemon.
        TENDB_PARENT_STDIN: '',
        TENDB_SQLITE_BINDING: '',
        TENDB_CLAUDE_PATH: '',
        TENDB_LIVE_CLAUDE: '',
        TENDB_DATA_DIR: E2E_DATA,
        TENDB_PORT: String(ports.daemon),
        TENDB_FAKE_SCRIPTS: book,
        TENDB_DEV_UI_TOKEN: E2E_TOKEN,
        TENDB_DEV_UI_ORIGIN: uiUrl,
        TENDB_LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm vite --port ${String(ports.ui)} --strictPort`,
      cwd: DESKTOP_DIR,
      url: uiUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: { VITE_DAEMON_URL: daemonUrl, VITE_DAEMON_TOKEN: E2E_TOKEN },
    },
  ],
});
