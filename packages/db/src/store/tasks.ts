import {
  ACTIVE_STATES,
  BatchState,
  BoardStatus,
  columnNameKey,
  ConflictError,
  DEFAULT_BOARD_COLUMN,
  Delivery,
  EventType,
  InvalidError,
  isTerminal,
  mintId,
  NotFoundError,
  parseFindings,
  PullRequestState,
  TaskInput,
  TaskHasDependentsError,
  TaskMove,
  TaskPatch,
  TaskStartedError,
  TaskStatus,
  taskLandingFor,
  Title,
  WorkstreamId,
  WorkstreamState,
  type BoardColumnId,
  type CiStopped,
  WorkspaceMode,
  type ProjectDto,
  type ProjectId,
  type ProposalId,
  type TaskConfig,
  type TaskDto,
  type TaskId,
  type TaskLanding,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, max, ne } from 'drizzle-orm';
import * as schema from '../schema';
import { getBoardColumn, listBoardColumns } from './board-columns';
import { getFlow } from './flows';
import { getProposal } from './knowledge';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { transitionWorkstream } from './workstreams';

export interface BoardStatusInput {
  readonly taskStatus: TaskStatus;
  readonly depsDone: boolean;
  readonly workstreamState: WorkstreamState | null;
  /** The state of the batch the task's latest run ships in; null when it is in none. */
  readonly batchState?: BatchState | null;
  /** That batch's pull request: its url, and the state last read (null before the first read). */
  readonly pullRequest?: {
    readonly url: string | null;
    readonly state: PullRequestState | null;
    /** Why 10db stopped fixing its failing required checks; null or absent while it has not. */
    readonly ciStopped?: CiStopped | null;
  } | null;
}

/**
 * Board column for a task (spec §5.1): Ready means deps done and nothing blocking. A finished task
 * is not Done until its pull request has merged: while its batch ships it is In progress, once the
 * pull request is open it is In review, and when the ship failed, or the pull request closed
 * without merging, it is Blocked, where the builder decides. An open pull request whose CI fixes
 * stopped is Blocked too (CI-decides spec §4).
 */
export function deriveBoardStatus({
  taskStatus,
  depsDone,
  workstreamState,
  batchState = null,
  pullRequest = null,
}: BoardStatusInput): BoardStatus {
  const column =
    batchState === BatchState.Shipped && pullRequest?.url
      ? pullRequestColumn(pullRequest.state)
      : null;
  const shipped =
    column === BoardStatus.InReview && (pullRequest?.ciStopped ?? null) !== null
      ? BoardStatus.Blocked
      : column;
  switch (taskStatus) {
    case TaskStatus.Done:
      if (batchState === BatchState.Shipping) return BoardStatus.InProgress;
      if (batchState === BatchState.Failed) return BoardStatus.Blocked;
      return shipped ?? BoardStatus.Done;
    case TaskStatus.Cancelled:
      return BoardStatus.Done;
    case TaskStatus.Open:
      // A run marked failed but shipped anyway is judged by its pull request like a finished one.
      if (workstreamState === WorkstreamState.Failed && shipped) return shipped;
      break;
  }
  if (
    workstreamState === WorkstreamState.WaitingHuman ||
    workstreamState === WorkstreamState.PausedLimit ||
    workstreamState === WorkstreamState.Held ||
    workstreamState === WorkstreamState.Failed
  ) {
    return BoardStatus.Blocked;
  }
  if (workstreamState !== null && !isTerminal(workstreamState)) return BoardStatus.InProgress;
  return depsDone ? BoardStatus.Ready : BoardStatus.Backlog;
}

/** Where a shipped pull request puts its tasks; one not yet read, or unreadable, is still open. */
function pullRequestColumn(state: PullRequestState | null): BoardStatus {
  switch (state) {
    case PullRequestState.Merged:
      return BoardStatus.Done;
    case PullRequestState.Closed:
      return BoardStatus.Blocked;
    case PullRequestState.Open:
    case PullRequestState.Unknown:
    case null:
      return BoardStatus.InReview;
  }
}

