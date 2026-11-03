import type { ShapePreviewClash, ShapePreviewItem } from '@10db/contracts';

// Shape spec §10.2. A pure simulation of the project's lanes: running work holds its lanes first,
// queued work next, then the draft's tasks, longest chain first. A task starts once its
// dependencies have ended, a lane is free and no running task claims one of its areas. Nothing here
// reads or writes the database.

/** A task to place: a draft task, or work already running or queued with its remaining hours. */
export interface ScheduleItem {
  readonly key: string;
  readonly title: string;
  /** Lane hours still to run. */
  readonly hours: number;
  readonly areas: readonly string[];
  /** Keys of other items; a key that names no item is a dependency already met. */
  readonly dependsOn: readonly string[];
  /** Set for work the project already has; absent for the draft. */
  readonly existing: 'running' | 'queued' | null;
}

export interface Schedule {
  readonly lanes: readonly { readonly items: readonly ShapePreviewItem[] }[];
  readonly criticalPath: readonly string[];
  readonly clashes: readonly ShapePreviewClash[];
  /** When the last task ends. */
  readonly scheduleHours: number;
}

/** Hours are sums of estimates, so equal times differ by rounding at most this much. */
const EPSILON = 1e-9;

interface Placed {
  readonly item: ScheduleItem;
  readonly lane: number;
  readonly start: number;
  readonly end: number;
  /** The task whose end let this one start, when it started after the beginning. */
  readonly blockedBy: string | null;
}

/** Each item's own hours plus the longest chain of items waiting on it. */
function chainHours(items: readonly ScheduleItem[]): Map<string, number> {
  const dependents = new Map<string, ScheduleItem[]>();
  for (const item of items)
    for (const dep of item.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), item]);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const hoursFrom = (item: ScheduleItem): number => {
    const known = memo.get(item.key);
    if (known !== undefined) return known;
    // A cycle is refused when a draft is validated; this only stops a loop.
    if (visiting.has(item.key)) return item.hours;
    visiting.add(item.key);
    const after = Math.max(0, ...(dependents.get(item.key) ?? []).map(hoursFrom));
    visiting.delete(item.key);
    memo.set(item.key, item.hours + after);
    return item.hours + after;
  };
  for (const item of items) hoursFrom(item);
  return memo;
}

/** Whether `from` waits on `to`, directly or through other items. */
function waitsOn(
  byKey: ReadonlyMap<string, ScheduleItem>,
  from: ScheduleItem,
  to: string,
): boolean {
  const seen = new Set<string>();
  const stack = [...from.dependsOn];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || seen.has(key)) continue;
    if (key === to) return true;
    seen.add(key);
    stack.push(...(byKey.get(key)?.dependsOn ?? []));
  }
  return false;
}

function joinTitles(titles: readonly string[]): string {
  const last = titles[titles.length - 1] ?? '';
  return titles.length === 1 ? last : `${titles.slice(0, -1).join(', ')} and ${last}`;
}

/** One line per area that tasks claim and nothing orders: they will run one after the other. */
function clashesOf(items: readonly ScheduleItem[]): ShapePreviewClash[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const claimers = new Map<string, ScheduleItem[]>();
  for (const item of items)
    for (const area of new Set(item.areas))
      claimers.set(area, [...(claimers.get(area) ?? []), item]);
  const out: ShapePreviewClash[] = [];
  for (const [area, group] of claimers) {
    if (group.length < 2) continue;
    const unordered = group.some((a, i) =>
      group
        .slice(i + 1)
        .some(
          (b) =>
            (a.existing === null || b.existing === null) &&
            !waitsOn(byKey, a, b.key) &&
            !waitsOn(byKey, b, a.key),
        ),
    );
    if (!unordered) continue;
    const held = group.filter((i) => i.existing !== null);
    const draft = group.filter((i) => i.existing === null);
    const titles = group.map((i) => i.title);
    let text: string;
    if (held.length > 0 && draft.length > 0) {
      text = `${joinTitles(draft.map((i) => i.title))} ${draft.length === 1 ? 'claims' : 'claim'} ${area}, which ${joinTitles(held.map((i) => i.title))} ${held.length === 1 ? 'holds' : 'hold'}: ${draft.length === 1 ? "it'll" : "they'll"} wait for it`;
    } else {
      text = `${joinTitles(titles)} ${titles.length === 2 ? 'both' : 'all'} claim ${area}: they'll run one after the other`;
    }
    out.push({ area, titles, text });
  }
  return out;
}

