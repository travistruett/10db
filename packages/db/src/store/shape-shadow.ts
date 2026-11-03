import type {
  JudgeCallId,
  ProjectId,
  ShapeId,
  ShapeJudgeDecision,
  ShapeMessageId,
} from '@10db/contracts';
import * as schema from '../schema';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

// Shape spec §9: the per-project opt-in for Jev's Shape decisions, and their shadow answers.

const optInKey = (projectId: ProjectId): string => `shape.jev.${projectId}`;

/** "Send brainstorm messages to fast models": off for every project until the builder turns it on. */
export function getShapeJevOptIn(db: DbReader, projectId: ProjectId): boolean {
  return getAppSetting(db, optInKey(projectId)) === true;
}

export function setShapeJevOptIn(ctx: WriteContext, projectId: ProjectId, enabled: boolean): void {
  setAppSetting(ctx, optInKey(projectId), enabled);
}

export interface NewShadowAnswer {
  readonly shapeId: ShapeId;
  readonly messageId: ShapeMessageId;
  readonly decision: ShapeJudgeDecision;
  readonly answer: 'yes' | 'no';
  readonly confidence: number;
  readonly judgeCallId: JudgeCallId;
}

/** Logs one shadow answer; a second for the same message and decision changes nothing. */
export function insertShadowAnswer(ctx: WriteContext, input: NewShadowAnswer): void {
  ctx.tx
    .insert(schema.shapeShadowAnswers)
    .values({ ...input, createdAt: ctx.now })
    .onConflictDoNothing()
    .run();
}

export type ShadowAnswerRow = typeof schema.shapeShadowAnswers.$inferSelect;

export function listShadowAnswers(db: DbReader): ShadowAnswerRow[] {
  return db.select().from(schema.shapeShadowAnswers).all();
}
