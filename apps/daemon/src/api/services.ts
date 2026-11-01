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
  InboxAnswer,
  InboxItemDto,
  InboxItemId,
  InboxState,
  KeepAwakeMode,
  KeepAwakeStatus,
  McpServerStatusDto,
  ModelProfileDto,
  NetworkHostDto,
  ModelProfileId,
  ModelProfilePatch,
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
  StepPlanDto,
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
}

/** What the HTTP layer needs from the daemon. Implemented in the daemon module. */
export interface ApiServices {
  listProjects(): ProjectViewDto[];
  /** Registers the project and allows the registries its package files name. */
  createProject(input: ProjectInput): Promise<ProjectDto>;
  listTasks(projectId: ProjectId): TaskDto[];
  /**
   * Throws InvalidError when the task's landing names a branch origin does not have, so the
   * answer may come after asking origin.
   */
  createTask(projectId: ProjectId, input: TaskInput): TaskDto | Promise<TaskDto>;
  /** Starts a task; a held one is queued again as the run it was, in any delivery mode. */
  startTask(taskId: TaskId): TaskStarted;
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
  /** Ship anyway (from OPEN) or Retry (from FAILED). */
  shipBatch(id: BatchId): BatchDto;
  abandonBatch(id: BatchId): BatchDto;
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
  /** The newest event seq (0 when there are none). */
  eventsHead(): number;
  /** Each server in the project's `.mcp.json` and its verdict; raises an approval card for each one with none. */
  reviewProjectMcp(projectId: ProjectId): McpServerStatusDto[];
  /** What a new project is prefilled from for the folder at `path`, or why it can't be one. */
  inspectFolder(path: string): Promise<FolderInspectResult>;
  /**
   * Areas for the repository at `path`, each with its globs and a reason, for a new project or for
   * Settings. Reads git's object store only and runs nothing the repository names.
   */
  proposeAreas(path: string): Promise<AreaProposalResult>;
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
  patchProject(id: ProjectId, patch: ProjectPatch): ProjectDto;
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
  /** The picker's proposal for the approval sheet; reads only. */
  proposeCandidates(projectId: ProjectId, size: number): PickerProposalDto;
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
