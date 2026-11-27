import { useEffect, useRef, useState } from 'react';
import { useDaemonStatus, type DaemonStatus } from '../daemon/provider';

/** How long the phone app may stay unreachable after it comes back to the front before it loads again. */
const STUCK_AFTER_RESUME_MS = 20_000;

/**
 * The phone app loads itself again when it is still reconnecting 20 s after coming back to the front, once per
 * return. A phone that slept with Tailscale idle can wake to a page whose requests hang on a connection that is
 * gone, which a reload clears at once; the worker keeps the app's shell, so a reload with no signal still opens it.
 * Only an outage already under way at the return counts: a healthy answer after it ends the return, and a later
 * outage is ridden out with the Reconnecting pill, so an answer being typed is never lost to a reload.
 */
export function useReloadWhenStuck(): void {
  const status = useDaemonStatus();
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const latest = useRef<DaemonStatus>(status);
  // The status shown at the return is the one from before the phone slept: only a newer healthy one ends the return.
  const atReturn = useRef<DaemonStatus | null>(null);
  const healed = useRef(false);
  useEffect(() => {
    latest.current = status;
  });
  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState !== 'visible') return;
      atReturn.current = latest.current;
      healed.current = false;
      setResumedAt(Date.now());
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('pageshow', onReturn);
    };
  }, []);
  useEffect(() => {
    if (status.kind === 'connected' && status !== atReturn.current) healed.current = true;
    if (status.kind !== 'reconnecting' || resumedAt === null || healed.current) return undefined;
    const stuckFrom = Math.max(resumedAt, status.since);
    const timer = setTimeout(
      () => {
        if (document.visibilityState === 'visible') window.location.reload();
      },
      Math.max(0, stuckFrom + STUCK_AFTER_RESUME_MS - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [status, resumedAt]);
}
