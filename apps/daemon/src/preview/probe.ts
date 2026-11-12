import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** How long one look at the app address waits for an answer. */
const PROBE_TIMEOUT_MS = 1_000;

/** Node's errors for a TLS server whose certificate isn't trusted: a server answered all the same. */
const UNTRUSTED_CERTIFICATE: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Whether anything answers at the app address: any HTTP response counts, an error page included,
 * since a dev server that answers 500 is running. An https dev server with a certificate of its own
 * answers too: certificates are still checked, and a handshake refused only for the certificate
 * means a TLS server is there. A refused or silent address does not.
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
    const req = url.protocol === 'https:' ? httpsRequest(url, options) : httpRequest(url, options);
    req.on('response', (res) => {
      res.resume();
      resolve(true);
      req.destroy();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== undefined && UNTRUSTED_CERTIFICATE.has(error.code));
    });
    req.end();
  });
}
