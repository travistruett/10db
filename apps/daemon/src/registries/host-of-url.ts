/** A registry URL's scheme can carry its kind: `sparse+https://…`, `registry+https://…`, `git+https://…`. */
const KIND_PREFIX = /^(?:registry|sparse|git)\+/;

/**
 * The host name in a URL a package file names, or null when there is none to read. Only the host is
 * kept: a user name, password, token, port or path in the URL is dropped here and never returned.
 * A `//host/path` value (an `.npmrc` key) reads as https. Never throws, and never echoes its input.
 */
export function hostOfUrl(raw: string): string | null {
  const text = raw.trim().replace(KIND_PREFIX, '');
  // A value that still holds a variable to expand names no host yet.
  if (text.includes('$') || text.includes('%')) return null;
  const absolute = text.startsWith('//') ? `https:${text}` : text;
  if (!/^https?:\/\//i.test(absolute)) return null;
  try {
    const host = new URL(absolute).hostname.replace(/\.$/, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}
