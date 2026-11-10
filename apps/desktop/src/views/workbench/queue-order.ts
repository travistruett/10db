import { PageStatus } from './page-status';

// Workbench spec §4.3: the queue's order. Rank 1, an agent stalled (a question, a permission, a failed
// turn); rank 3, Ready pages, the longest waiting first; rank 4, dimmed, the pages that need nothing.
// Rank 2, a page that broke the preview, comes with the preview check.

export type QueueRank = 1 | 3 | 4;

/** A page as the queue sorts it. */
export interface QueueEntry {
  readonly status: PageStatus;
  /** When the page's turn was Ready; read only for Ready pages. */
  readonly readyAt: string | null;
}

/**
 * Each status's rank, and its place among the dimmed pages: signing off first, then working and
 * paused, then not started, then signed off.
 */
const PLACE: Readonly<Record<PageStatus, { readonly rank: QueueRank; readonly within: number }>> = {
  [PageStatus.Asks]: { rank: 1, within: 0 },
  [PageStatus.Failed]: { rank: 1, within: 0 },
  [PageStatus.Ready]: { rank: 3, within: 0 },
  [PageStatus.SigningOff]: { rank: 4, within: 0 },
  [PageStatus.Waiting]: { rank: 4, within: 0 },
  [PageStatus.Working]: { rank: 4, within: 1 },
  [PageStatus.Paused]: { rank: 4, within: 1 },
  [PageStatus.NotStarted]: { rank: 4, within: 2 },
  [PageStatus.SignedOff]: { rank: 4, within: 3 },
};

export function queueRank(status: PageStatus): QueueRank {
  return PLACE[status].rank;
}

/** Rank 4 rows are drawn dimmed: nothing there waits on the builder. */
export function isDimmed(status: PageStatus): boolean {
  return queueRank(status) === 4;
}

function readyTime(entry: QueueEntry): number {
  return entry.readyAt === null ? Number.POSITIVE_INFINITY : Date.parse(entry.readyAt);
}

/** The queue in order; entries of the same place keep the order they were given in. */
export function queueOrder<T extends QueueEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const pa = PLACE[a.status];
    const pb = PLACE[b.status];
    if (pa.rank !== pb.rank) return pa.rank - pb.rank;
    if (pa.within !== pb.within) return pa.within - pb.within;
    return pa.rank === 3 ? readyTime(a) - readyTime(b) : 0;
  });
}

/** How many pages wait on the builder (ranks 1 to 3): the Workbench's count in the sidebar. */
export function waitingCount(entries: readonly QueueEntry[]): number {
  return entries.filter((entry) => queueRank(entry.status) < 4).length;
}
