import {
  EventType,
  HUMAN_TOUCH_DAYS,
  InboxKind,
  InboxState,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamState,
  type HumanTouchDayDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

// How often a person was needed, per UTC day, computed from the inbox rows and the event log. Nothing
// is stored: the figures are recomputed on each read.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

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
  'id' | 'state' | 'createdAt' | 'updatedAt' | 'targets'
>;

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

/** The spans each workstream spent waiting on a person, from its state changes in order. */
function blockedSpans(db: DbReader, ids: readonly string[], nowMs: number): Map<string, Span[]> {
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
    if (event.data['to'] === WorkstreamState.WaitingHuman) {
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

/** Minutes of waiting per day: card time that fell inside a stretch the card's workstream was blocked. */
function waitingByDay(
  db: DbReader,
  cards: readonly CardRow[],
  windowStart: number,
  nowMs: number,
): Map<string, number> {
  const spans = openSpans(db, cards, nowMs);
  const byWorkstream = new Map<string, Span[]>();
  for (const card of cards) {
    const span = spans.get(card.id);
    if (!span) continue;
    for (const target of card.targets)
      byWorkstream.set(target.workstreamId, [
        ...(byWorkstream.get(target.workstreamId) ?? []),
        span,
      ]);
  }
  const blocked = blockedSpans(db, [...byWorkstream.keys()], nowMs);
  const minutes = new Map<string, number>();
  for (const [workstreamId, open] of byWorkstream) {
    // Cards open together on one workstream count once.
    const waited = intersect(union(open), union(blocked.get(workstreamId) ?? []));
    for (const span of waited) {
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
 * waiting on a person; one answered while the task kept running adds none.
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

  const waiting = waitingByDay(db, cards, windowStart, nowMs);
  const ran = tasksRanByDay(db, projectId, windowStart, windowEnd, nowMs);

  const days: HumanTouchDayDto[] = [];
  for (let i = 0; i < HUMAN_TOUCH_DAYS; i += 1) {
    const day = dayKey(windowEnd - (i + 1) * DAY_MS);
    const raised = cards.filter((c) => dayKey(Date.parse(c.createdAt)) === day);
    const count = (kind: InboxKind, failed?: boolean): number =>
      raised.filter(
        (c) =>
          c.kind === kind &&
          (failed === undefined || c.title.startsWith(WORKSTREAM_FAILED_TITLE_PREFIX) === failed),
      ).length;
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
    });
  }
  return days;
}
