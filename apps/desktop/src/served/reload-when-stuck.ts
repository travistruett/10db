import { useEffect, useState } from 'react';
import { useDaemonStatus } from '../daemon/provider';

/** How long the phone app may stay unreachable after it comes back to the front before it loads again. */
export const STUCK_AFTER_RESUME_MS = 20_000;

/**
 * The phone app loads itself again when it is still reconnecting 20 s after coming back to the front, once per
 * return. A phone that slept with Tailscale idle can wake to a page whose requests hang on a connection that is
 * gone, which a reload clears at once; the worker keeps the app's shell, so a reload with no signal still opens it.
 */
export function useReloadWhenStuck(): void {
  const status = useDaemonStatus();
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState === 'visible') setResumedAt(Date.now());
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('pageshow', onReturn);
    };
  }, []);
  const since = status.kind === 'reconnecting' ? status.since : null;
  useEffect(() => {
    if (since === null || resumedAt === null) return undefined;
    const stuckFrom = Math.max(resumedAt, since);
    const timer = setTimeout(
      () => {
        if (document.visibilityState === 'visible') window.location.reload();
      },
      Math.max(0, stuckFrom + STUCK_AFTER_RESUME_MS - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [since, resumedAt]);
}
