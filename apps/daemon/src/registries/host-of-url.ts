/** A registry URL's scheme can carry its kind: `sparse+https://…`, `registry+https://…`, `git+https://…`. */
const KIND_PREFIX = /^(?:registry|sparse|git)\+/;
/**
 * A host that still holds a variable to expand (`${HOST}`, which URL parsing keeps), or a pattern: no
 * package manager fetches from a wildcard, so a found host is one concrete name, never a pattern that
 * would allow a whole domain.
 */
const NOT_A_NAME = /[$*{}]/;

/**
 * The host name in a URL a package file names, or null when there is none to read. Only the host is
 * kept: a user name, password, token, port or path in the URL is dropped here and never returned, and
 * a variable or `%XX` escape in those parts doesn't hide the host. URL parsing decodes an escape in a
 * host name, or refuses the name. A `//host/path` value (an `.npmrc` key) reads as https. Never
 * throws, and never echoes its input.
 */
export function hostOfUrl(raw: string): string | null {
  const text = raw.trim().replace(KIND_PREFIX, '');
  const absolute = text.startsWith('//') ? `https:${text}` : text;
  if (!/^https?:\/\//i.test(absolute)) return null;
  try {
    const host = new URL(absolute).hostname.replace(/\.$/, '');
    return host === '' || NOT_A_NAME.test(host) ? null : host;
  } catch {
    return null;
  }
}
