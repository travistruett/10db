import { PASS_PAGE_CAP_MAX, type PassTurnTimingDto } from '@10db/contracts';
import { PageStatus } from './page-status';
import type { QueueEntry } from './queue-order';

// Workbench spec §4.5: a page cycles through T, a turn, and R, the builder's look and reply, so about
// 1 + T / R pages keep one person busy. The pass says what it sees in one line above the queue.

const MINUTE_MS = 60_000;
/** The stretch the waiting is measured over. */
export const WAITED_WINDOW_MIN = 10;
/** From this many minutes of waiting in the window, the line says to add a page. */
export const WAITED_HINT_MIN = 5;
/** A Ready page waiting longer than this is said to have been ready for long. */
export const READY_LONG_MIN = 10;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

const ms = (at: string): number => Date.parse(at);

/** T: the median length of the pass's turns that have ended. */
export function medianTurnMs(turns: readonly PassTurnTimingDto[]): number | null {
  return median(
    turns.flatMap((t) => (t.endedAt === null ? [] : [ms(t.endedAt) - ms(t.startedAt)])),
  );
}

/** T in whole minutes, as a working page's line says it ("median 6"). */
export function medianTurnMinutes(turns: readonly PassTurnTimingDto[]): number | null {
  const t = medianTurnMs(turns);
  return t === null ? null : Math.round(t / MINUTE_MS);
}

/** R: the median time from a page's Ready to the builder's first word after it. */
export function medianReplyMs(turns: readonly PassTurnTimingDto[]): number | null {
  return median(
    turns.flatMap((t) =>
      t.readyAt === null || t.answeredAt === null ? [] : [ms(t.answeredAt) - ms(t.readyAt)],
    ),
  );
}

/** How many pages keep the builder busy: 1 + T / R, from 1 to the most a pass holds. */
export function pagesFor(turnMs: number, replyMs: number): number {
  const pages = replyMs === 0 ? PASS_PAGE_CAP_MAX : Math.round(1 + turnMs / replyMs);
  return Math.min(PASS_PAGE_CAP_MAX, Math.max(1, pages));
}

type Span = readonly [number, number];

function covers(spans: readonly Span[], at: number): boolean {
  return spans.some(([from, to]) => from <= at && at < to);
}

/** When a Ready turn stopped waiting: its answer, else the next turn of its task, else now. */
function readyUntil(turn: PassTurnTimingDto, turns: readonly PassTurnTimingDto[], now: number) {
  if (turn.answeredAt !== null) return ms(turn.answeredAt);
  const next = turns.find((t) => t.taskId === turn.taskId && t.seq === turn.seq + 1);
  return next ? ms(next.startedAt) : now;
}

/**
 * Whole minutes of the last ten in which the builder waited on the agents: a page was working and
 * none was Ready or asking. `asking` holds when each open question or permission ask was raised.
 */
export function waitedMinutes(
  turns: readonly PassTurnTimingDto[],
  asking: readonly string[],
  now: number,
): number {
  const from = now - WAITED_WINDOW_MIN * MINUTE_MS;
  const working: Span[] = turns.map((t) => [
    ms(t.startedAt),
    t.endedAt === null ? now : ms(t.endedAt),
  ]);
  const busy: Span[] = [
    ...turns.flatMap((t): Span[] =>
      t.readyAt === null ? [] : [[ms(t.readyAt), readyUntil(t, turns, now)]],
    ),
    ...asking.map((at): Span => [ms(at), now]),
  ];
  const edges = [from, now, ...[...working, ...busy].flat()]
    .filter((at) => at >= from && at <= now)
    .sort((a, b) => a - b);
  let waited = 0;
  for (let i = 1; i < edges.length; i += 1) {
    const start = edges[i - 1] ?? from;
    const end = edges[i] ?? now;
    const mid = (start + end) / 2;
    if (end > start && covers(working, mid) && !covers(busy, mid)) waited += end - start;
  }
  return Math.floor(waited / MINUTE_MS);
}

/** Pages that no longer cycle through turns: signed off or signing off. */
const OUT_OF_PLAY: ReadonlySet<PageStatus> = new Set([
  PageStatus.SigningOff,
  PageStatus.Waiting,
  PageStatus.SignedOff,
]);

export interface TimingInput {
  /** Every turn of the pass. */
  readonly turns: readonly PassTurnTimingDto[];
  /** The pass's pages, each with its status. */
  readonly pages: readonly QueueEntry[];
  /** When each open question or permission ask of the pass's pages was raised. */
  readonly asking: readonly string[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
}

/**
 * The timing hint above the queue, or null when it has nothing to say: add a page when the builder
 * waited half the last ten minutes with fewer pages in play than keep them busy (and room for one),
 * else the Ready pages left for long, when two or more are.
 */
export function timingLine(input: TimingInput): string | null {
  const t = medianTurnMs(input.turns);
  const r = medianReplyMs(input.turns);
  const inPlay = input.pages.filter((page) => !OUT_OF_PLAY.has(page.status)).length;
  const waited = waitedMinutes(input.turns, input.asking, input.now);
  if (
    waited >= WAITED_HINT_MIN &&
    t !== null &&
    r !== null &&
    input.pages.length < PASS_PAGE_CAP_MAX &&
    inPlay < pagesFor(t, r)
  )
    return `You waited ${String(waited)} of the last ${String(WAITED_WINDOW_MIN)} minutes: add a page`;
  const readyLong = input.pages.filter(
    (page) =>
      page.status === PageStatus.Ready &&
      page.readyAt !== null &&
      input.now - ms(page.readyAt) > READY_LONG_MIN * MINUTE_MS,
  ).length;
  return readyLong >= 2
    ? `${String(readyLong)} pages have been ready for over ${String(READY_LONG_MIN)} minutes`
    : null;
}