export function simulateFactory(laneCap: number, items: readonly ScheduleItem[]): Schedule {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const chains = chainHours(items);
  const running = items.filter((i) => i.existing === 'running');
  const queued = items.filter((i) => i.existing === 'queued');
  const draft = items
    .filter((i) => i.existing === null)
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) => (chains.get(b.item.key) ?? 0) - (chains.get(a.item.key) ?? 0) || a.index - b.index,
    )
    .map(({ item }) => item);
  // Running work is on a lane already, even beyond a cap lowered since.
  const laneCount = Math.max(laneCap, running.length);
  const busyUntil = Array.from({ length: laneCount }, () => 0);
  const placed = new Map<string, Placed>();
  running.forEach((item, lane) => {
    placed.set(item.key, { item, lane, start: 0, end: item.hours, blockedBy: null });
    busyUntil[lane] = item.hours;
  });

  const pending = [...queued, ...draft];
  const sharesArea = (a: ScheduleItem, b: ScheduleItem): boolean =>
    a.areas.some((area) => b.areas.includes(area));

  const place = (item: ScheduleItem, lane: number, t: number): void => {
    let blockedBy: string | null = null;
    if (t > EPSILON) {
      const ending = [...placed.values()].filter((p) => Math.abs(p.end - t) < EPSILON);
      const pick =
        ending.find((p) => item.dependsOn.includes(p.item.key)) ??
        ending.find((p) => sharesArea(p.item, item)) ??
        ending[0];
      blockedBy = pick?.item.key ?? null;
    }
    placed.set(item.key, { item, lane, start: t, end: t + item.hours, blockedBy });
    busyUntil[lane] = t + item.hours;
    pending.splice(pending.indexOf(item), 1);
  };

  let t = 0;
  while (pending.length > 0) {
    let started = true;
    while (started) {
      started = false;
      for (const item of [...pending]) {
        const lane = busyUntil.findIndex((until) => until <= t + EPSILON);
        if (lane === -1) break;
        const ready = item.dependsOn.every((key) => {
          if (!byKey.has(key)) return true;
          const dep = placed.get(key);
          return dep !== undefined && dep.end <= t + EPSILON;
        });
        const areaFree = ![...placed.values()].some(
          (p) => p.end > t + EPSILON && p.start <= t + EPSILON && sharesArea(p.item, item),
        );
        if (ready && areaFree) {
          place(item, lane, t);
          started = true;
        }
      }
    }
    if (pending.length === 0) break;
    const next = Math.min(
      Infinity,
      ...[...placed.values()].map((p) => p.end).filter((end) => end > t + EPSILON),
    );
    if (next === Infinity) {
      // Nothing is running and nothing may start: a dependency loop. Run the first task so the
      // preview still ends; validation refuses such a draft.
      const first = pending[0];
      if (first === undefined) break;
      place(
        first,
        Math.max(
          0,
          busyUntil.findIndex((until) => until <= t + EPSILON),
        ),
        t,
      );
    } else t = next;
  }

  const all = [...placed.values()];
  const scheduleHours = Math.max(0, ...all.map((p) => p.end));
  const critical: string[] = [];
  let tail = all.reduce<Placed | undefined>(
    (best, p) => (best === undefined || p.end > best.end + EPSILON ? p : best),
    undefined,
  );
  while (tail !== undefined) {
    critical.unshift(tail.item.key);
    tail = tail.blockedBy === null ? undefined : placed.get(tail.blockedBy);
  }
  const onPath = new Set(critical);
  return {
    lanes: Array.from({ length: laneCount }, (_, lane) => ({
      items: all
        .filter((p) => p.lane === lane)
        .sort((a, b) => a.start - b.start)
        .map((p) => ({
          key: p.item.key,
          title: p.item.title,
          startHours: p.start,
          endHours: p.end,
          existing: p.item.existing !== null,
          critical: onPath.has(p.item.key),
        })),
    })),
    criticalPath: critical,
    clashes: clashesOf(items),
    scheduleHours,
  };
}
