import type { IncomingMessage, ServerResponse } from 'node:http';
import { FactoryConnectionError, readFactoryConnection } from './factory-connection';
import { FACTORY_CONNECTION_PATH } from './factory-vite';

/**
 * The dev server's answer to `GET /__tendb/factory-connection`: the factory daemon's address and token, read from
 * `dataDir` on every request, so a restarted 10db (a new token, maybe a new port) is followed without restarting
 * Vite. Only a same-origin fetch is answered; with Vite's CORS off no other origin can read it either. A 503 means
 * 10db is between runs, and the page asks again.
 */
export function factoryConnectionRoute(
  dataDir: string,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    if (req.url?.split('?')[0] !== FACTORY_CONNECTION_PATH) {
      next();
      return;
    }
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' || (site !== undefined && site !== 'same-origin')) {
      reply(403, { error: 'forbidden' });
      return;
    }
    try {
      reply(200, readFactoryConnection(dataDir));
    } catch (error) {
      if (!(error instanceof FactoryConnectionError)) throw error;
      reply(503, { error: error.message });
    }
  };
}
