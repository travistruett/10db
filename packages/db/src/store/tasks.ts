import {
  ACTIVE_STATES,
  BatchState,
  BoardStatus,
  columnNameKey,
  ConflictError,
  DEFAULT_BOARD_COLUMN,
  Delivery,
  effectiveRigor,
  EventType,
  explainEffectiveRigor,
  InvalidError,
  isTerminal,
  mintId,
  NotFoundError,
  parseFindings,
  passHoldsTasks,
  PullRequestState,
  TaskInput,
  TaskHasDependentsError,
  TaskMove,
  TaskPatch,
  TaskStartedError,
  TaskStatus,
  taskLandingFor,
  Title,
  Headline,
  Why,
  WorkstreamId,
  WorkstreamState,
  type GoalId,
  type KindDto,
  type BoardColumnId,
  type CiStopped,
  type PassId,
  WorkspaceMode,
  type ProjectDto,
  type ProjectId,
  type ProposalId,
  Rigor,
  RigorSource,
  type TaskConfig,
  type TaskDto,
  type TaskId,
  type TaskKind,
  type TaskLanding,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, max, ne } from 'drizzle-orm';
import * as schema from '../schema';
import { getBoardColumn, listBoardColumns } from './board-columns';
import { checkTaskKinds, listKinds } from './kinds';
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
  /**
   * The task is a page of a pass that still holds it: In progress, as the Workbench works on it,
   * unless its run is paused by a usage limit or held.
   */
  readonly inPass?: boolean;
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
  inPass = false,
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
      // A page a pass holds is In progress, as the Workbench works on it: whether it waits on the
      // builder (Ready or asking), failed its turn, has not been spoken to, or has no live run while
      // the pass still holds it. A usage-limit pause and a hold stay Blocked, as for any run.
      if (
        inPass &&
        workstreamState !== WorkstreamState.PausedLimit &&
        workstreamState !== WorkstreamState.Held
      )
        return BoardStatus.InProgress;
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

/**
 * Where a new task works and why. The daemon proposes it (`proposePlacement`) where it builds a task;
 * a caller that passes none gets the placement the task names, else the project's default, with no reason.
 */
export interface Placement {
  readonly workspaceMode: WorkspaceMode;
  readonly reason: string | null;
}

/** The reason stored when the builder sets a task's placement from its control. */
export const BUILDER_CHOSE_PLACEMENT = 'chosen by the builder';

export function insertTask(
  ctx: WriteContext,
  projectId: ProjectId,
  input: TaskInput,
  placement?: Placement,
  /** Who gave the task its rigor, when `input` has one; the builder's, which pins it, when left out. */
  rigorSource?: RigorSource,
): TaskDto {
  const project = getProject(ctx.tx, projectId);
  const config = TaskInput.parse(input);
  const kinds = checkTaskKinds(ctx.tx, config.kinds);
  refuseUnknownAreas(project, config.areas);
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
    kinds,
    landing: config.landing ?? taskLandingFor(project),
    ...(placement ?? { workspaceMode: placementFor(project, config.workspaceMode), reason: null }),
    proposalId: null,
    rigorSource: rigorSource ?? RigorSource.Builder,
  });
}

function refuseUnknownAreas(project: ProjectDto, areas: readonly string[]): void {
  const known = new Set([
    ...project.areas.map((a) => a.name),
    ...project.hazards.map((h) => h.name),
  ]);
  const unknown = areas.filter((a) => !known.has(a));
  if (unknown.length > 0)
    throw new InvalidError(`Unknown areas for project ${project.name}: ${unknown.join(', ')}`);
}

/**
 * Writes one of a goal's tasks, with the project's default landing. `dependsOn` names tasks the
 * caller wrote in the same transaction; a brief's task may have no acceptance criteria of its own.
 */
