/** The hosts whose pages 10db opens for an agent's browser sign-in: the agent's own, nothing else. */
export const SIGN_IN_HOSTS = ['auth.openai.com'] as const;

/** The one page on github.com that 10db opens for a sign-in: gh's device-code page. */
const GITHUB_DEVICE_PAGE = { host: 'github.com', path: '/login/device' } as const;

/**
 * Whether `raw` is an https sign-in page 10db opens: any page on a sign-in host, or github.com's
 * device-code page and nothing else on github.com, on the default port and with no credentials in
 * front of the host. The daemon checks the address an agent or gh names with it, and so does the
 * response schema the desktop app reads.
 */
export function isSignInUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const plain =
    url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '';
  if (!plain) return false;
  return (
    SIGN_IN_HOSTS.some((host) => host === url.hostname) ||
    (url.hostname === GITHUB_DEVICE_PAGE.host && url.pathname === GITHUB_DEVICE_PAGE.path)
  );
}
