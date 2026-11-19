import { WorkstreamState, type WorkstreamDto } from '@10db/contracts';

const S = WorkstreamState;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Factory's live sections, in the order they show: what needs the builder first, what finished last. */
export const LiveGroup = {
  NeedsYou: 'needs_you',
  Failed: 'failed',
  Running: 'running',
  Waiting: 'waiting',
  Done: 'done',
} as const;
export type LiveGroup = (typeof LiveGroup)[keyof typeof LiveGroup];

export const LIVE_GROUP_LABELS: Readonly<Record<LiveGroup, string>> = {
  [LiveGroup.NeedsYou]: 'Needs You',
  [LiveGroup.Failed]: 'Failed',
  [LiveGroup.Running]: 'Running',
  [LiveGroup.Waiting]: 'Queued',
  [LiveGroup.Done]: 'Done Today',
};

const ORDER: readonly LiveGroup[] = [
  LiveGroup.NeedsYou,
  LiveGroup.Failed,
  LiveGroup.Running,
  LiveGroup.Waiting,
  LiveGroup.Done,
];

/** When a run last did anything: its last activity, else its last change of state. */
export function lastMoment(ws: WorkstreamDto): string {
  return ws.lastActivityAt ?? ws.updatedAt;
}

/** Which section a run sits in; null when it shows nowhere (cancelled, or finished too long ago). */
function groupOf(ws: WorkstreamDto, now: number): LiveGroup | null {
  const age = now - new Date(lastMoment(ws)).getTime();
  switch (ws.state) {
    case S.WaitingHuman:
      return LiveGroup.NeedsYou;
    case S.Failed:
      // A failure stays until it is retried or closed, for a week at most.
      return age <= 7 * DAY_MS ? LiveGroup.Failed : null;
    case S.Starting:
    case S.Running:
    case S.HandingOff:
    case S.Verifying:
    case S.Recovering:
    case S.PausedLimit:
    case S.TakenOver:
      return LiveGroup.Running;
    case S.Queued:
    case S.Held:
      return LiveGroup.Waiting;
    case S.Done:
      return age <= DAY_MS ? LiveGroup.Done : null;
    case S.Cancelled:
      return null;
  }
}

/**
 * Every project's runs as the Factory's sections: each task's latest run only, so a retried failure leaves
 * Failed, newest activity first within a section, and a section with nothing in it left out.
 */
export function liveGroups(
  workstreams: readonly WorkstreamDto[],
  now: number,
): { readonly group: LiveGroup; readonly rows: readonly WorkstreamDto[] }[] {
  const latest = new Map<string, WorkstreamDto>();
  for (const ws of workstreams) {
    const seen = latest.get(ws.taskId);
    if (seen === undefined || ws.attempt > seen.attempt) latest.set(ws.taskId, ws);
  }
  const by = new Map<LiveGroup, WorkstreamDto[]>();
  for (const ws of latest.values()) {
    const group = groupOf(ws, now);
    if (group !== null) by.set(group, [...(by.get(group) ?? []), ws]);
  }
  const at = (ws: WorkstreamDto): number => new Date(lastMoment(ws)).getTime();
  return ORDER.flatMap((group) => {
    const rows = by.get(group);
    return rows === undefined ? [] : [{ group, rows: [...rows].sort((a, b) => at(b) - at(a)) }];
  });
}