export function insertGoalTask(
  ctx: WriteContext,
  projectId: ProjectId,
  goalId: GoalId,
  input: {
    readonly title: string;
    /** Absent or empty: none. */
    readonly headline?: string;
    readonly why?: string;
    readonly description: string;
    readonly acceptanceCriteria: readonly string[];
    readonly areas: readonly string[];
    readonly dependsOn: readonly TaskId[];
  },
  placement?: Placement,
): TaskDto {
  const project = getProject(ctx.tx, projectId);
  refuseUnknownAreas(project, input.areas);
  return writeTask(ctx, projectId, {
    title: Title.parse(input.title),
    headline: Headline.parse(input.headline ?? ''),
    why: Why.parse(input.why ?? ''),
    description: input.description,
    acceptanceCriteria: [...input.acceptanceCriteria],
    areas: [...input.areas],
    dependsOn: [...input.dependsOn],
    landing: taskLandingFor(project),
    ...(placement ?? { workspaceMode: placementFor(project, undefined), reason: null }),
    proposalId: null,
    goalId,
  });
}

/**
 * Writes the task a Workbench pass makes for one of its pages (spec §4.2), in the caller's write: the
 * page area alone, no brief and no acceptance criteria, in Your folder, and one of `goalId`'s tasks
 * when one is named. It costs nothing until the builder speaks to it.
 */
export function insertPassPageTask(
  ctx: WriteContext,
  projectId: ProjectId,
  input: { readonly title: string; readonly area: string; readonly goalId: GoalId | null },
): TaskDto {
  const project = getProject(ctx.tx, projectId);
  refuseUnknownAreas(project, [input.area]);
  return writeTask(ctx, projectId, {
    title: Title.parse(input.title),
    description: '',
    acceptanceCriteria: [],
    areas: [input.area],
    dependsOn: [],
    landing: taskLandingFor(project),
    workspaceMode: WorkspaceMode.Shared,
    reason: null,
    proposalId: null,
    ...(input.goalId === null ? {} : { goalId: input.goalId }),
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
 * task can't start until the builder names them. `insertTaskFromProposal` stores these, so the daemon
 * asks here for the areas its placement rule must see.
 */
export function areasForProposal(
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

/** The task whose lane raised the proposal; null when another source did, or the task is gone. */
export function proposalSourceTask(tx: DbReader, proposalId: ProposalId): TaskDto | null {
  const source = tx
    .select({ ref: schema.sources.ref })
    .from(schema.proposals)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.proposals.sourceId))
    .where(eq(schema.proposals.id, proposalId))
    .get();
  const workstreamId = WorkstreamId.safeParse(source?.ref['workstreamId']);
  if (!workstreamId.success) return null;
  const raiser = tx
    .select({ taskId: schema.workstreams.taskId })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.id, workstreamId.data))
    .get();
  return raiser ? getTask(tx, raiser.taskId) : null;
}

/** The project's Icebox column: its first column when the builder renamed it; null on the derived board. */
function iceboxColumnId(tx: DbReader, projectId: ProjectId): BoardColumnId | null {
  const iceboxKey = columnNameKey(DEFAULT_BOARD_COLUMN);
  const columns = listBoardColumns(tx, projectId);
  return (columns.find((c) => columnNameKey(c.name) === iceboxKey) ?? columns[0])?.id ?? null;
}

/**
 * Files an accepted new-task proposal as an open task linked to it. The proposal names no acceptance
 * criteria, so the task starts with none; its title meets the same rule as a task made by hand. Its
 * areas come from the task that raised it, or the project's only area (`areasForProposal`). With
 * `parkInIcebox` it is parked in the Icebox column, as 10db files a small proposal by itself.
 */