/** The two columns that hold a task's landing. */
function landingColumns(landing: TaskLanding): {
  landing: TaskLanding['kind'];
  landingBranch: string | null;
} {
  return {
    landing: landing.kind,
    landingBranch: landing.kind === 'branch' ? landing.branch : null,
  };
}

function landingOf(row: {
  landing: TaskLanding['kind'];
  landingBranch: string | null;
}): TaskLanding {
  switch (row.landing) {
    case 'hold':
      return { kind: 'hold' };
    case 'branch':
      return row.landingBranch === null
        ? { kind: 'base' }
        : { kind: 'branch', branch: row.landingBranch };
    case 'base':
      return { kind: 'base' };
  }
}

export function insertTask(ctx: WriteContext, projectId: ProjectId, input: TaskInput): TaskDto {
  const project = getProject(ctx.tx, projectId);
  const config = TaskInput.parse(input);
  if (config.flowId) getFlow(ctx.tx, config.flowId);
  const known = new Set([
    ...project.areas.map((a) => a.name),
    ...project.hazards.map((h) => h.name),
  ]);
  const unknown = config.areas.filter((a) => !known.has(a));
  if (unknown.length > 0)
    throw new InvalidError(`Unknown areas for project ${project.name}: ${unknown.join(', ')}`);
  if (config.dependsOn.length > 0) {
    const deps = ctx.tx
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        status: schema.tasks.status,
      })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, config.dependsOn))
      .all();
    if (deps.length !== config.dependsOn.length || deps.some((d) => d.projectId !== projectId)) {
      throw new InvalidError('Every dependency must be an existing task in the same project');
    }
    if (deps.some((d) => d.status === TaskStatus.Cancelled))
      throw new InvalidError('A removed task cannot be a dependency');
  }
  return writeTask(ctx, projectId, {
    ...config,
    landing: config.landing ?? taskLandingFor(project),
    workspaceMode: placementFor(project, config.workspaceMode),
    proposalId: null,
  });
}

const NO_COPY_WITHOUT_PULL_REQUESTS =
  'A separate copy needs pull request delivery; in this project every task works in your folder';

/**
 * Where a new task works: the placement it names, else the project's default. Only a project that
 * delivers by pull request has separate copies, so a local one refuses a copy (task placement spec, P1).
 */
function placementFor(project: ProjectDto, named: WorkspaceMode | undefined): WorkspaceMode {
  if (project.delivery !== Delivery.PullRequest) {
    if (named === WorkspaceMode.Worktree) throw new InvalidError(NO_COPY_WITHOUT_PULL_REQUESTS);
    return WorkspaceMode.Shared;
  }
  return named ?? project.workspaceMode;
}

/**
 * The areas a task filed from a proposal works in: those of the task whose session raised it, else
 * the project's only area. Empty when neither says (several areas and no raising task), and then the
 * task can't start until the builder names them.
 */
function areasForProposal(
  tx: DbReader,
  proposalId: ProposalId,
  project: ProjectDto,
): readonly string[] {
  const proposal = getProposal(tx, proposalId);
  const source = tx
    .select({ ref: schema.sources.ref })
    .from(schema.sources)
    .where(eq(schema.sources.id, proposal.sourceId))
    .get();
  const workstreamId = WorkstreamId.safeParse(source?.ref['workstreamId']);
  if (workstreamId.success) {
    const raiser = tx
      .select({ areas: schema.tasks.areas })
      .from(schema.workstreams)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
      .where(eq(schema.workstreams.id, workstreamId.data))
      .get();
    if (raiser && raiser.areas.length > 0) return raiser.areas;
  }
  const [only, ...others] = project.areas;
  return only && others.length === 0 ? [only.name] : [];
}

/**
 * Files an accepted new-task proposal as an open task linked to it. The proposal names no acceptance
 * criteria, so the task starts with none; its title meets the same rule as a task made by hand. Its
 * areas come from the task that raised it, or the project's only area (`areasForProposal`).
 */
