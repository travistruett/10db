import type {
  AaModelDto,
  AccountConfig,
  AccountCreatedDto,
  AccountDto,
  AccountId,
  AccountIdentityDto,
  AccountPatch,
  AccountPauseDto,
  AccountSecretInput,
  AccountSignInDto,
  AccountUsageDto,
  BatchDto,
  BatchId,
  BatchStartInput,
  BenchmarkStatusDto,
  BoardColumnDelete,
  BoardColumnDto,
  BoardColumnId,
  BoardColumnInput,
  BoardColumnPatch,
  AreaProposalResult,
  DaemonEvent,
  FlowDto,
  FlowId,
  FlowInput,
  FlowPatch,
  FolderInspectResult,
  FoundHostDto,
  GoalAdoptInput,
  GoalAdoptIssue,
  GoalAdoptPreview,
  GoalDigestDto,
  GoalDto,
  GoalId,
  GoalListDto,
  HumanTouchDto,
  InboxAnswer,
  InboxItemDto,
  InboxItemId,
  InboxState,
  JudgeCallDto,
  JudgeConfigPatch,
  JudgeKeyInput,
  JudgeStatusDto,
  JudgeTestResultDto,
  KeepAwakeMode,
  KeepAwakeStatus,
  LanePermissionsDto,
  McpServerStatusDto,
  ModelProfileDto,
  NetworkHostDto,
  ModelProfileId,
  ModelProfilePatch,
  DecisionId,
  PersonaDto,
  PersonaId,
  PersonaInput,
  PersonaPatch,
  PersonDto,
  PersonInput,
  PickerProposalDto,
  ProjectDto,
  ProjectId,
  ProjectInput,
  ProjectPatch,
  ProjectViewDto,
  RoutingRuleDto,
  RoutingRulesInput,
  SelfUpdateStatusDto,
  OneWayPathsDto,
  SmallProposalLimitDto,
  ShapeConvertInput,
  ShapeConvertResult,
  ShapeDismissInput,
  ShapeDto,
  ShapeFileDto,
  ShapeFindingId,
  ShapeJevSettingDto,
  ShapeMeasuresDto,
  ShapeId,
  ShapeInput,
  ShapeMessageDto,
  ShapeOfDto,
  ShapeProposalId,
  ShapeProposeResult,
  ShapeRehearseInput,
  ShapeRehearseResult,
  ShapeViewDto,
  StartShapeInput,
  StepPlanDto,
  StartTaskInput,
  SystemCheckDto,
  TaskDto,
  TaskId,
  TaskInput,
  RunNextResult,
  TaskMove,
  TaskPatch,
  TeamDto,
  TeamInput,
  WorkstreamChangesDto,
  WorkstreamDto,
  WorkstreamId,
} from '@10db/contracts';

/** What starting a task made: its workstream in local delivery, the batch it runs in for pull requests. */
export type TaskStarted =
  | { readonly kind: 'workstream'; readonly workstream: WorkstreamDto }
  | { readonly kind: 'batch'; readonly batch: BatchDto };

/** What adopting a goal brief came to: the goal written, a dry run's preview, or every reason it was refused. */
export type GoalAdoptResult =
  | { readonly kind: 'adopted'; readonly goal: GoalDto }
  | { readonly kind: 'previewed'; readonly preview: GoalAdoptPreview }
  | { readonly kind: 'refused'; readonly errors: GoalAdoptIssue[] };

/** What Convert came to: what it created, or every reason it was refused (nothing written). */
export type ShapeConvertOutcome =
  | { readonly kind: 'converted'; readonly result: ShapeConvertResult }
  | { readonly kind: 'refused'; readonly errors: string[] };

/** The setting that lets 10db install main's build by itself. */
export interface SelfUpdateServices {
  /** The one app-wide setting (on until the builder turns it off) and the commits involved. */
  selfUpdateStatus(): SelfUpdateStatusDto;
  /** Turns it on or off for the whole app; null goes back to the default. */
  setSelfUpdate(enabled: boolean | null): SelfUpdateStatusDto;
  /** How many minutes a staged update waits before the factory drains for it; null is the default. */
  setSelfUpdateWait(minutes: number | null): SelfUpdateStatusDto;
  /** Install Now: the staged update drains the factory at once. */
  installNow(): SelfUpdateStatusDto;
}