export function insertTaskFromProposal(
  ctx: WriteContext,
  input: {
    readonly proposalId: ProposalId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly description: string;
    readonly parkInIcebox?: boolean;
    /** The kinds the lane declared when it proposed the task, each a kind that exists; none when left out. */
    readonly kinds?: readonly TaskKind[];
  },
  placement?: Placement,
): TaskDto {
  const project = getProject(ctx.tx, input.projectId);
  return writeTask(ctx, input.projectId, {
    boardColumnId: input.parkInIcebox === true ? iceboxColumnId(ctx.tx, input.projectId) : null,
    landing: taskLandingFor(project),
    ...(placement ?? { workspaceMode: placementFor(project, undefined), reason: null }),
    title: Title.parse(input.title),
    description: input.description,
    acceptanceCriteria: [],
    areas: [...areasForProposal(ctx.tx, input.proposalId, project)],
    dependsOn: [],
    kinds: checkTaskKinds(ctx.tx, input.kinds ?? []),
    proposalId: input.proposalId,
  });
}

/** What a step hands over for a follow-up task: the rest comes from the task it was found in. */
export interface FollowUpFields {
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria?: readonly string[];
}

/** How a follow-up task came about, which decides how its description names the source. */
export const FollowUpOrigin = {
  /** A step checking the source found it. */
  Found: 'found',
  /** The source's implementer left it out of the source. */
  Left: 'left',
} as const;
export type FollowUpOrigin = (typeof FollowUpOrigin)[keyof typeof FollowUpOrigin];

function originLine(origin: FollowUpOrigin, source: TaskDto): string {
  switch (origin) {
    case FollowUpOrigin.Found:
      return `Found while checking the task "${source.title}" (${source.id}).`;
    case FollowUpOrigin.Left:
      return `Work left from the task "${source.title}" (${source.id}).`;
  }
}

/**
 * Files a follow-up for `sourceId`: an open task in the same project, parked in the Icebox column
 * (the project's first column when the builder renamed it, the derived board when it has none),
 * landing where the project's tasks land now (`taskLandingFor`, not the source's landing, which may
 * name a branch since retired) and touching the same areas. Its description names the source and
 * says whether a step found it or the source's implementer left it. It depends on nothing, so it
 * never holds the source up.
 */
