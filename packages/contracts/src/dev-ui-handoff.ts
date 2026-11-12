import { z } from 'zod';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: Open Page hands 10db's own dev UI
// the daemon's connection in the URL's fragment, which a browser never sends to a server, so the
// dev server 10db runs under the gate's sandbox never holds the UI token. The pictures browser hands
// it the same way (decision 2026-11-12-the-pictures-browser-reads-the-daemon-for-10dbs-own-ui).

export const DEV_UI_HANDOFF_KEY = 'tendb';

/** What a fragment carries: the daemon's address and a token for it. */
export const DevUiHandOff = z.object({ url: z.url(), token: z.string().min(1) });
export type DevUiHandOff = z.infer<typeof DevUiHandOff>;

/**
 * The page's address with the daemon's connection in its fragment when the page is at the dev UI
 * origin the daemon trusts; any other page's address as it is.
 */
export function handOffTo(
  pageUrl: string,
  devUiOrigin: string | null,
  connection: DevUiHandOff,
): string {
  if (devUiOrigin === null) return pageUrl;
  const page = new URL(pageUrl);
  if (page.origin !== devUiOrigin) return pageUrl;
  page.hash = `${DEV_UI_HANDOFF_KEY}=${encodeURIComponent(JSON.stringify({ url: connection.url, token: connection.token }))}`;
  return page.href;
}

/** The connection a page's fragment hands over, or null when it carries none. */
export function takenHandOff(hash: string): DevUiHandOff | null {
  const prefix = `#${DEV_UI_HANDOFF_KEY}=`;
  if (!hash.startsWith(prefix)) return null;
  try {
    const parsed = DevUiHandOff.safeParse(
      JSON.parse(decodeURIComponent(hash.slice(prefix.length))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
