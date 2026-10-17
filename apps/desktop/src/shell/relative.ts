import { useInterval } from '@mantine/hooks';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState } from 'react';

dayjs.extend(relativeTime);

/** How often relative times refresh; minutes are the finest unit shown. */
const RELATIVE_REFRESH_MS = 30_000;

/** The current time, refreshed on an interval, so a relative time stays true while it is on screen. */
export function useNow(intervalMs: number = RELATIVE_REFRESH_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(
    () => {
      setNow(Date.now());
    },
    intervalMs,
    { autoInvoke: true },
  );
  return now;
}

/** "2 minutes ago", for timestamps (ms or ISO) shown to the builder, relative to `now`. */
export function fromNow(at: number | string, now: number = Date.now()): string {
  return dayjs(at).from(now);
}

/** The exact local time, for a tooltip beside a relative one. */
export function absoluteTime(at: number | string): string {
  return dayjs(at).format('YYYY-MM-DD HH:mm:ss');
}
