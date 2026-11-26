import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { serve, type WebSocketServerLike } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { Listener, type ApiBindings } from '../api';
import type { SocketRegistry } from '../devices';

export interface ShareListener {
  readonly port: number;
  close(): Promise<void>;
}

export type ShareListenResult =
  | { readonly ok: true; readonly listener: ShareListener }
  | { readonly ok: false; readonly holder: string | null };

const LSOF_TIMEOUT_MS = 3_000;

/** `"<command> (pid <n>)"` for the process listening on a loopback port, or null when none is found. */
export function lsofHolderOf(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpc'],
      { timeout: LSOF_TIMEOUT_MS, env: { PATH: process.env['PATH'] ?? '' } },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const pid = /^p(\d+)$/m.exec(stdout)?.[1];
        const command = /^c(.+)$/m.exec(stdout)?.[1];
        resolve(pid === undefined || command === undefined ? null : `${command} (pid ${pid})`);
      },
    );
  });
}

/**
 * A second HTTP server on 127.0.0.1 with its own WebSocket server, answering with the same app as the main
 * listener but marked as the share listener, which Tailscale serve fronts.
 */
export async function startShareListener(input: {
  readonly fetch: (req: Request, env: ApiBindings) => Response | Promise<Response>;
  readonly port: number;
  readonly sockets: SocketRegistry;
  readonly holderOf: (port: number) => Promise<string | null>;
}): Promise<ShareListenResult> {
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({
    // The env is marked in place: the server reads back what the upgrade helper writes on this very object.
    fetch: (req, env) => input.fetch(req, Object.assign(env, { listener: Listener.Share })),
    hostname: '127.0.0.1',
    port: input.port,
    // ws declares `options.noServer?: boolean`, which WebSocketServerLike rejects under
    // exactOptionalPropertyTypes; the runtime shape is what @hono/node-server expects.
    websocket: { server: wss as WebSocketServerLike },
  });
  const failure = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server.once('listening', () => {
      resolve(null);
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error);
    });
  });
  if (failure !== null) {
    wss.close();
    if (failure.code === 'EADDRINUSE') {
      return { ok: false, holder: await input.holderOf(input.port) };
    }
    throw failure;
  }
  // A server listening on a TCP port reports an AddressInfo.
  const port = (server.address() as AddressInfo).port;
  return {
    ok: true,
    listener: {
      port,
      async close() {
        input.sockets.closeListener(Listener.Share);
        for (const client of wss.clients) client.terminate();
        wss.close();
        if ('closeAllConnections' in server) server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      },
    },
  };
}
