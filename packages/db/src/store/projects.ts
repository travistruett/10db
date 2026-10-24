import {
  ACTIVE_STATES,
  ConflictError,
  DEFAULT_BOARD_COLUMN,
  Delivery,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  ProjectInput,
  ProjectPatch,
  Provider,
  type AccountId,
  type ProjectDto,
  type ProjectId,
  type ProjectViewDto,
} from '@10db/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import { defaultAccountId, getAccountRow } from './accounts';
import { currentBatch, findUnfinishedBatch } from './batches';
import { insertBoardColumn } from './board-columns';
import { getFlow } from './flows';
import type { DbReader, WriteContext } from './store';

/** The account a new project binds to: the one it names, else the default; never an archived one. */
function accountFor(ctx: WriteContext, named: AccountId | undefined): AccountId {
  const id = named ?? defaultAccountId(ctx.tx);
  if (!id) throw new InvalidError('There is no account to bind the project to; create one first');
  const account = getAccountRow(ctx.tx, id);
  if (account.archived) throw new InvalidError(`Account "${account.label}" is archived`);
  return id;
}

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
  const { accountId: named, ...rest } = config;
  const row: ProjectDto = {
    id: mintId('Project'),
    ...rest,
    accountId: accountFor(ctx, named),
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
  if (changes.delivery !== undefined && changes.delivery !== current.delivery) {
    // A QUEUED pull-request workstream needs a batch to launch, so delivery can't change under work.
    const busy = ctx.tx
      .select({ id: schema.workstreams.id })
      .from(schema.workstreams)
      .where(
        and(
          eq(schema.workstreams.projectId, id),
          inArray(schema.workstreams.state, [...ACTIVE_STATES]),
        ),
      )
      .get();
    if (busy || findUnfinishedBatch(ctx.tx, id))
      throw new ConflictError(
        `${current.name} has unfinished work; finish or cancel it before changing its delivery`,
      );
  }
  const delivery = changes.delivery ?? current.delivery;
  const prefix =
    changes.prTitlePrefix === undefined ? current.prTitlePrefix : changes.prTitlePrefix;
  if (delivery === Delivery.PullRequest && prefix === null)
    throw new InvalidError('Pull request delivery needs a PR title prefix such as feat(app)');
  if (changes.accountId !== undefined && changes.accountId !== current.accountId) {
    // Work in flight moves too: each lane's next session runs on the new account.
    const account = getAccountRow(ctx.tx, changes.accountId);
    if (account.archived) throw new InvalidError(`Account "${account.label}" is archived`);
  }
  ctx.tx
    .update(schema.projects)
    .set({ ...changes, updatedAt: ctx.now })
    .where(eq(schema.projects.id, id))
    .run();
  ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: id });
  return getProject(ctx.tx, id);
}

/** `GET /projects`: each project with the batch its view shows. */
export function listProjectViews(db: DbReader): ProjectViewDto[] {
  return listProjects(db).map((p) => ({ ...p, currentBatch: currentBatch(db, p.id) }));
}
