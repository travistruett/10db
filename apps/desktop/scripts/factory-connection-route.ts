import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FactoryConnectionError,
  readFactoryConnection,
  VITE_ORIGIN,
} from './factory-connection.ts';
import { FACTORY_CONNECTION_PATH } from './factory-vite.ts';

/**
 * The dev server's answer to `GET /__tendb/factory-connection`: the factory daemon's address and token, read from
 * `dataDir` on every request, so a restarted 10db (a new token, maybe a new port) is followed without restarting
 * Vite. Only a browser's same-origin fetch to the dev server's own host is answered: the Host check stops a page that
 * rebinds its own name to 127.0.0.1 (this runs before Vite's own host check), and `Sec-Fetch-Site` another origin's
 * page. A 503 means 10db is between runs, and the page asks again.
 */
export function factoryConnectionRoute(
  dataDir: string,
  origin: string = VITE_ORIGIN,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const host = new URL(origin).host;
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
    if (
      req.method !== 'GET' ||
      req.headers.host !== host ||
      req.headers['sec-fetch-site'] !== 'same-origin'
    ) {
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