export function insertTaskFromProposal(
  ctx: WriteContext,
  input: {
    readonly proposalId: ProposalId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly description: string;
  },
): TaskDto {
  const project = getProject(ctx.tx, input.projectId);
  return writeTask(ctx, input.projectId, {
    landing: taskLandingFor(project),
    workspaceMode: placementFor(project, undefined),
    title: Title.parse(input.title),
    description: input.description,
    acceptanceCriteria: [],
    areas: [...areasForProposal(ctx.tx, input.proposalId, project)],
    dependsOn: [],
    riskTags: [],
    flowId: null,
    proposalId: input.proposalId,
  });
}

/** What a step hands over for a follow-up task: the rest comes from the task it was found in. */
export interface FollowUpFields {
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria?: readonly string[];
}

/**
 * Files a follow-up found while a step checked `sourceId`: an open task in the same project, parked
 * in the Icebox column (the project's first column when the builder renamed it, the derived board
 * when it has none), landing where the source lands and touching the same areas. Its description
 * names the source. It depends on nothing, so it never holds the source up.
 */
export function insertFollowUpTask(
  ctx: WriteContext,
  sourceId: TaskId,
  fields: FollowUpFields,
): TaskDto {
  const source = getTask(ctx.tx, sourceId);
  const iceboxKey = columnNameKey(DEFAULT_BOARD_COLUMN);
  const columns = listBoardColumns(ctx.tx, source.projectId);
  const icebox = columns.find((c) => columnNameKey(c.name) === iceboxKey) ?? columns[0];
  const origin = `Found while checking the task "${source.title}" (${source.id}).`;
  return writeTask(ctx, source.projectId, {
    landing: source.landing,
    workspaceMode: placementFor(getProject(ctx.tx, source.projectId), undefined),
    title: Title.parse(fields.title),
    description: `${origin}\n\n${fields.description}`,
    acceptanceCriteria: [...(fields.acceptanceCriteria ?? [])],
    areas: source.areas,
    dependsOn: [],
    riskTags: [],
    flowId: null,
    proposalId: null,
    boardColumnId: icebox?.id ?? null,
  });
}

/** What a step that rejected the work at the retry limit hands over: who it was and its notes. */
export interface RetryLimitFindings {
  /** The role that rejected, as a person reads it: "review" or "QA". */
  readonly role: string;
  /** The rejection's own notes, without any follow-up list 10db appended. */
  readonly notes: string;
}

const LIMIT_TITLE_PREFIX = 'Resolve the open findings of ';
const TITLE_MAX = 200;

/**
 * Files the findings of a rejection that used up the retry limit, for a task that shipped with them
 * open: a task in the project's Ready column (planned, no human column), landing where the source
 * landed and touching the same areas, with one acceptance criterion per finding. Its description
 * names the source. It depends on nothing, so it never holds the source up.
 */
export function insertRetryLimitFollowUp(
  ctx: WriteContext,
  sourceId: TaskId,
  found: RetryLimitFindings,
): TaskDto {
  const source = getTask(ctx.tx, sourceId);
  const findings = parseFindings(found.notes);
  const quoted = `"${source.title}"`;
  const title = `${LIMIT_TITLE_PREFIX}${quoted}`;
  return writeTask(ctx, source.projectId, {
    landing: source.landing,
    workspaceMode: placementFor(getProject(ctx.tx, source.projectId), undefined),
    // Cut by characters, so the title stays one line within its limit however long the source's is.
    title: Title.parse(title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title),
    description: [
      `The task ${quoted} (${source.id}) shipped at the retry limit: the ${found.role} step still rejected the work. These findings are open:`,
      found.notes,
    ].join('\n\n'),
    acceptanceCriteria:
      findings.length > 0
        ? findings.map((f) => `Fixed: ${f.text}`)
        : ['The findings in the description are fixed'],
    areas: source.areas,
    dependsOn: [],
    riskTags: [],
    flowId: null,
    proposalId: null,
    boardColumnId: null,
  });
}

