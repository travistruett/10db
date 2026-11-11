import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackProbe } from './loopback-probe';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A loopback server that answers each request with `answer`; its origin and the paths it was asked. */
async function serve(
  answer: (res: ServerResponse) => void,
): Promise<{ origin: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    answer(res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, asked };
}

describe('loopbackProbe', () => {
  const probe = loopbackProbe(500);

  it('is true for a server that answers, whatever its status', async () => {
    const { origin, asked } = await serve((res) => {
      res.writeHead(500).end();
    });
    await expect(probe(origin)).resolves.toBe(true);
    expect(asked).toEqual(['/']);
  });

  it('does not follow a redirect', async () => {
    const next = await serve((res) => res.writeHead(200).end());
    const { origin } = await serve((res) => {
      res.writeHead(302, { location: `${next.origin}/elsewhere` }).end();
    });
    await expect(probe(origin)).resolves.toBe(true);
    expect(next.asked).toEqual([]);
  });

  it('is false where nothing listens', async () => {
    const { origin } = await serve((res) => res.end());
    await new Promise<void>((resolve) => {
      const server = servers.pop();
      server?.close(() => {
        resolve();
      });
    });
    await expect(probe(origin)).resolves.toBe(false);
  });

  it('is false for a server that never answers, at the bound', async () => {
    const { origin } = await serve(() => undefined);
    await expect(probe(origin)).resolves.toBe(false);
  });

  it('is false for an address off this Mac, without asking it', async () => {
    await expect(probe('http://192.0.2.1:80')).resolves.toBe(false);
  });
});