export function insertFollowUpTask(
  ctx: WriteContext,
  sourceId: TaskId,
  fields: FollowUpFields,
  how: FollowUpOrigin = FollowUpOrigin.Found,
): TaskDto {
  const source = getTask(ctx.tx, sourceId);
  const origin = originLine(how, source);
  const project = getProject(ctx.tx, source.projectId);
  return writeTask(ctx, source.projectId, {
    landing: taskLandingFor(project),
    workspaceMode: placementFor(project, undefined),
    reason: null,
    title: Title.parse(fields.title),
    description: `${origin}\n\n${fields.description}`,
    acceptanceCriteria: [...(fields.acceptanceCriteria ?? [])],
    areas: source.areas,
    dependsOn: [],
    proposalId: null,
    boardColumnId: iceboxColumnId(ctx.tx, source.projectId),
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
 * open: a task in the project's Ready column (planned, no human column), landing where the
 * project's tasks land now and touching the same areas, with one acceptance criterion per finding. Its description
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
  const project = getProject(ctx.tx, source.projectId);
  return writeTask(ctx, source.projectId, {
    landing: taskLandingFor(project),
    workspaceMode: placementFor(project, undefined),
    reason: null,
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
    proposalId: null,
    boardColumnId: null,
  });
}

/** Writes a task the caller has already validated, at the end of the board, and announces it with its proposal, if any. */
function writeTask(
  ctx: WriteContext,
  projectId: ProjectId,
  config: Omit<
    TaskConfig,
    'landing' | 'workspaceMode' | 'headline' | 'why' | 'rigor' | 'kinds' | 'effortPin'
  > &
    Partial<Pick<TaskConfig, 'headline' | 'why' | 'rigor' | 'kinds' | 'effortPin'>> &
    Placement & {
      readonly landing: TaskLanding;
      readonly proposalId: ProposalId | null;
      readonly goalId?: GoalId;
      /** Who gave the task its `rigor`; ignored when it has none. */
      readonly rigorSource?: RigorSource;
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
    headline: config.headline ?? '',
    why: config.why ?? '',
    description: config.description,
    acceptanceCriteria: config.acceptanceCriteria,
    areas: config.areas,
    rigor: config.rigor ?? null,
    rigorSource: config.rigor == null ? null : (config.rigorSource ?? RigorSource.Builder),
    kinds: config.kinds ?? [],
    effortPin: config.effortPin ?? null,
    proposalId: config.proposalId,
    ...landingColumns(config.landing),
    status: TaskStatus.Open,
    boardOrder: (order?.value ?? 0) + 1,
    boardColumnId: config.boardColumnId ?? null,
    workspaceMode: config.workspaceMode,
    placementReason: config.reason,
    goalId: config.goalId ?? null,
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

/** Whether the pass a task names still holds it as a page (`passHoldsTasks`). */
function passHolds(db: DbReader, passId: PassId | null): boolean {
  if (passId === null) return false;
  const pass = db
    .select({ state: schema.passes.state })
    .from(schema.passes)
    .where(eq(schema.passes.id, passId))
    .get();
  return pass !== undefined && passHoldsTasks(pass.state);
}

/** What a task's effective rigor reads besides the task: the kinds and its project's default. */
interface RigorInputs {
  readonly kinds: readonly KindDto[];
  readonly projectDefault: Rigor;
}

function rigorInputs(db: DbReader, projectId: ProjectId): RigorInputs {
  const row = db
    .select({ defaultRigor: schema.projects.defaultRigor })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  return { kinds: listKinds(db), projectDefault: row?.defaultRigor ?? Rigor.Standard };
}

function toTaskDto(
  db: DbReader,
  row: typeof schema.tasks.$inferSelect,
  inputs: RigorInputs = rigorInputs(db, row.projectId),
): TaskDto {
  const rigorInput = {
    rigor: row.rigor,
    projectDefault: inputs.projectDefault,
    taskKinds: row.kinds,
    kinds: inputs.kinds,
  };
  const explained = explainEffectiveRigor({
    ...rigorInput,
    rigorSource: row.rigorSource,
    rigorReason: row.rigorReason,
  });
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
    headline: row.headline,
    why: row.why,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    areas: row.areas,
    rigor: row.rigor,
    effectiveRigor: effectiveRigor(rigorInput),
    rigorSource: row.rigor === null ? null : (row.rigorSource ?? RigorSource.Builder),
    rigorReason: row.rigor === null ? null : row.rigorReason,
    effectiveRigorSource: explained.source,
    effectiveRigorReason: explained.reason,
    kindsOff: row.kindsOff,
    sizedByRules: row.sizingCalls.rigor === null && Object.keys(row.sizingCalls.kinds).length === 0,
    kinds: row.kinds,
    effortPin: row.effortPin,
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
      inPass: passHolds(db, row.passId),
    }),
    workstreamId: latest?.id ?? null,
    goalId: row.goalId,
    landingGroupId: row.landingGroupId,
    passId: row.passId,
    keptWork: row.keptWorkSha !== null,
    modelSetting: row.modelSetting,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getTask(db: DbReader, id: TaskId): TaskDto {
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!row) throw new NotFoundError('task', id);
  return toTaskDto(db, row);
}

/**
 * The tasks with these ids, in that order, reading the kinds and each project's default once for the whole
 * list rather than once per task.
 */
export function getTasks(db: DbReader, ids: readonly TaskId[]): TaskDto[] {
  const inputs = new Map<ProjectId, RigorInputs>();
  return ids.map((id) => {
    const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    if (!row) throw new NotFoundError('task', id);
    const known = inputs.get(row.projectId) ?? rigorInputs(db, row.projectId);
    inputs.set(row.projectId, known);
    return toTaskDto(db, row, known);
  });
}

/** The project's tasks in board order. A removed (cancelled) task keeps its row but is not listed. */
export function listTasks(db: DbReader, projectId: ProjectId): TaskDto[] {
  const inputs = rigorInputs(db, projectId);
  return db
    .select()
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.projectId, projectId), ne(schema.tasks.status, TaskStatus.Cancelled)),
    )
    .orderBy(asc(schema.tasks.boardOrder), asc(schema.tasks.id))
    .all()
    .map((row) => toTaskDto(db, row, inputs));
}

