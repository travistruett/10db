import { WorkstreamState, type ProjectId, type WorkstreamDto } from '@10db/contracts';
import { LiveGroup, lastMoment } from './live-groups';

/** The parts of a stacked bar, in the order they are drawn: merged work on the left, waiting work on the right. */
export const BarPart = {
  Merged: 'merged',
  Running: 'running',
  InReview: 'in_review',
  NeedsYou: 'needs_you',
  Failed: 'failed',
  Waiting: 'waiting',
} as const;
export type BarPart = (typeof BarPart)[keyof typeof BarPart];

export const BAR_ORDER: readonly BarPart[] = [
  BarPart.Merged,
  BarPart.Running,
  BarPart.InReview,
  BarPart.NeedsYou,
  BarPart.Failed,
  BarPart.Waiting,
];

export type BarCounts = Readonly<Record<BarPart, number>>;

const PART_OF: Readonly<Record<LiveGroup, BarPart>> = {
  [LiveGroup.NeedsYou]: BarPart.NeedsYou,
  [LiveGroup.Failed]: BarPart.Failed,
  [LiveGroup.Running]: BarPart.Running,
  [LiveGroup.InReview]: BarPart.InReview,
  [LiveGroup.Waiting]: BarPart.Waiting,
  [LiveGroup.Done]: BarPart.Merged,
};

/** One run in the section `liveGroups` put it in. */
export interface LiveRow {
  readonly group: LiveGroup;
  readonly run: WorkstreamDto;
}

export function flatRows(
  groups: readonly { readonly group: LiveGroup; readonly rows: readonly WorkstreamDto[] }[],
): LiveRow[] {
  return groups.flatMap(({ group, rows }) => rows.map((run) => ({ group, run })));
}

export function barCounts(rows: readonly LiveRow[]): BarCounts {
  const counts: Record<BarPart, number> = {
    merged: 0,
    running: 0,
    in_review: 0,
    needs_you: 0,
    failed: 0,
    waiting: 0,
  };
  for (const row of rows) counts[PART_OF[row.group]] += 1;
  return counts;
}

/** A goal's bar from its progress: merged, in review, and the rest still to land. */
export function goalBar(progress: {
  readonly merged: number;
  readonly inReview: number;
  readonly total: number;
}): BarCounts {
  return {
    merged: progress.merged,
    running: 0,
    in_review: progress.inReview,
    needs_you: 0,
    failed: 0,
    waiting: Math.max(0, progress.total - progress.merged - progress.inReview),
  };
}

/** A project's verdict, by what needs the builder first: "2 need you · 1 failed · 2 running · 6 merged today". */
export function projectLine(counts: BarCounts): string {
  const parts = [
    counts.needs_you > 0 ? `${String(counts.needs_you)} need you` : null,
    counts.failed > 0 ? `${String(counts.failed)} failed` : null,
    counts.running > 0 ? `${String(counts.running)} running` : null,
    counts.in_review > 0 ? `${String(counts.in_review)} in review` : null,
    counts.waiting > 0 ? `${String(counts.waiting)} waiting` : null,
    counts.merged > 0 ? `${String(counts.merged)} merged today` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return 'Idle · nothing open';
  const busy =
    counts.needs_you + counts.failed + counts.running + counts.in_review + counts.waiting;
  return busy === 0 ? `Idle · ${parts.join(' · ')}` : parts.join(' · ');
}

/** Where a project sorts: what needs the builder first, then what moves, then what is idle. */
export function projectRank(counts: BarCounts): number {
  if (counts.needs_you + counts.failed > 0) return 0;
  if (counts.running + counts.in_review + counts.waiting > 0) return 1;
  return 2;
}

/** A project starts open when something in it needs the builder or runs now. */
export function startsOpen(counts: BarCounts): boolean {
  return counts.needs_you + counts.failed + counts.running > 0;
}

/** Failed runs of one project that stopped the same way at the same step, so one Retry All answers them all. */
export interface FailureCause {
  readonly key: string;
  readonly projectId: ProjectId;
  /** Newest first. */
  readonly runs: readonly WorkstreamDto[];
}

function causeKey(run: WorkstreamDto): string {
  const step = run.steps[run.stepIndex]?.role ?? '';
  return [run.projectId, run.failureKind ?? '', step].join('\u0000');
}

/** Groups failed runs by project, failure kind and failed step; the cause with the newest failure first. */
export function failureCauses(failed: readonly WorkstreamDto[]): FailureCause[] {
  const at = (run: WorkstreamDto): number => new Date(lastMoment(run)).getTime();
  const by = new Map<string, { projectId: ProjectId; runs: WorkstreamDto[] }>();
  for (const run of [...failed].sort((a, b) => at(b) - at(a))) {
    const key = causeKey(run);
    const cause = by.get(key);
    if (cause === undefined) by.set(key, { projectId: run.projectId, runs: [run] });
    else cause.runs.push(run);
  }
  return [...by.entries()].map(([key, cause]) => ({ key, ...cause }));
}

/** A run waiting on a question someone other than the builder holds. */
export function waitsOnSomeoneElse(run: WorkstreamDto): boolean {
  return run.state === WorkstreamState.WaitingHuman && run.waitingOn !== null;
}
