import {
  BatchState,
  CARD_RELEASED_WORKSTREAMS,
  ReleasedWorkstreams,
  EventType,
  HUMAN_TOUCH_DAYS,
  InboxKind,
  InboxState,
  TaskStatus,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamState,
  type HumanTouchDayDto,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

// How often a person was needed, per UTC day, computed from the inbox rows and the event log. Nothing
// is stored: the figures are recomputed on each read.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** A batch in one of these states never runs anything again, so its failed runs can't be retried. */
const FINISHED_BATCH_STATES: readonly BatchState[] = [
  BatchState.Shipped,
  BatchState.Closed,
  BatchState.Abandoned,
];

/** A half-open span of time in epoch milliseconds. */
interface Span {
  readonly from: number;
  readonly to: number;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The spans merged so that none overlaps another. */
function union(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && span.from <= last.to)
      out[out.length - 1] = { from: last.from, to: Math.max(last.to, span.to) };
    else out.push(span);
  }
  return out;
}

/** The parts of the two span lists that both cover. Each list must already be merged. */
function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      if (from < to) out.push({ from, to });
    }
  }
  return out;
}

type CardRow = Pick<
  typeof schema.inboxItems.$inferSelect,
  'id' | 'kind' | 'title' | 'state' | 'createdAt' | 'updatedAt' | 'targets' | 'detail'
>;

/**
 * The workstreams a card is attributed to: its targets, and the lanes cancelled off it while others
 * stayed on it.
 */
function cardWorkstreams(card: CardRow): Set<WorkstreamId> {
  const released = ReleasedWorkstreams.safeParse(card.detail?.[CARD_RELEASED_WORKSTREAMS]);
  return new Set([
    ...card.targets.map((t) => t.workstreamId),
    ...(released.success ? released.data : []),
  ]);
}

/** A flag raised for a failed workstream: the runner and recovery title it with the failure prefix. */
function isFailureCard(card: CardRow): boolean {
  return card.kind === InboxKind.Flag && card.title.startsWith(WORKSTREAM_FAILED_TITLE_PREFIX);
}

/**
 * When each card stopped being open: its first change away from OPEN. A card that is still open
 * runs to `nowMs`; one whose change was never logged ends at its last update.
 */
function openSpans(db: DbReader, cards: readonly CardRow[], nowMs: number): Map<string, Span> {
  const closedAt = new Map<string, number>();
  if (cards.length > 0) {
    const events = db
      .select({ entityId: schema.events.entityId, data: schema.events.data, at: schema.events.at })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityType, 'inbox'),
          eq(schema.events.type, EventType.InboxChanged),
          inArray(
            schema.events.entityId,
            cards.map((c) => c.id),
          ),
        ),
      )
      .orderBy(asc(schema.events.seq))
      .all();
    for (const event of events) {
      if (event.data['state'] !== InboxState.Open && !closedAt.has(event.entityId))
        closedAt.set(event.entityId, Date.parse(event.at));
    }
  }
  const out = new Map<string, Span>();
  for (const card of cards) {
    const from = Date.parse(card.createdAt);
    const to =
      card.state === InboxState.Open
        ? nowMs
        : (closedAt.get(card.id) ?? Date.parse(card.updatedAt));
    if (from < to) out.set(card.id, { from, to });
  }
  return out;
}

/** The spans each workstream spent in `state`, from its state changes in order. */
function stateSpans(
  db: DbReader,
  ids: readonly string[],
  state: WorkstreamState,
  nowMs: number,
): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  if (ids.length === 0) return out;
  const events = db
    .select({ entityId: schema.events.entityId, data: schema.events.data, at: schema.events.at })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityType, 'workstream'),
        eq(schema.events.type, EventType.WorkstreamChanged),
        inArray(schema.events.entityId, [...ids]),
      ),
    )
    .orderBy(asc(schema.events.seq))
    .all();
  const since = new Map<string, number>();
  for (const event of events) {
    const at = Date.parse(event.at);
    const start = since.get(event.entityId);
    if (event.data['to'] === state) {
      if (start === undefined) since.set(event.entityId, at);
    } else if (start !== undefined) {
      since.delete(event.entityId);
      out.set(event.entityId, [...(out.get(event.entityId) ?? []), { from: start, to: at }]);
    }
  }
  for (const [id, start] of since)
    out.set(id, [...(out.get(id) ?? []), { from: start, to: nowMs }]);
  return out;
}