/**
 * Removes a task that never started: it keeps its row, history and id, with status cancelled, and
 * drops out of the project's task list. A task with any workstream, finished or not, goes through
 * the workstream's own cancel; a task that open tasks wait on is refused. Removing a removed task
 * answers it again and emits nothing. A task with no workstream holds no claims (claims belong to
 * workstreams), so there is nothing to release.
 */
export function cancelTask(ctx: WriteContext, id: TaskId): TaskDto {
  return removeUnstarted(ctx, id, false);
}

/**
 * The first of a task's runs that really began: it got past the queue, or it was cancelled after a
 * session. A run only queued, held or cancelled before any session has not begun. Pass every run, not
 * the latest, since a task can start again after a run that ended. This one rule is the goal digest's
 * reading of a goal as not started and Remove Draft Goal's refusal, so the offer and the refusal agree.
 */
export function startedRun<Run extends { readonly id: WorkstreamId; readonly state: string }>(
  db: DbReader,
  runs: readonly Run[],
): Run | undefined {
  const notBegun: readonly string[] = [
    WorkstreamState.Queued,
    WorkstreamState.Held,
    WorkstreamState.Cancelled,
  ];
  const begun = runs.find((run) => !notBegun.includes(run.state));
  if (begun) return begun;
  const cancelled = runs.filter((run) => run.state === WorkstreamState.Cancelled);
  if (cancelled.length === 0) return undefined;
  const session = db
    .select({ workstreamId: schema.sessions.workstreamId })
    .from(schema.sessions)
    .where(
      inArray(
        schema.sessions.workstreamId,
        cancelled.map((run) => run.id),
      ),
    )
    .limit(1)
    .get();
  return cancelled.find((run) => run.id === session?.workstreamId);
}

/**
 * Removes a task of a draft goal that never started: as `removeUnstarted`, except that the rule is
 * `startedRun` over all the task's runs, so a run that began refuses it even behind a later run held
 * or cancelled while queued. A latest run still queued is refused as `cancelTask` refuses it.
 */
export function cancelNeverStartedTask(ctx: WriteContext, id: TaskId): TaskDto {
  const task = getTask(ctx.tx, id);
  if (task.status === TaskStatus.Cancelled) return task;
  const runs = ctx.tx
    .select({ id: schema.workstreams.id, state: schema.workstreams.state })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, id))
    .all();
  const started = startedRun(ctx.tx, runs);
  if (started)
    throw new TaskStartedError(task.title, {
      id: started.id,
      live: !isTerminal(started.state),
    });
  return removeUnstarted(ctx, id, true);
}

/**
 * Removes a task from a refused start's Cancel task answer: as `cancelTask`, except that a latest run
 * cancelled before it ever had a session does not count as a start. A pull-request start inserts its
 * runs with the CUTTING batch, and a refused cut cancels them with it, so the task never ran. A task
 * started again after a run that failed is closed as `closeTask` does, and refused on the same terms.
 * A task started again after a run that finished (a reopened task) or was cancelled after a session
 * (cancelled in Factory) is refused before it gets a new run, so that terminal run is still its
 * latest: it is retired the same way, refused only while an open task waits on it.
 */
