import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** How long one look at the app address waits for an answer. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Whether anything answers at the app address: any HTTP response counts, an error page included,
 * since a dev server that answers 500 is running. An https dev server with a certificate of its own
 * answers too: this only asks whether something serves there, and sends nothing but a bare GET. A
 * refused or silent address does not.
 */
export function answers(appUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(appUrl);
    } catch {
      resolve(false);
      return;
    }
    const options = { method: 'GET', timeout: PROBE_TIMEOUT_MS };
    const req =
      url.protocol === 'https:'
        ? httpsRequest(url, { ...options, rejectUnauthorized: false })
        : httpRequest(url, options);
    req.on('response', (res) => {
      res.resume();
      resolve(true);
      req.destroy();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.end();
  });
}
