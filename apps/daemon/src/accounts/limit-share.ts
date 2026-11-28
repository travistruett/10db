/** The key a report with no limit type is kept under. */
export const UNNAMED_LIMIT = 'unnamed';

/**
 * What a session has heard of each limit: the last utilization, and the rise since the first report
 * (null after one, which has nothing to compare with).
 */
export type LimitShareState = ReadonlyMap<
  string,
  { readonly last: number; readonly rise: number | null }
>;

/**
 * Folds one usage report into a session's state. A rise is the utilization less the last one, or the
 * utilization itself when it fell (the limit reset, so what it holds now was used since). A report
 * with no utilization changes nothing. The state it is given is not changed.
 */
export function limitShare(
  state: LimitShareState,
  report: { readonly limitType: string | null; readonly utilization: number | null },
): LimitShareState {
  if (report.utilization === null) return state;
  const type = report.limitType ?? UNNAMED_LIMIT;
  const before = state.get(type);
  const u = report.utilization;
  const rise =
    before === undefined ? null : (before.rise ?? 0) + (u < before.last ? u : u - before.last);
  return new Map([...state, [type, { last: u, rise }]]);
}

const WEEKLY_LIMIT = 'seven_day';
const WINDOW_MINUTES: Readonly<Record<string, number>> = { five_hour: 300 };
const MINUTES_SUFFIX = /^(\d+)_minutes$/;
const WEEKLY_MINUTES = 10_080;

/** A named window's length; a name 10db does not know ranks below every known one. */
function windowMinutes(type: string): number {
  const known = WINDOW_MINUTES[type];
  if (known !== undefined) return known;
  if (type.startsWith(WEEKLY_LIMIT)) return WEEKLY_MINUTES;
  const minutes = MINUTES_SUFFIX.exec(type)?.[1];
  return minutes === undefined ? 0 : Number(minutes);
}

/**
 * The limit a session's share is read from: the weekly one when it was heard, else the longest named
 * window, else the unnamed one (used only when nothing else was heard); null when none was.
 */
export function ceilingLimit(typesHeard: readonly string[]): string | null {
  if (typesHeard.includes(WEEKLY_LIMIT)) return WEEKLY_LIMIT;
  const named = typesHeard.filter((type) => type !== UNNAMED_LIMIT);
  const longest = named.reduce<string | null>(
    (best, type) => (best === null || windowMinutes(type) > windowMinutes(best) ? type : best),
    null,
  );
  if (longest !== null) return longest;
  return typesHeard.includes(UNNAMED_LIMIT) ? UNNAMED_LIMIT : null;
}
