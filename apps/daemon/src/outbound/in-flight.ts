// The hosts the daemon is waiting on right now. The watchdog publishes them, so a stalled main loop
// can be logged with the calls that were open when it stopped.

const counts = new Map<string, number>();
const listeners = new Set<(hosts: readonly string[]) => void>();

const notify = (): void => {
  const hosts = inFlightHosts();
  for (const listener of listeners) listener(hosts);
};

/** The host a fetch input names, or null when it names none that can be read. Never throws. */
export function hostOf(input: string | URL | Request): string | null {
  try {
    if (typeof input === 'string') return new URL(input).host;
    if (input instanceof URL) return input.host;
    return new URL(input.url).host;
  } catch {
    return null;
  }
}

/** Counts one call to `host` as open; the returned function closes it, once. */
export function trackInFlight(host: string): () => void {
  counts.set(host, (counts.get(host) ?? 0) + 1);
  notify();
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const left = (counts.get(host) ?? 1) - 1;
    if (left > 0) counts.set(host, left);
    else counts.delete(host);
    notify();
  };
}

/** Each host with a call open, once. */
export function inFlightHosts(): readonly string[] {
  return [...counts.keys()];
}

/** Calls `listener` with the hosts each time a call opens or closes; the returned function stops it. */
export function onInFlightChange(listener: (hosts: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
