import {
  InboxKind,
  isNoisyWatchpoint,
  EvidenceKind,
  StoredWatchpointDetail,
  WatchpointCardDetail,
  WatchpointChoice,
  type ProjectId,
  type WatchpointStatsDto,
} from '@10db/contracts';
import { and, eq, gte, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

/**
 * What each watchpoint did to the project in the last 30 days: the tasks whose newest reading hit it, the Look
 * cards that named it and those waved through (answered Looks right with no note). A watchpoint with no task and no
 * card in the window is left out.
 */
export function watchpointStats(
  db: DbReader,
  projectId: ProjectId,
  now: Date,
): WatchpointStatsDto[] {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const counts = new Map<string, { tasks: number; cards: number; waved: number }>();
  const of = (key: string): { tasks: number; cards: number; waved: number } => {
    const found = counts.get(key) ?? { tasks: 0, cards: 0, waved: 0 };
    counts.set(key, found);
    return found;
  };

  const readings = db
    .select({ detail: schema.evidence.detail })
    .from(schema.evidence)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.evidence.workstreamId))
    .where(
      and(
        eq(schema.workstreams.projectId, projectId),
        eq(schema.evidence.kind, EvidenceKind.Watchpoint),
        gte(schema.evidence.createdAt, since),
        sql`${schema.evidence.id} = (SELECT max(e2.id) FROM evidence e2
          WHERE e2.workstream_id = ${schema.evidence.workstreamId} AND e2.kind = ${EvidenceKind.Watchpoint})`,
      ),
    )
    .all();
  for (const row of readings) {
    const detail = StoredWatchpointDetail.parse(row.detail);
    for (const hit of detail.hits) of(hit.watchpoint.key).tasks += 1;
  }

  const cards = db
    .select({ detail: schema.inboxItems.detail, answer: schema.inboxItems.answer })
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.projectId, projectId),
        eq(schema.inboxItems.kind, InboxKind.Watchpoint),
        gte(schema.inboxItems.createdAt, since),
      ),
    )
    .all();
  for (const card of cards) {
    const detail = WatchpointCardDetail.safeParse(card.detail);
    if (!detail.success) continue;
    const waved =
      card.answer?.choice === WatchpointChoice.LooksRight && (card.answer.note ?? '').trim() === '';
    for (const { key } of detail.data.watchpoints) {
      const counted = of(key);
      counted.cards += 1;
      if (waved) counted.waved += 1;
    }
  }

  return [...counts.entries()]
    .map(([key, c]) => ({ key, ...c, noisy: isNoisyWatchpoint(c) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
