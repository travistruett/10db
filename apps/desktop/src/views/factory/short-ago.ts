const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "3h ago", the short form the goal lines use: minutes, hours or days, whichever is the largest whole unit. */
export function shortAgo(at: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(at).getTime());
  if (elapsed >= DAY_MS) return `${String(Math.floor(elapsed / DAY_MS))}d ago`;
  if (elapsed >= HOUR_MS) return `${String(Math.floor(elapsed / HOUR_MS))}h ago`;
  if (elapsed >= MINUTE_MS) return `${String(Math.floor(elapsed / MINUTE_MS))}m ago`;
  return 'just now';
}
