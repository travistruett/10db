import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** The origin the Vite dev server serves the UI from (`vite.config.ts` pins port 1420). */
export const VITE_ORIGIN = 'http://localhost:1420';

/** The fields of the daemon's `daemon.json` this script uses; the daemon writes more. */
const RuntimeInfo = z.object({ port: z.int().min(1).max(65535) });

/** The factory's daemon can't be reached from the dev UI; the message says what to do. */
export class FactoryConnectionError extends Error {
  override readonly name = 'FactoryConnectionError';
}

export interface FactoryConnection {
  readonly url: string;
  readonly token: string;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The port and UI token the running daemon in `dataDir` announced. The token changes every time that
 * daemon starts, so a caller reads it again after a restart.
 */
export function readFactoryConnection(dataDir: string): FactoryConnection {
  const infoText = readText(join(dataDir, 'daemon.json'));
  if (infoText === null)
    throw new FactoryConnectionError(
      `10db isn't running: there is no daemon.json in ${dataDir}. Open 10db, then run this again.`,
    );
  let info: z.infer<typeof RuntimeInfo>;
  try {
    info = RuntimeInfo.parse(JSON.parse(infoText));
  } catch {
    throw new FactoryConnectionError(
      `${join(dataDir, 'daemon.json')} is not the daemon's runtime file.`,
    );
  }
  const token = readText(join(dataDir, 'ui-token'))?.trim() ?? '';
  // The token is a credential: no message carries it.
  if (token === '')
    throw new FactoryConnectionError(`${join(dataDir, 'ui-token')} is missing or empty.`);
  return { url: `http://127.0.0.1:${String(info.port)}`, token };
}

/**
 * Resolves when the daemon at `url` answers `origin` in its CORS header, which it does only when the
 * builder opted that origin in with `TENDB_DEV_UI_ORIGIN`.
 */
export async function checkFactoryAcceptsOrigin(url: string, origin: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { headers: { Origin: origin } });
  } catch {
    throw new FactoryConnectionError(
      `10db's daemon isn't answering at ${url}. Open 10db, then run this again.`,
    );
  }
  await response.body?.cancel();
  if (response.headers.get('access-control-allow-origin') === origin) return;
  throw new FactoryConnectionError(
    [
      `10db's daemon refuses the dev UI (${origin}). To turn it on:`,
      '  1. pnpm dev:factory:enable',
      '  2. Quit 10db (⌘Q) and open it again. Quitting stops running work, so pick your moment.',
      'Then run pnpm dev:factory again.',
    ].join('\n'),
  );
}