/**
 * When each workstream's failed run stopped being retryable: the first of its task being closed and
 * its batch finishing. A failure card can stay open after that, offering a Retry that would be refused.
 */
function retryEnds(db: DbReader, ids: readonly WorkstreamId[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = db
    .select({
      id: schema.workstreams.id,
      taskId: schema.workstreams.taskId,
      batchId: schema.workstreams.batchId,
    })
    .from(schema.workstreams)
    .where(inArray(schema.workstreams.id, [...ids]))
    .all();
  const events = db
    .select({ entityId: schema.events.entityId, data: schema.events.data, at: schema.events.at })
    .from(schema.events)
    .where(
      and(
        inArray(schema.events.type, [EventType.TaskChanged, EventType.BatchUpdated]),
        inArray(
          schema.events.entityId,
          rows.flatMap((r) => (r.batchId === null ? [r.taskId] : [r.taskId, r.batchId])),
        ),
      ),
    )
    .orderBy(asc(schema.events.seq))
    .all();
  const endedAt = new Map<string, number>();
  for (const event of events) {
    const ended =
      event.data['status'] === TaskStatus.Cancelled ||
      FINISHED_BATCH_STATES.some((state) => state === event.data['to']);
    if (ended && !endedAt.has(event.entityId)) endedAt.set(event.entityId, Date.parse(event.at));
  }
  for (const row of rows) {
    const ends = [endedAt.get(row.taskId), row.batchId ? endedAt.get(row.batchId) : undefined];
    const known = ends.filter((end) => end !== undefined);
    if (known.length > 0) out.set(row.id, Math.min(...known));
  }
  return out;
}

/**
 * Minutes per day of card time that fell inside a stretch the card's workstream was in `state`, up
 * to the workstream's time in `endsAt` when it has one.
 */
function minutesInState(
  db: DbReader,
  cards: readonly CardRow[],
  state: WorkstreamState,
  windowStart: number,
  nowMs: number,
  endsAt: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const spans = openSpans(db, cards, nowMs);
  const byWorkstream = new Map<string, Span[]>();
  for (const card of cards) {
    const span = spans.get(card.id);
    if (!span) continue;
    for (const workstreamId of cardWorkstreams(card))
      byWorkstream.set(workstreamId, [...(byWorkstream.get(workstreamId) ?? []), span]);
  }
  const blocked = stateSpans(db, [...byWorkstream.keys()], state, nowMs);
  const minutes = new Map<string, number>();
  for (const [workstreamId, open] of byWorkstream) {
    // Cards open together on one workstream count once.
    const inState = union(blocked.get(workstreamId) ?? []);
    const end = endsAt.get(workstreamId);
    const counted = end === undefined ? inState : intersect(inState, [{ from: 0, to: end }]);
    for (const span of intersect(union(open), counted)) {
      let from = Math.max(span.from, windowStart);
      while (from < span.to) {
        const dayEnd = Math.floor(from / DAY_MS) * DAY_MS + DAY_MS;
        const to = Math.min(span.to, dayEnd);
        minutes.set(dayKey(from), (minutes.get(dayKey(from)) ?? 0) + (to - from) / MINUTE_MS);
        from = to;
      }
    }
  }
  return minutes;
}

/** The tasks with a session running at some point of each day. */
function tasksRanByDay(
  db: DbReader,
  projectId: ProjectId,
  windowStart: number,
  windowEnd: number,
  nowMs: number,
): Map<string, Set<TaskId>> {
  const sessions = db
    .select({
      taskId: schema.workstreams.taskId,
      startedAt: schema.sessions.startedAt,
      endedAt: schema.sessions.endedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
    .where(
      and(
        eq(schema.workstreams.projectId, projectId),
        lt(schema.sessions.startedAt, new Date(windowEnd).toISOString()),
        or(
          isNull(schema.sessions.endedAt),
          gte(schema.sessions.endedAt, new Date(windowStart).toISOString()),
        ),
      ),
    )
    .all();
  const out = new Map<string, Set<TaskId>>();
  for (const session of sessions) {
    const from = Math.max(Date.parse(session.startedAt), windowStart);
    const to = Math.min(session.endedAt ? Date.parse(session.endedAt) : nowMs, windowEnd - 1);
    for (let day = Math.floor(from / DAY_MS) * DAY_MS; day <= to; day += DAY_MS) {
      const tasks = out.get(dayKey(day)) ?? new Set<TaskId>();
      tasks.add(session.taskId);
      out.set(dayKey(day), tasks);
    }
  }
  return out;
}

/**
 * The project's last {@link HUMAN_TOUCH_DAYS} UTC days, today first: the cards raised that day by kind
 * (a flag for a failed workstream counted apart from other flags), the cards per task that ran, and the
 * minutes work waited on an answer. A card adds waiting time only while the workstream it targets is
 * waiting on a person; one answered while the task kept running adds none. The time a failure card
 * sat open while its workstream was FAILED, waiting for a retry, is counted apart as `failedMinutes`,
 * until the run can no longer be retried.
 */
export function humanTouchDays(db: DbReader, projectId: ProjectId, now: Date): HumanTouchDayDto[] {
  const nowMs = now.getTime();
  const windowEnd = Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS;
  const windowStart = windowEnd - HUMAN_TOUCH_DAYS * DAY_MS;

  const cards = db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.projectId, projectId),
        lt(schema.inboxItems.createdAt, new Date(windowEnd).toISOString()),
        or(
          eq(schema.inboxItems.state, InboxState.Open),
          gte(schema.inboxItems.updatedAt, new Date(windowStart).toISOString()),
        ),
      ),
    )
    .all();

  const waiting = minutesInState(db, cards, WorkstreamState.WaitingHuman, windowStart, nowMs);
  // A failure card is the only card that says a failed run is waiting for someone to retry it.
  const failureCards = cards.filter((c) => isFailureCard(c));
  const failed = minutesInState(
    db,
    failureCards,
    WorkstreamState.Failed,
    windowStart,
    nowMs,
    retryEnds(
      db,
      failureCards.flatMap((c) => c.targets.map((t) => t.workstreamId)),
    ),
  );
  const ran = tasksRanByDay(db, projectId, windowStart, windowEnd, nowMs);

  const days: HumanTouchDayDto[] = [];
  for (let i = 0; i < HUMAN_TOUCH_DAYS; i += 1) {
    const day = dayKey(windowEnd - (i + 1) * DAY_MS);
    const raised = cards.filter((c) => dayKey(Date.parse(c.createdAt)) === day);
    const count = (kind: InboxKind, failed?: boolean): number =>
      raised.filter((c) => c.kind === kind && (failed === undefined || isFailureCard(c) === failed))
        .length;
    const tasksRan = ran.get(day)?.size ?? 0;
    const total = raised.length;
    days.push({
      day,
      permission: count(InboxKind.Permission),
      question: count(InboxKind.Question),
      workstreamFailed: count(InboxKind.Flag, true),
      flag: count(InboxKind.Flag, false),
      proposal: count(InboxKind.Proposal),
      review: count(InboxKind.Review),
      check: count(InboxKind.Check),
      cards: total,
      tasksRan,
      cardsPerTask: tasksRan === 0 ? null : total / tasksRan,
      waitingMinutes: waiting.get(day) ?? 0,
      failedMinutes: failed.get(day) ?? 0,
    });
  }
  return days;
}
