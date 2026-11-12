// A dev login's address carries a token that signs a browser in. What the pictures browser loads or
// refuses is named in logs and in status lines by origin and path only, never by its query.

/** An address as a log may name it: origin and path, or the `host:port` of a tunnel; never a query. */
export function addressForLog(raw: string): string {
  if (raw.startsWith('/')) return raw.split(/[?#]/, 1)[0] ?? '/';
  if (/^[^/?#@\s]+:\d+$/.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '(not an address)';
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return url.protocol;
  const origin = url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
  return `${origin}${url.pathname}`;
}

/**
 * Why a page did not load, in words of 10db's own: Playwright's message names the address, token and
 * all, so only a network error's code is kept from it.
 */
export function loadFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = /\bnet::ERR_[A-Z0-9_]+/.exec(text)?.[0];
  if (code !== undefined) return code;
  if (/Timeout \d+ms exceeded/.test(text)) return 'the page took longer than 30 s to load';
  return 'the page did not load';
}