/** Writes a task the caller has already validated, at the end of the board, and announces it with its proposal, if any. */
function writeTask(
  ctx: WriteContext,
  projectId: ProjectId,
  config: Omit<TaskConfig, 'landing' | 'workspaceMode'> & {
    readonly landing: TaskLanding;
    readonly workspaceMode: WorkspaceMode;
    readonly proposalId: ProposalId | null;
    /** The human column to park the task in; absent, it is planned. */
    readonly boardColumnId?: BoardColumnId | null;
  },
): TaskDto {
  const order = ctx.tx
    .select({ value: max(schema.tasks.boardOrder) })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .get();
  const row = {
    id: mintId('Task'),
    projectId,
    title: config.title,
    description: config.description,
    acceptanceCriteria: config.acceptanceCriteria,
    areas: config.areas,
    riskTags: config.riskTags,
    flowId: config.flowId,
    proposalId: config.proposalId,
    ...landingColumns(config.landing),
    status: TaskStatus.Open,
    boardOrder: (order?.value ?? 0) + 1,
    boardColumnId: config.boardColumnId ?? null,
    workspaceMode: config.workspaceMode,
    placementReason: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.tasks).values(row).run();
  for (const dependsOnId of config.dependsOn)
    ctx.tx.insert(schema.taskDeps).values({ taskId: row.id, dependsOnId }).run();
  ctx.emit({
    type: EventType.TaskCreated,
    entityType: 'task',
    entityId: row.id,
    data: { projectId, proposalId: config.proposalId },
  });
  return getTask(ctx.tx, row.id);
}

export function setTaskStatus(ctx: WriteContext, id: TaskId, status: TaskStatus): void {
  const result = ctx.tx
    .update(schema.tasks)
    .set({ status, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  if (result.changes === 0) throw new NotFoundError('task', id);
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id, data: { status } });
}

/**
 * Whether every dependency is done: finished, or an open task whose failed run shipped anyway and
 * whose pull request has merged.
 */
export function dependenciesDone(db: DbReader, taskId: TaskId): boolean {
  const pending = db
    .select({ id: schema.tasks.id })
    .from(schema.taskDeps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDeps.dependsOnId))
    .where(and(eq(schema.taskDeps.taskId, taskId), ne(schema.tasks.status, TaskStatus.Done)))
    .all();
  return pending.every(({ id }) => mergedDespiteFailure(db, id));
}

/** Whether the task's latest run failed but shipped anyway, and its pull request has merged. */
export function mergedDespiteFailure(db: DbReader, taskId: TaskId): boolean {
  const latest = db
    .select({
      state: schema.workstreams.state,
      batchState: schema.batches.state,
      prState: schema.batches.prState,
    })
    .from(schema.workstreams)
    .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    .where(eq(schema.workstreams.taskId, taskId))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
  return (
    latest?.state === WorkstreamState.Failed &&
    latest.batchState === BatchState.Shipped &&
    latest.prState === PullRequestState.Merged
  );
}

function toTaskDto(db: DbReader, row: typeof schema.tasks.$inferSelect): TaskDto {
  const deps = db
    .select({ id: schema.taskDeps.dependsOnId })
    .from(schema.taskDeps)
    .where(eq(schema.taskDeps.taskId, row.id))
    .all();
  const latest = db
    .select({
      id: schema.workstreams.id,
      state: schema.workstreams.state,
      batchState: schema.batches.state,
      prUrl: schema.batches.prUrl,
      prState: schema.batches.prState,
      ciStopped: schema.batches.ciStopped,
    })
    .from(schema.workstreams)
    .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    .where(eq(schema.workstreams.taskId, row.id))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    areas: row.areas,
    riskTags: row.riskTags,
    flowId: row.flowId,
    landing: landingOf(row),
    workspaceMode: row.workspaceMode,
    placementReason: row.placementReason,
    status: row.status,
    boardOrder: row.boardOrder,
    boardColumnId: row.boardColumnId,
    dependsOn: deps.map((d) => d.id),
    boardStatus: deriveBoardStatus({
      taskStatus: row.status,
      depsDone: dependenciesDone(db, row.id),
      workstreamState: latest?.state ?? null,
      batchState: latest?.batchState ?? null,
      pullRequest: latest
        ? { url: latest.prUrl, state: latest.prState, ciStopped: latest.ciStopped }
        : null,
    }),
    workstreamId: latest?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getTask(db: DbReader, id: TaskId): TaskDto {
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!row) throw new NotFoundError('task', id);
  return toTaskDto(db, row);
}