export function cancelRefusedStartTask(ctx: WriteContext, id: TaskId): TaskDto {
  const task = getTask(ctx.tx, id);
  const run = task.status === TaskStatus.Open ? latestRun(ctx.tx, id) : undefined;
  if (run?.state === WorkstreamState.Failed) return closeTask(ctx, id);
  const finished = run?.state === WorkstreamState.Done;
  const cancelledAfterSession =
    run?.state === WorkstreamState.Cancelled && hadSession(ctx.tx, run.id);
  if (!finished && !cancelledAfterSession) return removeUnstarted(ctx, id, true);
  // A finished run whose pull request is still open or merged is judged as `closeTask` judges it.
  const pr = finished ? latestPullRequest(ctx.tx, id) : null;
  if (pr && pr.state !== PullRequestState.Closed)
    throw new ConflictError(
      `Task ${task.title} finished and its pull request is ${pr.state === PullRequestState.Merged ? 'merged' : 'open'}, so it can't be removed`,
    );
  // The run is terminal, so it holds no claims and nothing runs; its row and history stay.
  refuseWhileOpenDependents(ctx, task, 'remove');
  return retireTask(ctx, id);
}

function removeUnstarted(ctx: WriteContext, id: TaskId, refusedStart: boolean): TaskDto {
  const task = getTask(ctx.tx, id);
  if (task.status === TaskStatus.Cancelled) return task;
  const run = latestRun(ctx.tx, id);
  // A held run never ran, so it goes with its task; any other run belongs to the workstream's own cancel.
  const held = run?.state === WorkstreamState.Held ? run : undefined;
  const refusedRun =
    refusedStart && run?.state === WorkstreamState.Cancelled && !hadSession(ctx.tx, run.id);
  if (task.status !== TaskStatus.Open || (run && !held && !refusedRun))
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

function hadSession(db: DbReader, workstreamId: WorkstreamId): boolean {
  return (
    db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.workstreamId, workstreamId))
      .limit(1)
      .get() !== undefined
  );
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

/**
 * Detaches the questions stored under a task that is being cancelled, so none points at a dead task.
 * Each stays stored and linked, now about nothing. Every route that sets a task to Cancelled goes
 * through `retireTask`, so through this: a plan removal (a converted remove_task), the Board's
 * Remove, Close of a failed or finished task, Cancel task on a refused start card, and Remove Draft
 * Goal. Remove Draft Goal finds nothing here: `releaseShapeLinksOfGoal` has already deleted the
 * goal's questions before its tasks are cancelled, and must run first, because a question detached
 * here would hide from it.
 */
function detachShapeQuestionsOfTask(ctx: WriteContext, taskId: TaskId): void {
  ctx.tx
    .update(schema.shapeQuestions)
    .set({ taskId: null })
    .where(eq(schema.shapeQuestions.taskId, taskId))
    .run();
}

/**
 * The soft remove every route to Cancelled ends in: status cancelled, parked column cleared, the
 * questions stored under the task detached, one event.
 */
function retireTask(ctx: WriteContext, id: TaskId): TaskDto {
  ctx.tx
    .update(schema.tasks)
    .set({ status: TaskStatus.Cancelled, boardColumnId: null, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  detachShapeQuestionsOfTask(ctx, id);
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: id,
    data: { status: TaskStatus.Cancelled },
  });
  return getTask(ctx.tx, id);
}

/**
 * `proposed` is the placement the daemon's rule gives the task as the patch leaves it. It is taken
 * only when the patch doesn't set the placement itself, the builder has not chosen this task's
 * placement, and the task could still be moved (see `placementRefusal`); a task with no reason takes it
 * only if the rule matched, one whose reason the rule proposed follows the rule (see
 * `movedByProposal`). Otherwise it is ignored, so a task that has started, or that the builder placed,
 * is never moved by an edit.
 */
