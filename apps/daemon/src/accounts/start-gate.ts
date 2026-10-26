/**
 * One start at a time per key. On a subscription account, concurrent sessions may race an OAuth refresh
 * (Claude Code issues 54443 and 61923; spike 12's refresh check is unfinished), so its starts and probes
 * queue here until the previous one reports `started` or ends.
 */
export interface StartGate {
  /** Resolves with a release once every earlier holder of `key` has released; releasing twice is harmless. */
  acquire(key: string): Promise<() => void>;
  /** How many callers wait for `key` now, the holder excluded. */
  waiting(key: string): number;
}

export function createStartGate(): StartGate {
  const tails = new Map<string, Promise<void>>();
  const queued = new Map<string, number>();
  return {
    acquire(key) {
      const before = tails.get(key) ?? Promise.resolve();
      let open: () => void = () => undefined;
      const mine = new Promise<void>((resolve) => {
        open = resolve;
      });
      const tail = before.then(() => mine);
      tails.set(key, tail);
      queued.set(key, (queued.get(key) ?? 0) + 1);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return before.then(() => {
        queued.set(key, (queued.get(key) ?? 1) - 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          open();
        };
      });
    },
    // Callers whose acquire has not resolved yet; the holder's already has.
    waiting: (key) => queued.get(key) ?? 0,
  };
}
