import {
  EvidenceKind,
  InboxKind,
  InboxState,
  type InboxItemId,
  type ProjectId,
  type RecordedAnswer,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

/** A watchpoint reading that holds a read kept in shadow, as stored: its detail is the caller's to parse. */
export interface ShadowReadingRow {
  readonly workstreamId: WorkstreamId;
  readonly detail: unknown;
  readonly createdAt: string;
}

/** An answered Look card, with the workstream it targets. */
export interface AnsweredLookRow {
  readonly id: InboxItemId;
  readonly workstreamId: WorkstreamId;
  readonly detail: unknown;
  readonly answer: RecordedAnswer;
  readonly answeredAt: string;
}

/** The marker a read stored in shadow carries; a reading with none holds no read to score. */
const SHADOW_MARK = '%"acted":false%';

/**
 * Every watchpoint reading whose detail holds a read with `acted` false, oldest first, for one project or for
 * every project. A reading is one evidence row; a workstream has one per run.
 */
export function shadowReadingRows(db: DbReader, projectId: ProjectId | null): ShadowReadingRow[] {
  return db
    .select({
      workstreamId: schema.evidence.workstreamId,
      detail: schema.evidence.detail,
      createdAt: schema.evidence.createdAt,
    })
    .from(schema.evidence)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.evidence.workstreamId))
    .where(
      and(
        eq(schema.evidence.kind, EvidenceKind.Watchpoint),
        like(schema.evidence.detail, SHADOW_MARK),
        projectId === null ? undefined : eq(schema.workstreams.projectId, projectId),
      ),
    )
    .orderBy(asc(schema.evidence.id))
    .all();
}

/**
 * Every Look card the builder answered, oldest first, one row per workstream the card targets. A card 10db withdrew
 * has no answer and is left out.
 */
export function answeredLookRows(db: DbReader, projectId: ProjectId | null): AnsweredLookRow[] {
  return db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.kind, InboxKind.Watchpoint),
        inArray(schema.inboxItems.state, [
          InboxState.Answered,
          InboxState.Delivering,
          InboxState.Resolved,
        ]),
        projectId === null ? undefined : eq(schema.inboxItems.projectId, projectId),
      ),
    )
    .orderBy(asc(schema.inboxItems.createdAt), asc(schema.inboxItems.id))
    .all()
    .flatMap((row) => {
      const answer = row.answer;
      if (answer === null) return [];
      return row.targets.map((target) => ({
        id: row.id,
        workstreamId: target.workstreamId,
        detail: row.detail,
        answer,
        answeredAt: row.updatedAt,
      }));
    });
}