/** Removing a task that hasn't run. */
export interface TaskRemovalServices {
  /**
   * Cancels a task with no workstream, or whose only run is held, and drops it from its project's
   * list; a held run is cancelled with it, and its batch ends and takes its worktree and branch
   * with it once nothing in the batch is left. Answering a task already removed is a no-op. Throws
   * TaskStartedError for a task that has run and TaskHasDependentsError while an open task waits
   * on it.
   */
  removeTask(taskId: TaskId): TaskDto;
  /**
   * Closes a task whose latest run failed, as a remove does: it leaves the project's list, its
   * workstreams stay, and its branch and worktree are untouched. Answering a task already closed is
   * a no-op. Throws ConflictError for a task whose run didn't fail and TaskHasDependentsError while
   * an open task waits on it.
   */
  closeTask(taskId: TaskId): TaskDto;
  /**
   * Opens a finished task again after its pull request closed without merging, so it is planned
   * work once more. Throws ConflictError for any other task.
   */
  reopenTask(taskId: TaskId): TaskDto;
}

/** Reading one task, for the builder's tools that check its state before acting on it. */
export interface TaskLookupServices {
  /** Throws NotFoundError for an unknown task. */
  getTask(taskId: TaskId): TaskDto;
  /** One run by id, without listing the rest. Throws NotFoundError for an unknown run. */
  getWorkstream(id: WorkstreamId): WorkstreamDto;
}

