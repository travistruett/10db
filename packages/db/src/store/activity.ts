import {
  EventType,
  NoticePostedData,
  type ActivityPageDto,
  type ActivityPageQuery,
  type DecisionRule,
  type ProjectId,
} from '@10db/contracts';
import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import { groupNotices, type PostedNotice } from './activity-group';
import { ofActiveProject } from './projects';
import { askingRules, undoneRows } from './rule-asking';
import type { DbReader } from './store';

const events = schema.events;

/** `%`, `_` and `\` in a search are literal, under `ESCAPE '\'`. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function filterOf(q: ActivityPageQuery): SQL[] {
  const where: SQL[] = [eq(events.type, EventType.NoticePosted)];
  if (q.task !== undefined) {
    where.push(eq(events.entityType, 'task'), eq(events.entityId, q.task));
  } else if (q.project !== undefined) {
    where.push(
      sql`((${events.entityType} = 'project' AND ${events.entityId} = ${q.project})
        OR (${events.entityType} = 'task' AND ${events.entityId} IN
          (SELECT ${schema.tasks.id} FROM ${schema.tasks} WHERE ${schema.tasks.projectId} = ${q.project})))`,
    );
  } else {
    // The all-projects list leaves out an archived project's notices and its tasks'.
    where.push(
      sql`NOT ((${events.entityType} = 'project' AND ${events.entityId} IN
          (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${schema.projects.archivedAt} IS NOT NULL))
        OR (${events.entityType} = 'task' AND ${events.entityId} IN
          (SELECT ${schema.tasks.id} FROM ${schema.tasks} WHERE NOT ${ofActiveProject(schema.tasks.projectId)})))`,
    );
  }
  if (q.decided !== undefined)
    where.push(sql`json_extract(${events.data}, '$.decision') IS NOT NULL`);
  if (q.q !== undefined) {
    const pattern = likePattern(q.q);
    where.push(
      sql`(json_extract(${events.data}, '$.line') LIKE ${pattern} ESCAPE '\\'
        OR json_extract(${events.data}, '$.body') LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  return where;
}

/**
 * One page of Activity: notice.posted events, newest seq first, folded into rows by `groupNotices`.
 * It reads chunks until the page is full or the log runs out. A notice whose data doesn't parse is
 * skipped. A burst that interleaves with another key across a page boundary can split into two rows;
 * that is accepted.
 */
export function pageActivity(db: DbReader, q: ActivityPageQuery): ActivityPageDto {
  const page = pageNotices(db, q);
  const undone = undoneRows(db);
  const asking = new Map<ProjectId, ReadonlySet<DecisionRule>>();
  return {
    ...page,
    rows: page.rows.map((row) => {
      if (row.decision === undefined) return row;
      const { projectId } = row;
      let rules = projectId === null ? undefined : asking.get(projectId);
      if (projectId !== null && rules === undefined) {
        rules = askingRules(db, projectId);
        asking.set(projectId, rules);
      }
      return {
        ...row,
        asking: rules?.has(row.decision.rule) ?? false,
        undone: undone.has(row.seq),
      };
    }),
  };
}

/** The notice.posted event with this seq, or null when it is not one. */
export function getPostedNotice(db: DbReader, seq: number): PostedNotice | null {
  const row = db
    .select({ seq: events.seq, at: events.at, data: events.data })
    .from(events)
    .where(and(eq(events.seq, seq), eq(events.type, EventType.NoticePosted)))
    .get();
  if (row === undefined) return null;
  const data = NoticePostedData.safeParse(row.data);
  return data.success ? { seq: row.seq, at: row.at, data: data.data } : null;
}

function pageNotices(db: DbReader, q: ActivityPageQuery): ActivityPageDto {
  const chunkSize = Math.max(100, 4 * q.pageSize);
  const where = filterOf(q);
  let below = q.after;
  const notices: PostedNotice[] = [];
  for (;;) {
    const chunk = db
      .select({ seq: events.seq, at: events.at, data: events.data })
      .from(events)
      .where(and(...where, below === undefined ? undefined : lt(events.seq, below)))
      .orderBy(desc(events.seq))
      .limit(chunkSize)
      .all();
    for (const row of chunk) {
      const data = NoticePostedData.safeParse(row.data);
      if (data.success) notices.push({ seq: row.seq, at: row.at, data: data.data });
    }
    const grouped = groupNotices(notices, q.pageSize);
    const last = chunk.at(-1);
    if (grouped.full) {
      const lastConsumed = notices[grouped.consumed - 1];
      return { rows: grouped.rows, next: lastConsumed?.seq ?? null };
    }
    if (chunk.length < chunkSize || last === undefined) return { rows: grouped.rows, next: null };
    below = last.seq;
  }
}

/** Whether a project has a notice with this key posted under it: the marker a one-time notice leaves. */
export function hasNoticeKey(db: DbReader, projectId: ProjectId, key: string): boolean {
  return (
    db
      .select({ seq: events.seq })
      .from(events)
      .where(
        and(
          eq(events.entityType, 'project'),
          eq(events.entityId, projectId),
          eq(events.type, EventType.NoticePosted),
          sql`json_extract(${events.data}, '$.key') = ${key}`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}
