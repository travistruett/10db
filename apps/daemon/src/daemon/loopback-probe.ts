import { isLoopbackOrigin } from '@10db/contracts';

/** Whether something answers HTTP at a loopback origin now. */
export type AddressProbe = (url: string, signal?: AbortSignal) => Promise<boolean>;

/** How long one probe waits for an answer. */
export const PROBE_MS = 1_000;

/**
 * One GET of a loopback origin, given `ms` to answer; any HTTP status is an answer. A redirect is not
 * followed, so the probe never leaves the address it was given, and an address that is not a loopback
 * origin is never asked.
 */
export function loopbackProbe(ms: number = PROBE_MS): AddressProbe {
  return async (url, signal) => {
    if (!isLoopbackOrigin(new URL(url).origin)) return false;
    const bound = AbortSignal.timeout(ms);
    try {
      const response = await fetch(url, {
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