/** The project's tasks in board order. A removed (cancelled) task keeps its row but is not listed. */
export function listTasks(db: DbReader, projectId: ProjectId): TaskDto[] {
  return db
    .select()
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.projectId, projectId), ne(schema.tasks.status, TaskStatus.Cancelled)),
    )
    .orderBy(asc(schema.tasks.boardOrder), asc(schema.tasks.id))
    .all()
    .map((row) => toTaskDto(db, row));
}

/**
 * Removes a task that never started: it keeps its row, history and id, with status cancelled, and
 * drops out of the project's task list. A task with any workstream, finished or not, goes through
 * the workstream's own cancel; a task that open tasks wait on is refused. Removing a removed task
 * answers it again and emits nothing. A task with no workstream holds no claims (claims belong to
 * workstreams), so there is nothing to release.
 */
export function cancelTask(ctx: WriteContext, id: TaskId): TaskDto {
  const task = getTask(ctx.tx, id);
  if (task.status === TaskStatus.Cancelled) return task;
  const run = latestRun(ctx.tx, id);
  // A held run never ran, so it goes with its task; any other run belongs to the workstream's own cancel.
  const held = run?.state === WorkstreamState.Held ? run : undefined;
  if (task.status !== TaskStatus.Open || (run && !held))
    throw new TaskStartedError(
      task.title,
      run ? { id: run.id, live: !isTerminal(run.state) } : null,
    );
  // A pull-request start inserts its workstreams only once its batch is cut; removing a task in that
  // window would abort the cut.
  const cutting = ctx.tx
    .select({ title: schema.batches.title })
    .from(schema.batches)
    .where(
      and(
        eq(schema.batches.projectId, task.projectId),
        eq(schema.batches.state, BatchState.Cutting),
      ),
    )
    .get();
  if (cutting)
    throw new ConflictError(
      `Batch "${cutting.title}" is being cut; remove ${task.title} once it has started`,
    );
  refuseWhileOpenDependents(ctx, task, 'remove');
  if (held)
    transitionWorkstream(ctx, held.id, {
      to: WorkstreamState.Cancelled,
      fence: null,
      reason: 'removed by the builder',
    });
  return retireTask(ctx, id);
}

/**
 * Closes a task whose latest run failed: the same soft remove as `cancelTask`, so it keeps its row,
 * id and edges and drops out of the project's list. Its workstreams are left as they are, so the
 * Factory still shows the failed run, and nothing here touches the branch or worktree its batch holds.
 * A failed run released its claims when it failed. A task whose latest run is anything else is
 * refused: an unstarted one is removed, a live or cancelled run is cancelled or restarted. A
 * finished task, or a failed run shipped anyway, is closed only once its pull request closed
 * without merging; while it is open or merged it is refused. A task
 * that open tasks wait on is refused, naming them. Closing a closed task answers it and emits nothing.
 */
export function closeTask(ctx: WriteContext, id: TaskId): TaskDto {
  const task = getTask(ctx.tx, id);
  if (task.status === TaskStatus.Cancelled) return task;
  if (task.status === TaskStatus.Done) {
    if (!pullRequestClosed(ctx.tx, id))
      throw new ConflictError(`Task ${task.title} is finished and can't be closed`);
  } else if (latestRun(ctx.tx, id)?.state !== WorkstreamState.Failed) {
    throw new ConflictError(
      `Task ${task.title} hasn't failed, so it can't be closed; a task that never started is removed, and a running one is cancelled in Factory`,
    );
  } else {
    // A failed run shipped anyway is judged by its pull request, like a finished one.
    const pr = latestPullRequest(ctx.tx, id);
    if (pr && pr.state !== PullRequestState.Closed)
      throw new ConflictError(
        `Task ${task.title} shipped anyway and its pull request is ${pr.state === PullRequestState.Merged ? 'merged' : 'open'}, so it can't be closed`,
      );
  }
  refuseWhileOpenDependents(ctx, task, 'close');
  return retireTask(ctx, id);
}

