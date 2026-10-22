import { createServer, type Server } from 'node:net';
import { z } from 'zod';

const Port = z.coerce.number().int().min(1).max(65535);
const PortEnv = z.object({ E2E_DAEMON_PORT: Port.optional(), E2E_UI_PORT: Port.optional() });

export interface E2ePorts {
  readonly daemon: number;
  readonly ui: number;
}

function listenOnFreePort(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

class PortError extends Error {
  override readonly name = 'PortError';
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new PortError('Not a TCP server');
  return address.port;
}

/** Ports the OS reports free; both are held until both are known, so they differ. */
async function freePorts(): Promise<E2ePorts> {
  const [daemon, ui] = await Promise.all([listenOnFreePort(), listenOnFreePort()]);
  const ports = { daemon: portOf(daemon), ui: portOf(ui) };
  await Promise.all([daemon, ui].map((s) => new Promise((resolve) => s.close(resolve))));
  return ports;
}

/**
 * The daemon and UI ports of one E2E run, so parallel gates in separate worktrees never collide.
 * `E2E_DAEMON_PORT` and `E2E_UI_PORT` fix them for debugging; otherwise free ports are chosen. Either
 * way they are written back to `env`: Playwright's workers load the config again and inherit the
 * runner's environment, so they read the same ports instead of choosing new ones.
 */
export async function e2ePorts(env: NodeJS.ProcessEnv): Promise<E2ePorts> {
  // `VAR=` means unset, as it does for the daemon's own environment.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const fixed = PortEnv.parse(present);
  const chosen =
    fixed.E2E_DAEMON_PORT !== undefined && fixed.E2E_UI_PORT !== undefined
      ? { daemon: fixed.E2E_DAEMON_PORT, ui: fixed.E2E_UI_PORT }
      : await freePorts();
  const ports = {
    daemon: fixed.E2E_DAEMON_PORT ?? chosen.daemon,
    ui: fixed.E2E_UI_PORT ?? chosen.ui,
  };
  env['E2E_DAEMON_PORT'] = String(ports.daemon);
  env['E2E_UI_PORT'] = String(ports.ui);
  return ports;
}
