import type {
  AaModelDto,
  AccountConfig,
  AccountCreatedDto,
  AccountDto,
  AccountId,
  AccountIdentityDto,
  AccountPatch,
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
  DaemonEvent,
  FlowDto,
  FlowId,
  FlowInput,
  FlowPatch,
  FolderInspectResult,
  InboxAnswer,
  InboxItemDto,
  InboxItemId,
  InboxState,
  KeepAwakeMode,
  KeepAwakeStatus,
  McpServerStatusDto,
  ModelProfileDto,
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
  TaskMove,
  TaskPatch,
  TeamDto,
  TeamInput,
  WorkstreamDto,
  WorkstreamId,
} from '@10db/contracts';

/** What starting a task made: its workstream in local delivery, the batch it runs in for pull requests. */
export type TaskStarted =
  | { readonly kind: 'workstream'; readonly workstream: WorkstreamDto }
  | { readonly kind: 'batch'; readonly batch: BatchDto };

/** What the HTTP layer needs from the daemon. Implemented in the daemon module. */
export interface ApiServices {
  listProjects(): ProjectViewDto[];
  createProject(input: ProjectInput): ProjectDto;
  listTasks(projectId: ProjectId): TaskDto[];
  createTask(projectId: ProjectId, input: TaskInput): TaskDto;
  startTask(taskId: TaskId): TaskStarted;
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
  retryWorkstream(id: WorkstreamId): WorkstreamDto;
  listInbox(filter: { readonly states: readonly InboxState[] | null }): InboxItemDto[];
  answerInbox(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  eventsAfter(afterSeq: number, limit: number): DaemonEvent[];
  subscribe(listener: (event: DaemonEvent) => void): () => void;
  systemCheck(): Promise<SystemCheckDto>;
  keepAwake(): KeepAwakeStatus;
  setKeepAwake(mode: KeepAwakeMode): KeepAwakeStatus;
  /** The newest event seq (0 when there are none). */
  eventsHead(): number;
  /** Each server in the project's `.mcp.json` and its verdict; raises an approval card for each one with none. */
  reviewProjectMcp(projectId: ProjectId): McpServerStatusDto[];
  /** What a new project is prefilled from for the folder at `path`, or why it can't be one. */
  inspectFolder(path: string): Promise<FolderInspectResult>;
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
  patchTask(id: TaskId, patch: TaskPatch): TaskDto;
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
}
