import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { connect, createServer as createTcpServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * What `tailscale serve --https=<port>` does for a phone, in the e2e: an HTTPS listener with a self-signed
 * certificate that forwards to the daemon's share listener on loopback. The browser reaches `<fqdn>:<port of
 * this proxy>`, while the daemon's lists name `<fqdn>:<share port>`, so the proxy sends the Host and Origin the
 * daemon expects (serve forwards what the client sent, with the tailnet's own port). The share listener sees
 * 127.0.0.1 as its peer, as it does behind serve.
 */
export interface TlsStandIn {
  /** The port the browser connects to. */
  readonly port: number;
  close(): Promise<void>;
}

function selfSigned(dir: string): { key: Buffer; cert: Buffer } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=e2e',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (error) {
    // openssl's own words, which say whether it is missing or refused an option.
    rmSync(dir, { recursive: true, force: true });
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    throw new StandInError(`openssl could not make the stand-in's certificate: ${stderr}`);
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

class StandInError extends Error {
  override readonly name = 'StandInError';
}

function portOf(address: string | { port: number } | null): number {
  if (address === null || typeof address === 'string') throw new StandInError('Not listening');
  return address.port;
}

export async function startTlsStandIn(target: {
  readonly fqdn: string;
  readonly sharePort: number;
  readonly login: string;
}): Promise<TlsStandIn> {
  const dir = mkdtempSync(join(tmpdir(), 'tendb-e2e-tls-'));
  const host = `${target.fqdn}:${String(target.sharePort)}`;
  const forwarded = (headers: IncomingHttpHeaders): IncomingHttpHeaders => ({
    ...headers,
    host,
    ...(headers.origin === undefined ? {} : { origin: `https://${host}` }),
    'tailscale-user-login': target.login,
  });
  const server = createServer(selfSigned(dir), (req, res) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target.sharePort,
        method: req.method,
        path: req.url,
        headers: forwarded(req.headers),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on('error', () => res.destroy());
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  // The event stream: forward the upgrade by hand with the same headers.
  // The event streams it forwards: closing the proxy ends them too, which `closeAllConnections` does not.
  const upgraded = new Set<Duplex>();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const upstream = connect(target.sharePort, '127.0.0.1', () => {
      const headers = forwarded(req.headers);
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        value === undefined ? [] : [`${name}: ${Array.isArray(value) ? value.join(', ') : value}`],
      );
      upstream.write(
        `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`,
      );
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: portOf(server.address()),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        for (const socket of upgraded) socket.destroy();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/** A port nothing holds right now, for the share listener (the daemon binds it when sharing starts). */
export async function freeLoopbackPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = portOf(probe.address());
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
