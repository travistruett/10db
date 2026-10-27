/** A remote URL the daemon will fetch from or push to, in the one form it pins and uses. */
export type RemoteUrl =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly why: string };

/** Characters no remote URL the daemon accepts holds: whitespace, controls and a backslash. */
const UNSAFE = /[\s\\\p{Cc}]/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * `[user@]host:path`, the scp form git reads as ssh; its user is a login name, not a secret. Neither
 * user nor host may start with `-`, which ssh would read as an option.
 */
const SCP =
  /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9.][A-Za-z0-9.-]*:(?!\/)[A-Za-z0-9._~/-]+$/;
/** `ssh://user@host[:port]/path`: an ssh login name, with no password and nothing after the path. */
const SSH_USER = /^ssh:\/\/[A-Za-z0-9._][A-Za-z0-9._-]*@[^@?#:/]+(?::\d+)?\/[^@?#]+$/i;
const LOCAL_PATH = /^\/[^@?#]*$/;
const SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'file:']);

/**
 * Parses origin's URL strictly. A URL that carries userinfo (a user, password or token) is refused:
 * the daemon never sends credentials written into a URL, and any `@`, `?` or `#` in a scheme URL is
 * refused with it, so no other parser can read a different host from the same text. What passes is
 * returned in the form the WHATWG parser prints, which is what pins hold and the network call uses.
 */
export function parseRemoteUrl(raw: string): RemoteUrl {
  if (raw === '' || UNSAFE.test(raw))
    return { ok: false, why: 'holds a character no remote URL may' };
  if (SCHEME.test(raw)) {
    if (SSH_USER.test(raw)) {
      const url = new URL(raw);
      return url.password === ''
        ? { ok: true, url: url.href }
        : { ok: false, why: 'carries a password' };
    }
    if (/[@?#]/.test(raw))
      return { ok: false, why: 'carries credentials or a part 10db reads no further than' };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, why: 'does not parse as a URL' };
    }
    if (!SCHEMES.has(url.protocol) || url.username !== '' || url.password !== '')
      return { ok: false, why: 'names a transport or credentials 10db does not use' };
    return { ok: true, url: url.href };
  }
  if (SCP.test(raw) || LOCAL_PATH.test(raw)) return { ok: true, url: raw };
  return { ok: false, why: 'is neither a URL, an ssh address nor an absolute path' };
}

/** The filesystem path a parsed local or `file:` remote names; null for a network remote. */
export function localRemotePath(url: string): string | null {
  if (url.startsWith('/')) return url;
  if (url.toLowerCase().startsWith('file:')) return decodeURIComponent(new URL(url).pathname);
  return null;
}

/** `scheme://userinfo@`, up to the last `@` before the path, whatever the userinfo holds. */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi;

/** `text` with the userinfo of every URL in it masked: defense in depth for logs and errors. */
export function redactUrls(text: string): string {
  return text.replace(USERINFO, '$1***@');
}
