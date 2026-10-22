import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const WebServer = z.object({
  command: z.string(),
  url: z.string(),
  env: z.record(z.string(), z.string()),
});
const LoadedConfig = z.object({
  use: z.object({ baseURL: z.string() }),
  webServer: z.tuple([WebServer, WebServer]),
});
type LoadedConfig = z.infer<typeof LoadedConfig>;

/** Loads the Playwright config as a fresh module, the way each Playwright process does. */
async function loadConfig(): Promise<LoadedConfig> {
  vi.resetModules();
  const loaded: unknown = (await import('./playwright.config')).default;
  return LoadedConfig.parse(loaded);
}

function listen(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function isFree(port: number): Promise<boolean> {
  const server = await listen(port);
  if (!server) return false;
  await close(server);
  return true;
}

function portsOf(config: LoadedConfig): { daemon: number; ui: number } {
  return {
    daemon: Number(config.webServer[0].env['TENDB_PORT']),
    ui: Number(new URL(config.use.baseURL).port),
  };
}

const held: Server[] = [];
beforeEach(() => {
  vi.stubEnv('E2E_DAEMON_PORT', undefined);
  vi.stubEnv('E2E_UI_PORT', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(held.splice(0).map(close));
});

describe('the E2E Playwright config', () => {
  it('serves the daemon and the UI on free ports when the default ports are taken', async () => {
    // Another worktree's gate, or `pnpm dev`, may hold these already; either way they are not free.
    for (const port of [4318, 1420]) {
      const server = await listen(port);
      if (server) held.push(server);
    }
    const { daemon, ui } = portsOf(await loadConfig());
    expect(daemon).not.toBe(ui);
    expect(await isFree(daemon)).toBe(true);
    expect(await isFree(ui)).toBe(true);
  });

  it('points every daemon and UI reference at the chosen ports', async () => {
    const config = await loadConfig();
    const { daemon, ui } = portsOf(config);
    const [daemonServer, uiServer] = config.webServer;
    const daemonUrl = `http://127.0.0.1:${String(daemon)}`;
    expect(config.use.baseURL).toBe(`http://localhost:${String(ui)}`);
    expect(daemonServer.url).toBe(`${daemonUrl}/health`);
    expect(daemonServer.env['TENDB_DEV_UI_ORIGIN']).toBe(config.use.baseURL);
    expect(uiServer.command).toContain(`--port ${String(ui)} --strictPort`);
    expect(uiServer.url).toBe(config.use.baseURL);
    expect(uiServer.env['VITE_DAEMON_URL']).toBe(daemonUrl);
  });

  it('publishes the chosen ports, so the workers that load it again get the same ones', async () => {
    const first = portsOf(await loadConfig());
    expect(process.env['E2E_DAEMON_PORT']).toBe(String(first.daemon));
    expect(process.env['E2E_UI_PORT']).toBe(String(first.ui));
    expect(portsOf(await loadConfig())).toEqual(first);
  });

  it('takes fixed ports from E2E_DAEMON_PORT and E2E_UI_PORT for debugging', async () => {
    vi.stubEnv('E2E_DAEMON_PORT', '45318');
    vi.stubEnv('E2E_UI_PORT', '41420');
    expect(portsOf(await loadConfig())).toEqual({ daemon: 45318, ui: 41420 });
  });

  it('rejects a port override that is not a port', async () => {
    vi.stubEnv('E2E_UI_PORT', 'not-a-port');
    await expect(loadConfig()).rejects.toThrow('E2E_UI_PORT');
  });
});
