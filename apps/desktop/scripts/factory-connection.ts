import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** The origin the Vite dev server serves the UI from (`vite.config.ts` pins port 1420). */
export const VITE_ORIGIN = 'http://localhost:1420';

/** The fields of the daemon's `daemon.json` this script uses; the daemon writes more. */
const RuntimeInfo = z.object({ port: z.int().min(1).max(65535) });
const UiToken = z.string().trim().min(1);

/** How long each probe of the daemon waits before saying it didn't answer. */
const PROBE_TIMEOUT_MS = 5000;

/** The factory's daemon can't be reached from the dev UI; the message says what to do. */
export class FactoryConnectionError extends Error {
  override readonly name = 'FactoryConnectionError';
}

export interface FactoryConnection {
  readonly url: string;
  readonly token: string;
}

/** The file's text, or null when it doesn't exist; any other failure is a FactoryConnectionError. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
    if (code === 'ENOENT') return null;
    throw new FactoryConnectionError(`Could not read ${path} (${code}).`);
  }
}

/**
 * The port and UI token the running daemon in `dataDir` announced. The token changes every time that
 * daemon starts, so a caller reads it again after a restart.
 */
export function readFactoryConnection(dataDir: string): FactoryConnection {
  const infoPath = join(dataDir, 'daemon.json');
  const infoText = readText(infoPath);
  if (infoText === null)
    throw new FactoryConnectionError(
      `10db isn't running: there is no daemon.json in ${dataDir}. Open 10db, then run this again.`,
    );
  let info: z.infer<typeof RuntimeInfo>;
  try {
    info = RuntimeInfo.parse(JSON.parse(infoText));
  } catch {
    throw new FactoryConnectionError(`${infoPath} is not the daemon's runtime file.`);
  }
  const tokenPath = join(dataDir, 'ui-token');
  // The token is a credential: no message carries it.
  const token = UiToken.safeParse(readText(tokenPath) ?? '');
  if (!token.success) throw new FactoryConnectionError(`${tokenPath} is missing or empty.`);
  return { url: `http://127.0.0.1:${String(info.port)}`, token: token.data };
}

async function probe(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new FactoryConnectionError(
        `10db's daemon at ${url} didn't answer within ${String(timeoutMs / 1000)} s. If 10db is still starting, wait and run this again; otherwise quit and reopen 10db.`,
      );
    throw new FactoryConnectionError(
      `10db's daemon isn't answering at ${url}. Open 10db, then run this again.`,
    );
  }
}

/**
 * Resolves when the daemon answers `origin` in its CORS header, which it does only when the builder
 * opted that origin in with `TENDB_DEV_UI_ORIGIN`, and takes the token, so a stale or wrong token is
 * one clear refusal here rather than a page of 401s in the UI.
 */
export async function checkFactoryConnection(
  connection: FactoryConnection,
  origin: string,
  { timeoutMs = PROBE_TIMEOUT_MS }: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const health = await probe(
    `${connection.url}/health`,
    { headers: { Origin: origin } },
    timeoutMs,
  );
  if (health.headers.get('access-control-allow-origin') !== origin)
    throw new FactoryConnectionError(
      [
        `10db's daemon refuses the dev UI (${origin}). To turn it on:`,
        '  1. pnpm dev:factory:enable',
        '  2. Quit 10db (⌘Q) and open it again. Quitting stops running work, so pick your moment.',
        'Then run pnpm dev:factory again.',
      ].join('\n'),
    );
  const projects = await probe(
    `${connection.url}/projects`,
    { headers: { Origin: origin, Authorization: `Bearer ${connection.token}` } },
    timeoutMs,
  );
  if (projects.status === 401)
    throw new FactoryConnectionError(
      "10db's daemon refused the token in ui-token. 10db probably restarted while this was starting: run pnpm dev:factory again.",
    );
  if (!projects.ok)
    throw new FactoryConnectionError(
      `10db's daemon answered ${String(projects.status)} to GET /projects. Quit and reopen 10db, then run this again.`,
    );
}
