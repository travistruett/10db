import {
  ConflictError,
  DEFAULT_BOARD_COLUMN,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  ProjectInput,
  ProjectPatch,
  Provider,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import { insertBoardColumn } from './board-columns';
import { getFlow } from './flows';
import type { DbReader, WriteContext } from './store';

export function insertProject(ctx: WriteContext, input: ProjectInput): ProjectDto {
  const config = ProjectInput.parse(input);
  if (config.flowId) getFlow(ctx.tx, config.flowId);
  const existing = ctx.tx
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.repoPath, config.repoPath))
    .get();
  if (existing)
    throw new ConflictError(`Project "${existing.name}" already uses ${config.repoPath}`);
  const row: ProjectDto = {
    id: mintId('Project'),
    ...config,
    provider: Provider.Claude,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.projects).values(row).run();
  ctx.emit({ type: EventType.ProjectCreated, entityType: 'project', entityId: row.id });
  insertBoardColumn(ctx, row.id, { name: DEFAULT_BOARD_COLUMN });
  return row;
}

export function getProject(db: DbReader, id: ProjectDto['id']): ProjectDto {
  const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!row) throw new NotFoundError('project', id);
  return row;
}

export function listProjects(db: DbReader): ProjectDto[] {
  return db.select().from(schema.projects).orderBy(asc(schema.projects.name)).all();
}

export function patchProject(ctx: WriteContext, id: ProjectId, patch: ProjectPatch): ProjectDto {
  const changes = ProjectPatch.parse(patch);
  // A stale flow id answers 404, not a foreign-key failure.
  if (changes.flowId) getFlow(ctx.tx, changes.flowId);
  const current = getProject(ctx.tx, id);
  const nudgePct = changes.nudgePct ?? current.nudgePct;
  const handoffPct = changes.handoffPct ?? current.handoffPct;
  if (nudgePct <= handoffPct) throw new InvalidError('nudgePct must be above handoffPct');
  ctx.tx
    .update(schema.projects)
    .set({ ...changes, updatedAt: ctx.now })
    .where(eq(schema.projects.id, id))
    .run();
  ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: id });
  return getProject(ctx.tx, id);
}