/**
 * Opens a finished task again after its pull request closed without merging, so it is planned work
 * once more: Ready, or Backlog while a dependency is unfinished, and the builder starts it afresh.
 * Its earlier run and batch stay as history. A task whose pull request is anything but closed is
 * refused.
 */
export function reopenTask(ctx: WriteContext, id: TaskId): TaskDto {
  const task = getTask(ctx.tx, id);
  if (task.status !== TaskStatus.Done || !pullRequestClosed(ctx.tx, id))
    throw new ConflictError(
      `Task ${task.title} can be reopened only once its pull request closed without merging`,
    );
  ctx.tx
    .update(schema.tasks)
    .set({ status: TaskStatus.Open, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: id,
    data: { status: TaskStatus.Open },
  });
  return getTask(ctx.tx, id);
}

/**
 * Whether the task's latest run shipped in a batch whose pull request closed without merging. The
 * latest run is taken first, batch or not, so a reopened task's newer run hides the old pull request.
 */
function pullRequestClosed(db: DbReader, taskId: TaskId): boolean {
  return latestPullRequest(db, taskId)?.state === PullRequestState.Closed;
}

/**
 * The pull request the task's latest run shipped in: its state last read (null before the first
 * read). Null when that run is in no batch, or its batch has not shipped one.
 */
function latestPullRequest(
  db: DbReader,
  taskId: TaskId,
): { readonly state: PullRequestState | null } | null {
  const batch = db
    .select({
      state: schema.batches.state,
      prUrl: schema.batches.prUrl,
      prState: schema.batches.prState,
    })
    .from(schema.workstreams)
    .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    .where(eq(schema.workstreams.taskId, taskId))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
  return batch?.state === BatchState.Shipped && batch.prUrl ? { state: batch.prState } : null;
}

function latestRun(db: DbReader, taskId: TaskId) {
  return db
    .select({ id: schema.workstreams.id, state: schema.workstreams.state })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, taskId))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
}

/** A cancelled dependency is never done, so an open dependent would wait for ever. */
function refuseWhileOpenDependents(
  ctx: WriteContext,
  task: Pick<TaskDto, 'id' | 'title'>,
  how: 'remove' | 'close',
): void {
  const dependents = ctx.tx
    .select({ title: schema.tasks.title })
    .from(schema.taskDeps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDeps.taskId))
    .where(and(eq(schema.taskDeps.dependsOnId, task.id), eq(schema.tasks.status, TaskStatus.Open)))
    .orderBy(asc(schema.tasks.boardOrder))
    .all();
  if (dependents.length > 0)
    throw new TaskHasDependentsError(
      task.title,
      dependents.map((d) => d.title),
      how,
    );
}

/** The soft remove both routes end in: status cancelled, parked column cleared, one event. */
function retireTask(ctx: WriteContext, id: TaskId): TaskDto {
  ctx.tx
    .update(schema.tasks)
    .set({ status: TaskStatus.Cancelled, boardColumnId: null, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: id,
    data: { status: TaskStatus.Cancelled },
  });
  return getTask(ctx.tx, id);
}

