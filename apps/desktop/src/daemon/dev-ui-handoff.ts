import { z } from 'zod';
import type { DaemonConnection } from './connection';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: Open Page hands 10db's own dev UI
// the daemon's connection in the URL's fragment, which a browser never sends to a server, so the
// dev server 10db runs under the gate's sandbox never holds the UI token.

const KEY = 'tendb';

/** What a fragment carries: the daemon's address and UI token. */
const HandOff = z.object({ url: z.url(), token: z.string().min(1) });

/**
 * The page's address with the daemon's connection in its fragment when the page is at the dev UI
 * origin the daemon trusts; any other page's address as it is.
 */
export function handOffTo(
  pageUrl: string,
  devUiOrigin: string | null,
  connection: Pick<DaemonConnection, 'url' | 'token'>,
): string {
  if (devUiOrigin === null) return pageUrl;
  const page = new URL(pageUrl);
  if (page.origin !== devUiOrigin) return pageUrl;
  page.hash = `${KEY}=${encodeURIComponent(JSON.stringify({ url: connection.url, token: connection.token }))}`;
  return page.href;
}

/** The connection a page's fragment hands over, or null when it carries none. */
export function takenHandOff(hash: string): DaemonConnection | null {
  const prefix = `#${KEY}=`;
  if (!hash.startsWith(prefix)) return null;
  try {
    const parsed = HandOff.safeParse(JSON.parse(decodeURIComponent(hash.slice(prefix.length))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
