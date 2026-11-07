/** The hosts whose pages 10db opens for a browser sign-in: the agent's own, nothing else. */
export const SIGN_IN_HOSTS = ['auth.openai.com'] as const;

/**
 * Whether `raw` is an https page on a sign-in host, on the default port and with no credentials in
 * front of the host. The daemon checks the address an agent names with it, and so does the response
 * schema the desktop app reads.
 */
export function isSignInUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    SIGN_IN_HOSTS.some((host) => host === url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}