export function patchTask(
  ctx: WriteContext,
  id: TaskId,
  patch: TaskPatch,
  proposed?: Placement,
  /** Who gave the rigor the patch sets, when it sets one; the builder's, which pins it, when left out. */
  rigorSource?: RigorSource,
): TaskDto {
  const changes = TaskPatch.parse(patch);
  if (changes.kinds !== undefined)
    changes.kinds = checkTaskKinds(ctx.tx, changes.kinds, getTask(ctx.tx, id).kinds);
  if (getTask(ctx.tx, id).status === TaskStatus.Cancelled)
    throw new ConflictError('A removed task can no longer be edited');
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
  if (fields.areas !== undefined) checkAreasCanChange(ctx.tx, getTask(ctx.tx, id), fields.areas);
  if (fields.workspaceMode !== undefined) checkPlacementCanChange(ctx.tx, getTask(ctx.tx, id));
  const moved =
    fields.workspaceMode === undefined && proposed !== undefined
      ? movedByProposal(ctx.tx, getTask(ctx.tx, id), proposed)
      : null;
  ctx.tx
    .update(schema.tasks)
    .set({
      ...fields,
      // A rigor the patch sets is pinned by whoever set it, with no reason of its own; clearing it hands the task back to sizing.
      ...(fields.rigor === undefined
        ? {}
        : {
            rigorSource: fields.rigor === null ? null : (rigorSource ?? RigorSource.Builder),
            rigorReason: null,
            // The next edit event sizes the task again: its fingerprint no longer matches.
            ...(fields.rigor === null ? { sizedFor: null } : {}),
          }),
      ...(landing === undefined ? {} : landingColumns(landing)),
      // The patch is the builder's placement control: the reason says so, replacing a proposed one.
      ...(fields.workspaceMode === undefined ? {} : { placementReason: BUILDER_CHOSE_PLACEMENT }),
      ...(moved ?? {}),
      updatedAt: ctx.now,
    })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
  return getTask(ctx.tx, id);
}

/**
 * Places a task where the placement rule proposes when it starts, with the rule's reason: a start
 * while a Workbench pass holds Your folder sends a folder task to a separate copy. Refused as the
 * builder's own placement change is, for a task that can no longer move.
 */
export function placeTaskByRule(ctx: WriteContext, id: TaskId, proposed: Placement): TaskDto {
  checkPlacementCanChange(ctx.tx, getTask(ctx.tx, id));
  ctx.tx
    .update(schema.tasks)
    .set({
      workspaceMode: proposed.workspaceMode,
      placementReason: proposed.reason,
      updatedAt: ctx.now,
    })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
  return getTask(ctx.tx, id);
}

/**
 * Sets where a task lands, started or not. `patchTask` refuses a task that has run, because its
 * batch's branch and pull request are already cut; the daemon calls this for a task whose landing
 * names a branch that no longer exists and that no open batch uses, which `patchTask` could never
 * move off it.
 */
