/** Whether something answers HTTP at a loopback origin now. */
export type AddressProbe = (url: string, signal?: AbortSignal) => Promise<boolean>;

/** How long one probe waits for an answer. */
export const PROBE_MS = 1_000;

/** The only hosts a probe asks: this Mac's loopback, by the names that need no resolver. */
const PROBED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** Whether `url` is an http or https URL on one of `PROBED_HOSTS`. */
function probedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      PROBED_HOSTS.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * One GET of a loopback origin, given `ms` to answer; any HTTP status is an answer. A redirect is not
 * followed, so the probe never leaves the address it was given, and an address on any host but
 * `localhost`, `127.0.0.1` or `[::1]` is never asked.
 */
export function loopbackProbe(ms: number = PROBE_MS, request: typeof fetch = fetch): AddressProbe {
  return async (url, signal) => {
    if (!probedHost(url)) return false;
    const bound = AbortSignal.timeout(ms);
    try {
      const response = await request(url, {
        redirect: 'manual',
        signal: signal === undefined ? bound : AbortSignal.any([bound, signal]),
      });
      await response.body?.cancel();
      return true;
    } catch {
      return false;
    }
  };
}