export function patchTask(ctx: WriteContext, id: TaskId, patch: TaskPatch): TaskDto {
  const changes = TaskPatch.parse(patch);
  if (getTask(ctx.tx, id).status === TaskStatus.Cancelled)
    throw new ConflictError('A removed task can no longer be edited');
  if (changes.flowId) getFlow(ctx.tx, changes.flowId);
  const { landing, ...fields } = changes;
  if (landing !== undefined) {
    // The branch is cut and the pull request opened for the task's batch, so once the task has run
    // its landing is its batch's.
    const started = ctx.tx
      .select({ id: schema.workstreams.id })
      .from(schema.workstreams)
      .where(eq(schema.workstreams.taskId, id))
      .get();
    if (started)
      throw new ConflictError(
        `${getTask(ctx.tx, id).title} has already started, so where its work lands is fixed`,
      );
  }
  if (fields.workspaceMode !== undefined) checkPlacementCanChange(ctx.tx, getTask(ctx.tx, id));
  ctx.tx
    .update(schema.tasks)
    .set({
      ...fields,
      ...(landing === undefined ? {} : landingColumns(landing)),
      // A placement the builder chose has no proposal behind it.
      ...(fields.workspaceMode === undefined ? {} : { placementReason: null }),
      updatedAt: ctx.now,
    })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
  return getTask(ctx.tx, id);
}

/**
 * A task's placement changes exactly while Start could start it (task placement spec, P3): it is
 * open and its latest run, if any, is not active. Parking doesn't count, since a parked task has not
 * started. Only a project that delivers by pull request has separate copies. The daemon adds the
 * pending-join test on top.
 */
function checkPlacementCanChange(db: DbReader, task: TaskDto): void {
  if (getProject(db, task.projectId).delivery !== Delivery.PullRequest)
    throw new InvalidError(NO_COPY_WITHOUT_PULL_REQUESTS);
  if (task.status !== TaskStatus.Open)
    throw new ConflictError(`${task.title} is finished, so where it worked can't change`);
  const run = latestRun(db, task.id);
  if (run && ACTIVE_STATES.includes(run.state))
    throw new ConflictError(
      `${task.title} has started, so where it works can't change until its run ends`,
    );
}

/** Below this gap a midpoint loses precision, so the project is renumbered first. */
const MIN_ORDER_GAP = 1e-6;

/** Only planned and parked work moves; the rest follows its workstream. */
const MOVABLE: readonly BoardStatus[] = [BoardStatus.Backlog, BoardStatus.Ready];

const STALE_BOARD = 'The board changed while you were dragging; try again';

/** The orders of the project's open tasks other than `except`: a move takes none of them. */
function openOrders(db: DbReader, projectId: ProjectId, except: TaskId): number[] {
  return db
    .select({ boardOrder: schema.tasks.boardOrder })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.status, TaskStatus.Open),
        ne(schema.tasks.id, except),
      ),
    )
    .all()
    .map((row) => row.boardOrder);
}

/** Rewrites the open tasks' orders as 1…n in their current order; finished tasks keep theirs, as the Done column sorts by finish time. Each changed task announces it. */
function renumberBoard(ctx: WriteContext, projectId: ProjectId): void {
  const rows = ctx.tx
    .select({ id: schema.tasks.id, boardOrder: schema.tasks.boardOrder })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.status, TaskStatus.Open)))
    .orderBy(asc(schema.tasks.boardOrder), asc(schema.tasks.id))
    .all();
  rows.forEach((row, index) => {
    const boardOrder = index + 1;
    if (row.boardOrder === boardOrder) return;
    ctx.tx
      .update(schema.tasks)
      .set({ boardOrder, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, row.id))
      .run();
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: row.id,
      data: { boardOrder },
    });
  });
}