export function resetTaskLanding(ctx: WriteContext, id: TaskId, landing: TaskLanding): TaskDto {
  if (getTask(ctx.tx, id).status === TaskStatus.Cancelled)
    throw new ConflictError('A removed task can no longer be edited');
  ctx.tx
    .update(schema.tasks)
    .set({ ...landingColumns(landing), updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
  return getTask(ctx.tx, id);
}

/**
 * A task's areas change only while it has never started: its lane takes the areas as claims when it
 * starts, and a finished task's are history. Every area must be one the project has.
 */
function checkAreasCanChange(db: DbReader, task: TaskDto, areas: readonly string[]): void {
  if (task.status !== TaskStatus.Open)
    throw new ConflictError(`${task.title} is finished, so its areas are fixed`);
  if (latestRun(db, task.id))
    throw new ConflictError(
      `${task.title} has already started, so its areas are fixed: the lane took them when it started`,
    );
  refuseUnknownAreas(getProject(db, task.projectId), areas);
}

/**
 * A task's placement changes exactly while Start could start it (task placement spec, P3): it is
 * open and its latest run, if any, is not active. Parking doesn't count, since a parked task has not
 * started. Only a project that delivers by pull request has separate copies. The daemon adds the
 * pending-join test on top.
 */
function checkPlacementCanChange(db: DbReader, task: TaskDto): void {
  const refusal = placementRefusal(db, task);
  if (refusal) throw refusal;
}

function placementRefusal(db: DbReader, task: TaskDto): InvalidError | ConflictError | null {
  if (getProject(db, task.projectId).delivery !== Delivery.PullRequest)
    return new InvalidError(NO_COPY_WITHOUT_PULL_REQUESTS);
  if (task.status !== TaskStatus.Open)
    return new ConflictError(`${task.title} is finished, so where it worked can't change`);
  const run = latestRun(db, task.id);
  if (run && ACTIVE_STATES.includes(run.state))
    return new ConflictError(
      `${task.title} has started, so where it works can't change until its run ends`,
    );
  return null;
}

/**
 * Whether the rule's proposal would move the task to the other placement: it is not the builder's own, it
 * differs from where the task is, and a task with no reason takes it only when the rule matched. The store's
 * own check of whether the task can still move comes after (`movedByProposal`); a caller that must not move
 * a task whose join into a batch is pending asks this first.
 */
export function placementRuleMoves(
  task: Pick<TaskDto, 'workspaceMode' | 'placementReason'>,
  proposed: Placement | undefined,
): boolean {
  return (
    proposed !== undefined &&
    proposed.workspaceMode !== task.workspaceMode &&
    task.placementReason !== BUILDER_CHOSE_PLACEMENT &&
    (task.placementReason !== null || proposed.reason !== null)
  );
}

/**
 * The columns an edit sets when the placement rule gives the task a different placement (the task's
 * areas or risk tags changed after it was made). Null when the task stays as it is: the builder chose
 * its placement, or Start could no longer start it. Otherwise:
 *
 * - A task with no reason takes the proposal only when the rule matched, so the proposal has a reason.
 *   A proposal with none is just the project's default, which says nothing about this task.
 * - A task whose reason the rule proposed (anything but the builder's) follows the rule: the reason
 *   is refreshed to match the new tags and areas, and when the rule no longer matches, the task goes
 *   back to the proposed placement (the project's default) with no reason, since only the rule had
 *   sent it to a copy. It is always the default, never what the creator asked for: the store keeps
 *   no record of the request (task placement spec, P2).
 */
export function movedByProposal(
  db: DbReader,
  task: TaskDto,
  proposed: Placement,
): { workspaceMode: WorkspaceMode; placementReason: string | null } | null {
  if (task.placementReason === BUILDER_CHOSE_PLACEMENT) return null;
  if (task.placementReason === null && proposed.reason === null) return null;
  if (placementRefusal(db, task) !== null) return null;
  return { workspaceMode: proposed.workspaceMode, placementReason: proposed.reason };
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

/** A task's saved Workbench work: its kept commit and the pass branch tip it was kept on. */
export interface TaskKeptWork {
  readonly keptSha: string;
  readonly keptBaseSha: string;
}

/** The work a take-out saved for the task, or null when it has none. */
export function getTaskKeptWork(db: DbReader, id: TaskId): TaskKeptWork | null {
  const row = db
    .select({ keptSha: schema.tasks.keptWorkSha, keptBaseSha: schema.tasks.keptBaseSha })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (!row) throw new NotFoundError('task', id);
  return row.keptSha === null || row.keptBaseSha === null
    ? null
    : { keptSha: row.keptSha, keptBaseSha: row.keptBaseSha };
}

/** Records the work a take-out saved for the task, or clears it with null. */
export function setTaskKeptWork(ctx: WriteContext, id: TaskId, kept: TaskKeptWork | null): void {
  getTask(ctx.tx, id);
  ctx.tx
    .update(schema.tasks)
    .set({
      keptWorkSha: kept?.keptSha ?? null,
      keptBaseSha: kept?.keptBaseSha ?? null,
      updatedAt: ctx.now,
    })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
}