/** What the HTTP layer needs from the daemon. Implemented in the daemon module. */
export interface ApiServices {
  /** The judge's status, key, connection test and call log. */
  judgeStatus(): Promise<JudgeStatusDto>;
  patchJudge(patch: JudgeConfigPatch): Promise<JudgeStatusDto>;
  /** Write-only: the key goes to the Keychain and is never answered, logged or stored elsewhere. */
  setJudgeKey(input: JudgeKeyInput): Promise<JudgeStatusDto>;
  removeJudgeKey(): Promise<JudgeStatusDto>;
  testJudge(): Promise<JudgeTestResultDto>;
  /** The most recent calls, newest first. */
  listJudgeCalls(limit: number): JudgeCallDto[];
  listProjects(): ProjectViewDto[];
  /** Registers the project and allows the registries its package files name. */
  createProject(input: ProjectInput): Promise<ProjectDto>;
  listTasks(projectId: ProjectId): TaskDto[];
  /**
   * Throws InvalidError when the task's landing names a branch origin does not have, so the
   * answer may come after asking origin.
   */
  createTask(projectId: ProjectId, input: TaskInput): TaskDto | Promise<TaskDto>;
  /**
   * Starts a task; a held one is queued again as the run it was, in any delivery mode. A task whose
   * latest run failed in an open or failed batch runs again in that batch, keeping its commits; with
   * `fresh` it starts over from the base branch instead, and the batch that held only its failed
   * attempt is abandoned.
   */
  startTask(taskId: TaskId, input?: StartTaskInput): TaskStarted;
  /**
   * Puts the started task's queued workstream first in line for the next free lane. Throws
   * ConflictError for a task whose latest workstream isn't waiting for one.
   */
  runNext(taskId: TaskId): RunNextResult;
  /**
   * Sets aside a started task that has not run: its queued run becomes held, so it takes no lane
   * and keeps its batch and worktree. A task that has begun running is refused (409).
   */
  holdTask(taskId: TaskId): WorkstreamDto;
  /**
   * Starts the tasks and answers every batch the start made or joined: one in shared mode (new, or
   * the project's open or failed batch), one per dependency group in worktree mode.
   */
  startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto[];
  /** Every batch of the project, newest first: a finished task's pull request can sit in an old batch. */
  listBatches(projectId: ProjectId): BatchDto[];
  /**
   * The project's goals, each with its digest and count of new items since the builder last opened
   * it, and the Ungrouped group. Leaves every view mark as it was.
   */
  listGoals(projectId: ProjectId): GoalListDto;
  /**
   * How often a person was needed in the project over the last 14 days, today first. Throws
   * NotFoundError for an unknown project.
   */
  humanTouch(projectId: ProjectId): HumanTouchDto;
  /**
   * The goal's digest for the builder opening it: Δ rows run from the previous view, and the view
   * advances to now. Throws NotFoundError for an unknown goal.
   */
  openGoalDigest(goalId: GoalId): GoalDigestDto;
  /** The project's Shape conversations, the one touched last first. Throws NotFoundError for an unknown project. */
  listShapes(projectId: ProjectId): ShapeDto[];
  /** Opens a conversation; with no title it is named by its first message. */
  createShape(projectId: ProjectId, input: ShapeInput): ShapeDto;
  /** Everything the Shape screen renders for the conversation. Throws NotFoundError for an unknown one. */
  getShapeView(id: ShapeId): ShapeViewDto;
  /** Records a builder message and queues Claude's turn on it. */
  sendShapeMessage(id: ShapeId, text: string): ShapeMessageDto;
  /** Queues a Propose turn, or ignores the press while one is queued or running. */
  proposeShape(id: ShapeId): ShapeProposeResult;
  /** Interrupts the turn that is running; answering when nothing runs is a no-op. */
  stopShape(id: ShapeId): Promise<void>;
  /**
   * Converts the selected proposals into goals, tasks and decisions and starts nothing. A refusal
   * lists every error and writes nothing. Throws ConflictError while a turn runs, unless the
   * caller asks to interrupt it.
   */
  convertShape(id: ShapeId, input: ShapeConvertInput): Promise<ShapeConvertOutcome>;
  /**
   * Remove Draft Goal: removes a goal a conversation made while none of its tasks has started, and
   * makes its proposal pending again. Throws InvalidError for any other goal.
   */
  removeDraftGoal(goalId: GoalId): void;
  /**
   * Open conversation and Re-plan in Shape: records the event as a note the session may cite and
   * tells it where each converted row stands; starts no turn. Throws NotFoundError for an unknown conversation.
   */
  resumeShape(id: ShapeId, event: string): ShapeMessageDto;
  /** The conversation that made a goal or a task, for its drawer's Open conversation; none for work filed by hand. */
  getGoalShape(goalId: GoalId): ShapeOfDto;
  getTaskShape(taskId: TaskId): ShapeOfDto;
  /** Withdraw Decision…: a decision the conversation wrote; throws ConflictError unless it is the head of its chain. */
  withdrawShapeDecision(shapeId: ShapeId, decisionId: DecisionId, reason: string): void;
  /**
   * The builder's actions on a proposal row: edit sets fields and pins them, unpin lets a field (or the
   * whole row) go, restore brings a row back from Earlier pinned, drop tombstones its key. Throws
   * NotFoundError for a row of another conversation, ConflictError for a converted or dropped one and
   * InvalidError for an edit that does not fit.
   */
  editShapeProposal(
    shapeId: ShapeId,
    id: ShapeProposalId,
    fields: Readonly<Record<string, unknown>>,
  ): void;
  unpinShapeProposal(shapeId: ShapeId, id: ShapeProposalId, field?: string): void;
  restoreShapeProposal(shapeId: ShapeId, id: ShapeProposalId): void;
  dropShapeProposal(shapeId: ShapeId, id: ShapeProposalId): void;
  /** Keeps a dropped file; throws InvalidError naming the file and the reason when it is refused. */
  addShapeFile(
    shapeId: ShapeId,
    file: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array },
  ): ShapeFileDto;
  /** `start_shape`: a conversation from a terminal session, listed at once; starts no turn. */
  startShape(input: StartShapeInput): ShapeDto;
  /** Settings › Decisions: the Sizing hit rate and each Shape decision's shadow agreement. */
  shapeMeasures(): ShapeMeasuresDto;
  /** A project's "Send brainstorm messages to fast models"; throws NotFoundError for an unknown project. */
  getShapeJev(projectId: ProjectId): ShapeJevSettingDto;
  setShapeJev(projectId: ProjectId, input: ShapeJevSettingDto): ShapeJevSettingDto;
  /** Settings › General: the paths a task in needs a spec (Shape §7); the 10db defaults until the builder sets them. */
  getOneWayPaths(projectId: ProjectId): OneWayPathsDto;
  setOneWayPaths(projectId: ProjectId, input: OneWayPathsDto): OneWayPathsDto;
  /**
   * Settings › General: how large a lane's proposal can be, in characters, for 10db to file it to the
   * Icebox without an Inbox card. Zero sends every proposal to the Inbox.
   */
  getSmallProposalLimit(projectId: ProjectId): SmallProposalLimitDto;
  setSmallProposalLimit(projectId: ProjectId, input: SmallProposalLimitDto): SmallProposalLimitDto;
  /** Rehearse, and opening the Convert modal with an unrehearsed task (spec §7). */
  rehearseShape(shapeId: ShapeId, input: ShapeRehearseInput): ShapeRehearseResult;
  /** The builder dismisses a finding or a rehearsal question. */
  dismissShapeFinding(shapeId: ShapeId, findingId: ShapeFindingId, input: ShapeDismissInput): void;
  /** Ship anyway (from OPEN) or Retry (from FAILED). */
  shipBatch(id: BatchId): BatchDto;
  abandonBatch(id: BatchId): BatchDto;
  /**
   * Reads a goal brief from a path or its text, checks it and, unless `dryRun`, writes the goal in
   * `draft` with its tasks in one transaction. A refusal lists every error and writes nothing.
   * Throws NotFoundError for an unknown project.
   */
  adoptGoal(projectId: ProjectId, input: GoalAdoptInput): Promise<GoalAdoptResult>;
  /** Throws NotFoundError for an unknown goal. */
  getGoal(id: GoalId): GoalDto;
  listFlows(): FlowDto[];
  listWorkstreams(filter: { readonly active: boolean }): WorkstreamDto[];
  cancelWorkstream(id: WorkstreamId): Promise<WorkstreamDto>;
  retryWorkstream(id: WorkstreamId, note?: string): WorkstreamDto;
  /** The diff, commits and file counts of the workstream's work in its checkout, for the builder's check. */
  workstreamChanges(id: WorkstreamId): Promise<WorkstreamChangesDto>;
  /** With `recent`, only that many, the most recently updated first. */
  listInbox(filter: {
    readonly states: readonly InboxState[] | null;
    readonly recent: number | null;
  }): InboxItemDto[];
  answerInbox(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  eventsAfter(afterSeq: number, limit: number): DaemonEvent[];
  subscribe(listener: (event: DaemonEvent) => void): () => void;
  /** The system check; `recheck` probes the tools and gh's login again instead of answering from the last probe. */
  systemCheck(options: { readonly recheck: boolean }): Promise<SystemCheckDto>;
  keepAwake(): KeepAwakeStatus;
  setKeepAwake(mode: KeepAwakeMode): KeepAwakeStatus;
  /** Whether lanes decide routine permissions with Claude Code's auto mode; read when each session starts. */
  lanePermissions(): LanePermissionsDto;
  setLanePermissions(autoMode: boolean): LanePermissionsDto;
  /** The newest event seq (0 when there are none). */
  eventsHead(): number;
  /** Each server in the project's `.mcp.json` and its verdict; raises an approval card for each one with none. */
  reviewProjectMcp(projectId: ProjectId): McpServerStatusDto[];
  /** What a new project is prefilled from for the folder at `path`, or why it can't be one. */
  inspectFolder(path: string): Promise<FolderInspectResult>;
  /**
   * Areas for the repository at `path`, each with its globs and a reason, for a new project or for
   * Settings. Reads git's object store only and runs nothing the repository names. Aborting
   * `signal` (the caller went away) stops the model question and ends the process it started.
   */
  proposeAreas(path: string, signal?: AbortSignal): Promise<AreaProposalResult>;
  /** The hosts the project's tasks and checks may reach: its project-wide network rules, one per host. */
  listNetworkHosts(projectId: ProjectId): NetworkHostDto[];
  /**
   * Allows a host as a card's Always allow would. Throws InvalidError with the reason for a host the
   * sandbox profile can't list, loopback, or a pattern over a whole top-level domain; `created` is
   * false when the host was already allowed.
   */
  allowNetworkHost(
    projectId: ProjectId,
    host: string,
  ): { readonly host: NetworkHostDto; readonly created: boolean };
  /** Stops allowing a host; throws NotFoundError when it was not allowed. */
  removeNetworkHost(projectId: ProjectId, host: string): NetworkHostDto;
  /**
   * Reads the project's lockfiles, package manager settings and toolchain files again, as text and
   * without running anything, and answers the hosts they name that are not allowed, each with its
   * file. Allows nothing: the builder allows a host by name, after seeing it.
   */
  scanNetworkHosts(projectId: ProjectId): Promise<FoundHostDto[]>;
  listPersonas(): PersonaDto[];
  createPersona(input: PersonaInput): PersonaDto;
  patchPersona(id: PersonaId, patch: PersonaPatch): PersonaDto;
  listPeople(): PersonDto[];
  createPerson(input: PersonInput): PersonDto;
  createFlow(input: FlowInput): FlowDto;
  patchFlow(id: FlowId, patch: FlowPatch): FlowDto;
  listModelProfiles(): ModelProfileDto[];
  patchModelProfile(id: ModelProfileId, patch: ModelProfilePatch): ModelProfileDto;
  benchmarkStatus(): BenchmarkStatusDto;
  syncBenchmarks(): Promise<BenchmarkStatusDto>;
  /** AA's list as stored locally; the UI shows it only with AA's attribution. */
  listAaModels(): AaModelDto[];
  /** Throws InvalidError when the default landing names a branch origin does not have, after asking origin. */
  patchProject(id: ProjectId, patch: ProjectPatch): ProjectDto | Promise<ProjectDto>;
  getTeam(projectId: ProjectId): TeamDto;
  setTeam(projectId: ProjectId, input: TeamInput): TeamDto;
  listRoutingRules(projectId: ProjectId): RoutingRuleDto[];
  setRoutingRules(projectId: ProjectId, input: RoutingRulesInput): RoutingRuleDto[];
  patchTask(id: TaskId, patch: TaskPatch): TaskDto | Promise<TaskDto>;
  /** Places a task in a column between new neighbours; throws ConflictError for a stale or locked move. */
  moveTask(id: TaskId, move: TaskMove): TaskDto;
  listBoardColumns(projectId: ProjectId): BoardColumnDto[];
  createBoardColumn(projectId: ProjectId, input: BoardColumnInput): BoardColumnDto;
  patchBoardColumn(id: BoardColumnId, patch: BoardColumnPatch): BoardColumnDto[];
  /** Moves the column's tasks to another column or to planned, then deletes it. */
  deleteBoardColumn(id: BoardColumnId, del: BoardColumnDelete): BoardColumnDto[];
  /** What starting the task would run; throws InvalidError when no flow or profile fits. */
  stepPlan(taskId: TaskId): StepPlanDto;
  /**
   * The picker's proposal for the approval sheet; reads only. A `goalId` limits the pool to the
   * goal's tasks; a goal of another project throws InvalidError.
   */
  proposeCandidates(projectId: ProjectId, size: number, goalId?: GoalId): PickerProposalDto;
  listAccounts(): AccountDto[];
  /** Answers the account and, for a subscription, how to sign it in (accounts spec §5). */
  createAccount(input: AccountConfig): AccountCreatedDto;
  patchAccount(id: AccountId, patch: AccountPatch): AccountDto;
  archiveAccount(id: AccountId): AccountDto;
  /** Write-only: the secret goes to the Keychain; the answer carries `secretSet`, never the secret. */
  setAccountSecret(id: AccountId, input: AccountSecretInput): AccountDto;
  accountSignIn(id: AccountId): AccountSignInDto;
  /** Starts Claude Code on the account, with no prompt, to read who it is now. */
  accountIdentity(id: AccountId): Promise<AccountIdentityDto>;
  /** A month's tokens and dollars, in total and per project; `null` is the current month. */
  accountUsage(id: AccountId, month: string | null): AccountUsageDto;
  /** The accounts paused now, with why, since when and until when. */
  listAccountPauses(): AccountPauseDto[];
  /** Lifts a refused or monthly-cap pause and answers the pauses still in force; a usage-limit pause is a conflict. */
  resumeAccount(id: AccountId): AccountPauseDto[];
}