/** Places a task in a column, between its new neighbours there (spec §10: drag and drop sets priority). */
export function moveTask(ctx: WriteContext, id: TaskId, move: TaskMove): TaskDto {
  const { to, after, before } = TaskMove.parse(move);
  const task = getTask(ctx.tx, id);
  if (task.status === TaskStatus.Cancelled)
    throw new ConflictError('A removed task can no longer be moved');
  // An older run can still be live while the latest one has ended, so look at every run.
  const live = ctx.tx
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(
      and(eq(schema.workstreams.taskId, id), inArray(schema.workstreams.state, [...ACTIVE_STATES])),
    )
    .get();
  if (live || !MOVABLE.includes(task.boardStatus))
    throw new ConflictError(
      `${task.title} follows its workstream; only planned and parked tasks move`,
    );
  if (to !== null && getBoardColumn(ctx.tx, to).projectId !== task.projectId)
    throw new InvalidError('The column must belong to the same project');
  if (to !== null) {
    // A parked task never finishes, so a dependent that has already started would stay queued for ever.
    const started = ctx.tx
      .select({ title: schema.tasks.title })
      .from(schema.taskDeps)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDeps.taskId))
      .innerJoin(schema.workstreams, eq(schema.workstreams.taskId, schema.taskDeps.taskId))
      .where(
        and(
          eq(schema.taskDeps.dependsOnId, id),
          inArray(schema.workstreams.state, [...ACTIVE_STATES]),
        ),
      )
      .orderBy(asc(schema.tasks.boardOrder))
      .get();
    if (started)
      throw new ConflictError(
        `Task ${started.title} waits on ${task.title} and has started; ${task.title} can't be parked until ${started.title} finishes`,
      );
  }
  const orderOf = (neighbour: TaskId | null): number | null => {
    if (neighbour === null) return null;
    if (neighbour === id) throw new InvalidError('A task cannot be its own neighbour');
    const other = getTask(ctx.tx, neighbour);
    if (other.projectId !== task.projectId)
      throw new InvalidError('Both neighbours must be tasks in the same project');
    if (other.boardColumnId !== to)
      throw new InvalidError('A neighbour must be in the column the task moves to');
    // The board lists only planned and parked work among these cards; anything else moved on.
    if (other.status !== TaskStatus.Open || !MOVABLE.includes(other.boardStatus))
      throw new ConflictError(STALE_BOARD);
    return other.boardOrder;
  };
  // Orders are project-wide, so a new one is chosen against every open task, not only the column's: no two
  // open tasks share an order, and neighbours always leave a gap between them.
  const orders = () => openOrders(ctx.tx, task.projectId, id);
  /** The least open order above `lo`, or `hi` when none sits between them. */
  const nextAbove = (lo: number, hi: number) =>
    orders().reduce((least, o) => (o > lo && o < least ? o : least), hi);
  const first = { lo: orderOf(after), hi: orderOf(before) };
  if (first.lo !== null && first.hi !== null) {
    if (first.lo > first.hi) throw new ConflictError(STALE_BOARD);
    // Neighbours that share an order, or sit too close for a precise midpoint, are spread out first.
    if (nextAbove(first.lo, first.hi) - first.lo < MIN_ORDER_GAP)
      renumberBoard(ctx, task.projectId);
  }
  const lo = orderOf(after);
  const hi = orderOf(before);
  if (lo !== null && hi !== null && lo >= hi) throw new ConflictError(STALE_BOARD);
  const boardOrder =
    lo !== null && hi !== null
      ? (lo + nextAbove(lo, hi)) / 2
      : lo !== null
        ? orders().reduce((most, o) => Math.max(most, o), lo) + 1
        : hi !== null
          ? orders().reduce((least, o) => Math.min(least, o), hi) - 1
          : task.boardOrder;
  // The column the view placed the task in: the human column, or the derived column of its planned neighbours.
  const derived = [after, before].flatMap((n) =>
    n === null ? [] : [getTask(ctx.tx, n).boardStatus],
  );
  if (derived.length > 0) {
    const column = listTasks(ctx.tx, task.projectId).filter(
      (t) =>
        t.id !== id &&
        t.status === TaskStatus.Open &&
        t.boardColumnId === to &&
        (to !== null || derived.includes(t.boardStatus)),
    );
    // A view that missed a task now between the neighbours, or past the one neighbour of a move to an end, is stale.
    const stale = column.some(
      (t) => (lo === null || t.boardOrder > lo) && (hi === null || t.boardOrder < hi),
    );
    if (stale) throw new ConflictError(STALE_BOARD);
  }
  ctx.tx
    .update(schema.tasks)
    .set({ boardOrder, boardColumnId: to, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: id,
    data: { boardOrder, boardColumnId: to },
  });
  return getTask(ctx.tx, id);
}
