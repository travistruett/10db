import {
  EventType,
  mintId,
  NotFoundError,
  type HandoffDto,
  type HandoffId,
  type HandoffInput,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface NewHandoff {
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly content: HandoffInput;
  readonly gitHead: string;
  readonly gitChangedFiles: readonly string[];
  readonly gitCommits: readonly string[];
}

export function insertHandoff(ctx: WriteContext, input: NewHandoff): HandoffDto {
  const row: HandoffDto = {
    id: mintId('Handoff'),
    ...input,
    gitChangedFiles: [...input.gitChangedFiles],
    gitCommits: [...input.gitCommits],
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.handoffs).values(row).run();
  ctx.emit({
    type: EventType.HandoffRecorded,
    entityType: 'handoff',
    entityId: row.id,
    data: { workstreamId: input.workstreamId, sessionId: input.sessionId },
  });
  return row;
}

export function getHandoff(db: DbReader, id: HandoffId): HandoffDto {
  const row = db.select().from(schema.handoffs).where(eq(schema.handoffs.id, id)).get();
  if (!row) throw new NotFoundError('handoff', id);
  return row;
}

export function latestHandoff(db: DbReader, workstreamId: WorkstreamId): HandoffDto | null {
  return (
    db
      .select()
      .from(schema.handoffs)
      .where(eq(schema.handoffs.workstreamId, workstreamId))
      .orderBy(desc(schema.handoffs.createdAt), desc(schema.handoffs.id))
      .limit(1)
      .get() ?? null
  );
}

export function handoffForSession(db: DbReader, sessionId: SessionId): HandoffDto | null {
  return (
    db
      .select()
      .from(schema.handoffs)
      .where(eq(schema.handoffs.sessionId, sessionId))
      .orderBy(desc(schema.handoffs.id))
      .limit(1)
      .get() ?? null
  );
}
