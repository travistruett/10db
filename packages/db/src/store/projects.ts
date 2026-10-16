import {
  ConflictError,
  EventType,
  mintId,
  NotFoundError,
  ProjectInput,
  Provider,
  type ProjectDto,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export function insertProject(ctx: WriteContext, input: ProjectInput): ProjectDto {
  const config = ProjectInput.parse(input);
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
