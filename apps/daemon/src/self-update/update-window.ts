/**
 * How long after an install the next one must wait before the factory is drained for it, when work is
 * running. Every merge of that window lands in one install, so lanes are not held, and the daemon not
 * restarted, for each. With nothing running an update installs at once whatever the window says.
 */
export const UPDATE_WINDOW_MS = 90 * 60_000;

/**
 * The most a drain may hold new work back while a running gate keeps the install from starting. Past
 * it the hold is released, work goes on, and the update tries again at the next quiet moment or once
 * `UPDATE_WINDOW_MS` has passed since the release.
 */
export const DRAIN_HOLD_CAP_MS = 30 * 60_000;

/** The `app_settings` key holding when the last install finished, in epoch milliseconds. */
export const SELF_UPDATE_INSTALLED_AT_KEY = 'self_update.installed_at';

/** The status line key for an update that waits for its window or for the wait limit. */
export const UPDATE_WAIT_STATUS_KEY = 'update-wait';

/**
 * The earliest moment the factory may be drained for a staged update, in epoch milliseconds: once
 * the builder's wait limit has run from staging, and once the window has run from the last install
 * or from the last time a drain was released at its cap, whichever came later.
 */
export function drainNotBefore(input: {
  readonly stagedAt: number;
  readonly waitLimitMs: number;
  readonly lastInstallAt: number | null;
  readonly releasedAt: number | null;
}): number {
  const anchors = [input.lastInstallAt, input.releasedAt].filter((at): at is number => at !== null);
  const windowEnd = anchors.length === 0 ? 0 : Math.max(...anchors) + UPDATE_WINDOW_MS;
  return Math.max(input.stagedAt + input.waitLimitMs, windowEnd);
}
