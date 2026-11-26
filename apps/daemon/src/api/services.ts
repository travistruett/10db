import type {
  AdmissionDto,
  StatusDto,
  AgentSkillInfo,
  AgentSkillStatus,
  CapacitySettingsDto,
  ChatCreateInput,
  ChatDto,
  ChatWork,
  ArchivePreviewDto,
  ArchiveRequest,
  ChatCommitRequest,
  ChatSearchPage,
  ChatSearchQuery,
  ChatWorkChoice,
  ChatWorkStateDto,
  ChatId,
  ChatModelsDto,
  FullAccessPreviewDto,
  ChatPatchInput,
  ProjectFileMatchDto,
  SessionsSettingsDto,
  SessionsSettingsPatch,
  TakeoverCommandDto,
  TakeoverDto,
  TakeoverPreviewDto,
  ConversationDeltaFrame,
  ConversationDto,
  ConversationFullDto,
  ConversationId,
  ConversationItemDto,
  ConversationItemId,
  ConversationItemsPage,
  ConversationLiveDto,
  FolderDto,
  FolderWhileHeld,
  Effort,
  KindDto,
  KindId,
  KindInput,
  KindOrderInput,
  KindPatch,
  PlaybookDto,
  PlaybookInput,
  PlaybookMoveEntry,
  Rigor,
  PlanDocumentRevisionDto,
  PlanRecordDto,
  PlanRecordList,
  PlanRecordPage,
  PlanRecordQuery,
  TaskPlanContextDto,
  PlanExportInput,
  PlanExportResult,
  PlanImportInput,
  PlanImportIssue,
  PlanImportPreview,
  PlanImportResult,
  AaModelDto,
  AccountConfig,
  AccountModelDto,
  AccountCreatedDto,
  AccountDto,
  AccountId,
  AccountConnectDto,
  AccountConnectingDto,
  AccountIdentityDto,
  AccountPatch,
  AccountPauseDto,
  AccountSecretInput,
  AccountSignInDto,
  AccountUsageDto,
  BatchDto,
  BatchId,
  BatchStartInput,
  BenchmarkKeyInput,
  BenchmarkStatusDto,
  BoardColumnDelete,
  CatalogueStatusDto,
  BoardColumnDto,
  BoardColumnId,
  BoardColumnInput,
  BoardColumnPatch,
  AreaProposalResult,
  DaemonEvent,
  FolderInspectResult,
  FoundHostDto,
  EvalManifest,
  NewEvalBody,
  EvalManifestResult,
  EvalModelsDto,
  EvalsDto,
  EvalSuiteDetailDto,
  HazardAssessmentDto,
  HazardLookAgainResult,
  GoalAdoptInput,
  GoalAdoptIssue,
  GoalAdoptPreview,
  GoalDigestDto,
  GoalDto,
  GoalId,
  GoalListDto,
  CardTypesDto,
  HumanTouchDto,
  RigorFiguresDto,
  AcceptanceFigures,
  RigorFiguresPeriod,
  InboxAnswer,
  StakeholderReplyInput,
  AskSomeoneInput,
  ComposePreviewDto,
  InboxItemDto,
  InboxItemId,
  InboxCardContextDto,
  InboxPageDto,
  ActivityPageDto,
  ActivityPageQuery,
  InboxPageQuery,
  InboxState,
  DecisionModelListDto,
  DecisionStatsListDto,
  JudgeCallDto,
  JudgeCallsPageDto,
  JudgeCallsPageQuery,
  JudgeConfigPatch,
  JudgeStatusDto,
  JudgeTestResultDto,
  KeepAwakeMode,
  ProjectWatchpointsDto,
  ProjectWatchpoints,
  WatchpointHitsDto,
  WatchpointStatsDto,
  YourWatchpoints,
  KeepAwakeStatus,
  LanePermissionsDto,
  LiveSystemsDto,
  TrustGrantDto,
  TrustGrantId,
  ProjectTrustDto,
  TrustOverrides,
  TrustSettingsDto,
  TrustSwitches,
  ApproveYourMcpServer,
  McpSignInsDto,
  StartMcpSignIn,
  McpServerStatusDto,
  RepoMcpServersDto,
  SetRepoMcpVerdict,
  LiveSystemProposalsDto,
  ModelProfileDto,
  ModelMeasuresDto,
  ModelRowDto,
  RolePicksDto,
  NetworkHostDto,
  ModelProfileId,
  ModelProfilePatch,
  DecisionId,
  GoalPassPagesDto,
  WorkbenchSetupDto,
  PassDto,
  PassId,
  PassOpenResponse,
  PassAbandonedDto,
  PassCloseAnswerDto,
  PassCloseContinueDto,
  PassClosePreviewDto,
  PassCloseRequest,
  PassJoinRequest,
  PassOpenRequest,
  PassPullRequestDto,
  PassPullRequestRequest,
  PassPullRequestPreviewDto,
  PassRename,
  PassSignOffDto,
  PassStartDto,
  PassTurnId,
  PassTurnWithFilesDto,
  TurnActivityDto,
  PassViewDto,
  TakeOutPreviewDto,
  TakeOutRequest,
  TakeOutResultDto,
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
  ShapeAttachmentId,
  ShapeConvertInput,
  ShapeConvertResult,
  ShapeDismissInput,
  ShapeDto,
  ShapeFileDto,
  ShapeFindingId,
  ShapeJevSettingDto,
  ShapeMeasuresDto,
  ShapeAcceptId,
  ShapeUndoAcceptResult,
  ShapeStartCountsDto,
  ShapeId,
  ShapeMessageDto,
  ShapeOfDto,
  ShapeProposalId,
  ShapeApprovalInput,
  ShapeRehearseInput,
  ShapeRehearseResult,
  ShapeViewDto,
  StartShapeInput,
  StepPlanDto,
  StartTaskInput,
  SystemCheckDto,
  TaskDto,
  ConversationFileId,
  TaskId,
  PersonId,
  QuestionRouteDto,
  SendInput,
  GithubSigninDto,
  GithubStatusDto,
  SlackStatusDto,
  SlackMemberDto,
  SlackTokenInput,
  ProjectIntegrationsDto,
  ProjectIntegrationsInput,
  ProjectSlackSharingDto,
  ProjectSlackSharingInput,
  SlackChannelsDto,
  FigmaPressInput,
  FigmaSignInsDto,
  LinearSignInsDto,
  ConnectableService,
  ConnectServiceDto,
  TaskLinearDto,
  LinearReporterSettings,
  StakeholderSendDto,
  StakeholderTimersDto,
  TaskMessageDto,
  TaskPictureKind,
  TaskScreenId,
  TaskScreensDto,
  TaskDesignCheckDto,
  DesignCheckId,
  PicturesStatusDto,
  TaskInput,
  RunNextResult,
  TaskMove,
  TaskPatch,
  WorkstreamChangesDto,
  ChangesScope,
  TaskSessionDto,
  SkippedActionDto,
  WorkstreamDto,
  WorkstreamId,
  DecisionEdit,
  DecisionItem,
  DecisionWrite,
  KnowledgeDryRunDto,
  KnowledgeListDto,
  KnowledgeListQuery,
  KnowledgeReason,
  PrincipleEdit,
  PrincipleId,
  PrincipleItem,
  PrincipleWrite,
  ProposalDto,
  ProposalId,
  ProposalListQuery,
  ProposalVerdictAccept,
  ProposalVerdictReject,
  ProvenanceDto,
  RigorSource,
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

/** What importing a planning effort came to: written, a dry run's preview, or every reason it was refused. */
export type PlanImportOutcome =
  | { readonly kind: 'imported'; readonly result: PlanImportResult }
  | { readonly kind: 'previewed'; readonly preview: PlanImportPreview }
  | { readonly kind: 'refused'; readonly errors: PlanImportIssue[] };

/** A Plan's record: importing a bundle into it (the route and the builder's `import_plan`). */
export interface PlanRecordServices {
  /** Reads, checks and imports a bundle into one Plan, all or nothing; a dry run writes nothing. */
  importPlan(projectId: ProjectId, input: PlanImportInput): Promise<PlanImportOutcome>;
  /** Writes the record as Markdown into a folder outside every checkout; refusals are InvalidErrors. */
  exportPlan(shapeId: ShapeId, input: PlanExportInput): Promise<PlanExportResult>;
  /** The record's documents with every revision, and how many rows each list holds. */
  getPlanRecord(shapeId: ShapeId): PlanRecordDto;
  /** One revision of a document, byte for byte; NotFoundError when there is none. */
  getPlanRevision(
    shapeId: ShapeId,
    documentId: ShapeAttachmentId,
    number: number,
  ): PlanDocumentRevisionDto;
  /** One page of a list, filtered and sorted here. */
  getPlanRecordPage(shapeId: ShapeId, list: PlanRecordList, query: PlanRecordQuery): PlanRecordPage;
  /** A task's pin, the Plan block its lane last got, and its newest anchor checks. */
  getTaskPlanContext(taskId: TaskId): TaskPlanContextDto;
}

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
export interface ApiServices extends PlanRecordServices {
  /** The judge's status, the account it runs on, and its call log. */
  judgeStatus(): Promise<JudgeStatusDto>;
  patchJudge(patch: JudgeConfigPatch): Promise<JudgeStatusDto>;
  /** One tiny decision call with that OpenRouter account's own key. */
  testAccount(id: AccountId): Promise<JudgeTestResultDto>;
  /** The most recent calls, newest first. */
  listJudgeCalls(limit: number): JudgeCallDto[];
  /** One page of the call log, newest first, filtered; `total` counts every call the filters match. */
  pageJudgeCalls(query: JudgeCallsPageQuery): JudgeCallsPageDto;
  /** What each decision's calls of the last 30 days came to. */
  judgeDecisionStats(): DecisionStatsListDto;
  /** OpenRouter's decision models; ConflictError with the judge off, UpstreamError when OpenRouter can't be read. */
  listDecisionModels(): Promise<DecisionModelListDto>;
  listProjects(): ProjectViewDto[];
  /** Projects the builder archived, for Restore. */
  listArchivedProjects(): ProjectDto[];
  /** Hides the project and stops its activity; ConflictError while work runs in it. Nothing is deleted. */
  archiveProject(projectId: ProjectId): void;
  restoreProject(projectId: ProjectId): void;
  /** Registers the project and allows the registries its package files name. */
  createProject(input: ProjectInput): Promise<ProjectDto>;
  listTasks(projectId: ProjectId): TaskDto[];
  /**
   * Throws InvalidError when the task's landing names a branch origin does not have, so the
   * answer may come after asking origin. A rigor in `input` is pinned as `rigorSource` says: the builder's
   * when left out, which is how the builder's own sessions (the Board, the API and the builder MCP) set it; a proposal's is the agent's.
   */
  createTask(
    projectId: ProjectId,
    input: TaskInput,
    rigorSource?: RigorSource,
  ): TaskDto | Promise<TaskDto>;
  /**
   * Resolves when the sizing in flight for these tasks has ended, or after a short wait, whichever is
   * first; never rejects. A start from the Board, the API or the builder's MCP awaits it before it reads
   * anything, so the rules and the judge have sized the task it starts.
   */
  settleSizing(taskIds: readonly TaskId[]): Promise<void>;
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
   * Opens a Workbench pass on the project's folder and writes each page's first message: the one
   * given, else the task's description when it has one. Refused (409) for whatever the open itself
   * refuses. A pass runs on the project's own account, Claude or Codex.
   */
  openPass(projectId: ProjectId, input: PassOpenRequest): Promise<PassOpenResponse>;
  /** Cancels the open that waits for chats' turns; whether there was one. */
  cancelPendingOpen(projectId: ProjectId): boolean;
  /** The pass as the Workbench reads it: its pages and every turn's timing. */
  passView(passId: PassId): PassViewDto;
  /**
   * Takes a page out of its pass (spec §5.4): its agent stopped, its work kept with the task, its files
   * put back as they were without it, and the task back on the Board, its shared changes chosen Drop
   * put back too. Refused (409) while the pass is not open or does not hold the task, and for a Drop
   * of a change that is not the page's to drop or that the preview would not offer; answers
   * `tookOut: false` when the page's files kept changing.
   */
  takeOutPage(passId: PassId, taskId: TaskId, input: TakeOutRequest): Promise<TakeOutResultDto>;
  /**
   * What taking the page out would ask (spec §7.2): each of its shared changes that has not landed,
   * with why Drop is not offered for it, if it is not, and the pages that changed its files later.
   */
  takeOutPreview(passId: PassId, taskId: TaskId): Promise<TakeOutPreviewDto>;
  /**
   * Abandons the pass (spec §5.4, D23): every unsigned page taken out and put back, the pass and its
   * batch `ABANDONED`, and the folder returned when nothing landed. A closing pass is taken over,
   * its close stopped, until its close has moved the return branch. Refused (409) once the pass is
   * none of open, closing below that step, or already abandoning.
   */
  abandonPass(passId: PassId): Promise<PassAbandonedDto>;
  /** Every live pass as the Workbench reads it: open, closing, abandoning, or closed and not settled. */
  livePasses(): PassViewDto[];
  /** What Start Pass shows before a pass opens on the project; reads the folder with git. */
  passStart(projectId: ProjectId): Promise<PassStartDto>;
  /**
   * Add Page: a task for each page named and the open tasks named join the open pass, each sent the
   * builder's first message only when there is one. Refused (409) while the pass is not open or full,
   * or for a task that can't join; (400) for a page it can't take.
   */
  addPassPages(passId: PassId, input: PassJoinRequest): Promise<PassViewDto>;
  /** Names the pass anew; refused (409) once it is settled or abandoned. */
  renamePass(passId: PassId, input: PassRename): PassDto;
  /** Discard Saved Work: forgets the task's saved Workbench work and deletes its kept ref; 409 in a pass. */
  discardKeptWork(taskId: TaskId): Promise<void>;
  /**
   * The Workbench setup: the project's areas rebuilt from its repository with a page per route, and
   * the settings it suggests and the branch's unpushed commits. Reads only; 404 for a project there is none of.
   */
  workbenchSetup(projectId: ProjectId, signal?: AbortSignal): Promise<WorkbenchSetupDto>;
  /** The page areas the goal's tasks committed in, read from git, for Work on This. */
  goalPassPages(goalId: GoalId): Promise<GoalPassPagesDto>;
  /** The task's turns, each with the files it changed against the turn before; reads git. */
  taskTurns(taskId: TaskId): Promise<PassTurnWithFilesDto[]>;
  /** A turn's log, oldest first (Show Log). */
  turnActivity(turnId: PassTurnId): TurnActivityDto[];
  /** Notes the builder opened the Ready page of this turn, the first time only; 409 for another task's turn. */
  openedTurn(taskId: TaskId, turnId: PassTurnId): void;
  /**
   * Signs off a Ready page (spec §9.2) in the background: its session ends, then the shared changes
   * it needs and its own files land, one commit each. Answers whether it lands now or waits for
   * another page's turn that holds a shared change it needs. Refused (409) while the pass is not
   * open or the page is not Ready.
   */
  signOffPage(passId: PassId, taskId: TaskId): PassSignOffDto;
  /** Cancels the page's sign-off that waits for another page's turn. Refused (409) when none waits. */
  cancelSignOff(passId: PassId, taskId: TaskId): void;
  /**
   * What Close Pass shows (spec §5.4, D25): the unfinished pages, the files no page owns, commits
   * 10db did not make, the summary, where the gate runs, and the lists' token. It stops nothing.
   */
  passClosePreview(passId: PassId): Promise<PassClosePreviewDto>;
  /**
   * Close Pass, confirmed: stops every agent of the pass, and closes in the background only when the
   * lists are still the ones the token names; otherwise answers them again with what changed.
   * Refused (409) while the pass is not open or Your folder is off its branch, and for choices the
   * lists do not allow.
   */
  closePass(passId: PassId, input: PassCloseRequest): Promise<PassCloseAnswerDto>;
  /**
   * Continue Close: the close of a closing pass whose job stopped goes on from its recorded step.
   * Refused (409) for a pass that is not closing.
   */
  continueClose(passId: PassId): PassCloseContinueDto;
  /** Whether Open Pull Request is offered for the pass (spec §8.3), why not, and what it would do. */
  passPullRequest(passId: PassId): Promise<PassPullRequestPreviewDto>;
  /**
   * Pushes the pass's branch and opens its draft pull request in the background, then gates and
   * reviews what it pushed. Refused (409) when it is not offered: nothing signed off, no origin or gh,
   * or the pass not open.
   */
  openPassPullRequest(passId: PassId, input: PassPullRequestRequest): Promise<PassPullRequestDto>;
  /**
   * Send to Agent (D19): sends the text a notice offers as the builder's message to the task: a notice
   * on its thread, or one in the header of the pass holding it, by id. Refused (409) for a notice that
   * offers nothing to send, and as a message to the task is.
   */
  sendToAgent(taskId: TaskId, noticeId: string): Promise<TaskMessageDto>;
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
   * What became of each type of Inbox card the project raised over the last 7 and 30 days. Throws
   * NotFoundError for an unknown project.
   */
  cardTypes(projectId: ProjectId): CardTypesDto;
  /**
   * What the project's tasks that became done in the last `days` days took, by rigor, and how often the
   * builder overrode the judge's sizing in the period. Throws NotFoundError for an unknown project.
   */
  rigorFigures(projectId: ProjectId, days: RigorFiguresPeriod): RigorFiguresDto;
  /**
   * The Board's acceptance counts for the last `days` days and whether acceptance is checking.
   * Throws NotFoundError for an unknown project.
   */
  acceptanceFigures(projectId: ProjectId, days: RigorFiguresPeriod): AcceptanceFigures;
  /**
   * The goal's digest for the builder opening it: Δ rows run from the previous view, and the view
   * advances to now. Throws NotFoundError for an unknown goal.
   */
  openGoalDigest(goalId: GoalId): GoalDigestDto;
  /** The project's Shape conversations, the one touched last first. Throws NotFoundError for an unknown project. */
  listShapes(projectId: ProjectId): ShapeDto[];
  /** Everything the Shape screen renders for the conversation. Throws NotFoundError for an unknown one. */
  getShapeView(id: ShapeId): ShapeViewDto;
  /**
   * Runs the conversation on `model` from its next turn, or on the `plan` role's with null, at `effort`
   * or, with null, the model's own default. Throws
   * InvalidError for a model the account doesn't offer and ConflictError while a turn runs.
   */
  chooseShapeModel(id: ShapeId, model: string | null, effort: Effort | null): ShapeDto;
  /**
   * Converts the selected proposals into goals, tasks and decisions and starts nothing. A refusal
   * lists every error and writes nothing; a turn that runs goes on.
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
  /**
   * Undo Accept: takes back the plan's latest Accept. InvalidError (400) for one undone or not the latest;
   * ConflictError (409), in words, for a task that has a run or a dependent.
   */
  undoShapeAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): ShapeUndoAcceptResult;
  /** What Accept and Start would do with these pending proposals, for the confirm; writes nothing. */
  shapeStartCounts(shapeId: ShapeId, proposalIds: readonly ShapeProposalId[]): ShapeStartCountsDto;
  /** Withdraw Decision: a decision the conversation wrote; throws ConflictError unless it is the head of its chain. */
  withdrawShapeDecision(shapeId: ShapeId, decisionId: DecisionId, reason: string): void;
  /** Withdraw Principle: a principle the conversation wrote; throws ConflictError once a later principle replaced it. */
  withdrawShapePrinciple(shapeId: ShapeId, principleId: PrincipleId, reason: string): void;
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
    file: { readonly name: string; readonly bytes: Uint8Array },
  ): Promise<ShapeFileDto>;
  /**
   * Keeps the builder's message and its pasted pictures. Throws NotFoundError for an unknown task and
   * InvalidError, naming what is refused, for an empty message or a file that is no PNG, JPEG or
   * WebP by its bytes. A message to a page of a Workbench pass goes to its agent; `redo` stops the
   * page's running turn first. Refused (409) while the pass is not open or the page is being taken out.
   */
  postTaskMessage(
    taskId: TaskId,
    input: {
      readonly text: string;
      readonly pictures: readonly { readonly name: string; readonly bytes: Uint8Array }[];
    },
    opts?: { readonly redo?: boolean },
  ): Promise<TaskMessageDto>;
  /**
   * Stops the running turn of a page of an open Workbench pass, keeping its work and raising nothing;
   * a page with no running turn is left as it is. Refused (409) for a task no open pass holds.
   */
  stopPage(taskId: TaskId): Promise<void>;
  /** A task's Linear issue (its own, or its source's for a follow-up) and its own updates, newest first. */
  taskLinearPosts(taskId: TaskId): TaskLinearDto;
  /** A task's pictures of the builder's app (Workbench spec §10), oldest first. */
  taskScreens(taskId: TaskId): TaskScreensDto;
  /** A picture's PNG; throws NotFoundError for a pruned or missing one. */
  screenPicture(screenId: TaskScreenId): Uint8Array<ArrayBuffer>;
  /** A task's newest design check, for its drawer. */
  taskDesignCheck(taskId: TaskId): TaskDesignCheckDto;
  /** A design check's mock-up picture, or one of its page shots by position; NotFoundError when none. */
  designCheckPicture(checkId: DesignCheckId, part: 'mockup' | number): Uint8Array<ArrayBuffer>;
  /** Settings › App Preview: the browser for pictures and the project's last sign-in. */
  picturesStatus(projectId: ProjectId): PicturesStatusDto;
  /** Restart Preview: runs the project's preview command again, its restarts forgotten. */
  restartPreview(projectId: ProjectId): Promise<void>;
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
  /** Approves a mock-up of the plan as the design target, or takes the approval back. */
  approveShapeAttachment(
    shapeId: ShapeId,
    attachmentId: ShapeAttachmentId,
    input: ShapeApprovalInput,
  ): void;
  /** Open in Figma or Bring Back from Figma on a mock-up: queues the ask for the plan's session. */
  figmaShapeAttachment(
    shapeId: ShapeId,
    attachmentId: ShapeAttachmentId,
    input: FigmaPressInput,
  ): { status: 'started' | 'running' };
  /** Opens a mock-up's Figma frame in the builder's browser. */
  openFigmaFrame(shapeId: ShapeId, attachmentId: ShapeAttachmentId): Promise<void>;
  /** Plan review on the given rows (or all); `tasks` counts the goals and loose tasks it reads. */
  reviewShape(shapeId: ShapeId, input: ShapeRehearseInput): ShapeRehearseResult;
  /** Design review on the given rows (or all): answers once the pictures are taken and the turn is queued. */
  designReviewShape(shapeId: ShapeId, input: ShapeRehearseInput): Promise<ShapeRehearseResult>;
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
  listWorkstreams(filter: { readonly active: boolean }): WorkstreamDto[];
  cancelWorkstream(id: WorkstreamId): Promise<WorkstreamDto>;
  retryWorkstream(id: WorkstreamId, note?: string): WorkstreamDto;
  /** The diff, commits and file counts of the workstream's work in its checkout, for the builder's check. */
  workstreamChanges(id: WorkstreamId, scope?: ChangesScope): Promise<WorkstreamChangesDto>;
  /** What a task's tab reads of it: where it works and what it came from. */
  taskSession(taskId: TaskId): TaskSessionDto;
  /** What the run skipped and the questions it was answered at once, oldest first. */
  listWorkstreamSkips(id: WorkstreamId): SkippedActionDto[];
  /** Run These Now from the task's drawer: the follow-up task that runs what the run skipped, approved. */
  runSkippedCalls(id: WorkstreamId): TaskDto;
  /** Every card in these states (all of them for null), most urgent and then oldest first. */
  listInbox(filter: { readonly states: readonly InboxState[] | null }): InboxItemDto[];
  /** One page of open, waiting or resolved cards, filtered and sorted; `total` counts every match. */
  pageInbox(query: InboxPageQuery): InboxPageDto;
  /** One page of notices, newest first, repeats grouped; `next` is null on the last page. */
  pageActivity(query: ActivityPageQuery): ActivityPageDto;
  /** The card's conversation's last messages; a `NotFoundError` for an unknown card. */
  inboxCardContext(id: InboxItemId): InboxCardContextDto;
  answerInbox(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  eventsAfter(afterSeq: number, limit: number): DaemonEvent[];
  subscribe(listener: (event: DaemonEvent) => void): () => void;
  /** The live frames of what conversations are streaming; never stored, never in the replay. */
  subscribeLive(listener: (frame: ConversationDeltaFrame) => void): () => void;
  /** Whether a conversation's chat has a plan, read from its rows alone; NotFoundError for one 10db lacks. */
  conversationHasPlan(id: ConversationId): boolean;
  /** An explore conversation as the UI reads it (sessions spec §10); NotFoundError for one 10db lacks. */
  getConversation(id: ConversationId): ConversationDto;
  /** A page of its items in `seq` order, after `afterSeq` when given. */
  conversationItems(id: ConversationId, afterSeq: number | null): ConversationItemsPage;
  /** What it streams now, for a client that joins or reconnects. */
  conversationLive(id: ConversationId): ConversationLiveDto;
  /**
   * A builder message, stored queued and taken by the conversation's owner, with the paths its `@`
   * mentions name and its pictures; a task's goes to its page's session as its thread's does.
   */
  postConversationMessage(
    id: ConversationId,
    message: {
      readonly text: string;
      readonly mentions: readonly string[];
      readonly pictures: readonly { readonly name: string; readonly bytes: Uint8Array }[];
      /** A chat's choice when Your folder is held; absent takes it when free, and reads only otherwise. */
      readonly folder?: FolderWhileHeld;
    },
  ): Promise<ConversationItemDto>;
  /** A picture sent with one of the conversation's messages; NotFoundError for any other file. */
  conversationPicture(
    id: ConversationId,
    fileId: ConversationFileId,
  ): { readonly bytes: Uint8Array<ArrayBuffer>; readonly mediaType: TaskPictureKind };
  /** The tracked files of the conversation's checkout an `@` query matches (sessions spec §11). */
  conversationFiles(id: ConversationId, q: string): Promise<ProjectFileMatchDto[]>;
  /** Sessions (spec §7.1, §10): the open tabs in strip order, across every project. */
  openChats(): ChatDto[];
  /** A project's chats that have had a message and are not archived, newest first. */
  recentChats(projectId: ProjectId, limit: number): ChatDto[];
  /** A title search across every session, open, closed or archived, newest activity first. */
  searchChats(query: ChatSearchQuery): ChatSearchPage;
  /** A new chat on the project's account; ConflictError, in words, on an account that runs none yet. */
  createChat(input: ChatCreateInput): ChatDto;
  /** Renames, moves or closes a tab, or picks a model between turns. */
  patchChat(id: ChatId, input: ChatPatchInput): Promise<ChatDto>;
  /** Ends the chat's session in whatever state it is in, then archives it and removes its folder. */
  /** Archives; a list of files at risk longer than the request's answers `{ archived: false }` with the fresh preview. */
  archiveChat(
    id: ChatId,
    request: ArchiveRequest,
  ): Promise<
    | { readonly archived: true; readonly chat: ChatDto }
    | { readonly archived: false; readonly preview: ArchivePreviewDto }
  >;
  unarchiveChat(id: ChatId): ChatDto;
  showChatPlan(id: ChatId): ChatDto;
  /** The builder's choice of where a session's work happens; `settled` is false when another choice had won. */
  chooseChatWork(
    id: ChatId,
    choice: ChatWorkChoice,
  ): Promise<{ readonly settled: boolean; readonly work: ChatWork }>;
  /** The title row's Commit: the files given, in the session's own folder; answers the state after it. */
  chatCommit(
    id: ChatId,
    request: ChatCommitRequest,
    signal: AbortSignal,
  ): Promise<ChatWorkStateDto>;
  /** The title row's Open Pull Request: pushes the session's branch and opens it; answers the state after. */
  chatPullRequest(id: ChatId, signal: AbortSignal): Promise<ChatWorkStateDto>;
  /** The title row's Merge: the session's pull request, or its branch into the base on a local project. */
  chatMerge(id: ChatId, signal: AbortSignal): Promise<ChatWorkStateDto>;
  /** What the session changed, for the drawer's Changes. */
  chatChanges(id: ChatId): Promise<WorkstreamChangesDto>;
  /** The git and GitHub facts the title row and the bar are drawn from; `signal` ends the GitHub read. */
  chatWorkState(id: ChatId, signal: AbortSignal): Promise<ChatWorkStateDto>;
  /** Stops a chat's wait for Your folder: what it queued runs reading only. */
  stopChatWaiting(id: ChatId): ChatDto;
  /** Who holds the project's checkout now, and the branch it is on. */
  projectFolder(projectId: ProjectId): Promise<FolderDto>;
  chatModels(projectId: ProjectId): ChatModelsDto;
  /** What the Full access confirmation says of where the chat's setup comes from. */
  fullAccessPreview(id: ChatId): FullAccessPreviewDto;
  sessionsSettings(): SessionsSettingsDto;
  setSessionsSettings(input: SessionsSettingsDto): SessionsSettingsDto;
  /** Sets the fields given and keeps the rest. */
  patchSessionsSettings(input: SessionsSettingsPatch): SessionsSettingsDto;
  /** Sessions spec §7.5: the chat in the builder's terminal. Refusals are ConflictError, in words. */
  openTakeover(id: ConversationId): Promise<TakeoverDto>;
  /** A fresh command to paste, for a chat that is in the terminal. */
  takeoverCommand(id: ConversationId): Promise<TakeoverCommandDto>;
  handBack(id: ConversationId): Promise<void>;
  /** NotFoundError when the chat isn't in the terminal. */
  takeoverOf(id: ConversationId): TakeoverDto;
  takeoverPreview(id: ConversationId): Promise<TakeoverPreviewDto>;
  /** Sends what waits under "Send now"; ConflictError, with the state's words, when nothing would run. */
  sendConversationNow(id: ConversationId): ConversationDto;
  /** Stops the turn; answers once it is stopping or settled. */
  stopConversation(id: ConversationId): Promise<ConversationDto>;
  /** Stops the turn and sends the edited message, with its pictures, as the next. */
  redoConversation(
    id: ConversationId,
    message: {
      readonly text: string;
      readonly pictures: readonly { readonly name: string; readonly bytes: Uint8Array }[];
      readonly folder?: FolderWhileHeld;
    },
  ): Promise<ConversationItemDto>;
  /** What an item keeps on disk past what it holds; NotFoundError when it keeps nothing. */
  conversationFull(id: ConversationId, itemId: ConversationItemId): ConversationFullDto;
  /** The system check; `recheck` probes the tools and gh's login again instead of answering from the last probe. */
  systemCheck(options: { readonly recheck: boolean }): Promise<SystemCheckDto>;
  keepAwake(): KeepAwakeStatus;
  setKeepAwake(mode: KeepAwakeMode): KeepAwakeStatus;
  /** Settings › Watchpoints: the builder's own list, which starts as the starters. */
  yourWatchpoints(): YourWatchpoints;
  /** Replaces the builder's whole list. */
  setYourWatchpoints(watchpoints: YourWatchpoints): YourWatchpoints;
  /** The watchpoints that apply in the project, each tagged with where it came from. */
  projectWatchpoints(projectId: ProjectId): ProjectWatchpointsDto;
  /** Replaces the project's whole list of its own watchpoints, overrides and `off` entries. */
  setProjectWatchpoints(projectId: ProjectId, entries: ProjectWatchpoints): ProjectWatchpointsDto;
  /** The run's newest watchpoint reading with the agent's and reviewer's notes on each file. */
  watchpointHits(id: WorkstreamId): WatchpointHitsDto;
  /** Each watchpoint's last 30 days in the project: tasks hit, cards raised and waved through. */
  watchpointStats(projectId: ProjectId): WatchpointStatsDto[];
  /** Settings › Agent skill: the shipped skill's switch, installed copy and links. */
  agentSkill(): AgentSkillStatus;
  setAgentSkill(enabled: boolean): AgentSkillStatus;
  /** The skill version this daemon ships; the route adds the build commit. */
  agentSkillInfo(): Pick<AgentSkillInfo, 'version'>;
  /** Settings › This Mac › Capacity: the lane cap across all projects and the free-disk floor. */
  capacitySettings(): CapacitySettingsDto;
  setCapacitySettings(input: CapacitySettingsDto): CapacitySettingsDto;
  /** What holds new lanes and gates now, for Factory, and the readings behind it. */
  admission(): AdmissionDto;
  /** The holds the header's status line shows now. */
  status(): StatusDto;
  /** Whether lanes decide routine permissions with Claude Code's auto mode; read when each session starts. */
  lanePermissions(): LanePermissionsDto;
  setLanePermissions(autoMode: boolean): LanePermissionsDto;
  /** Settings › Trust: the app-wide switches and the builder's installed plugins; read when each session starts. */
  trustSettings(): Promise<TrustSettingsDto>;
  setTrustSwitches(switches: TrustSwitches): Promise<TrustSettingsDto>;
  /**
   * Approves one of the builder's MCP servers as it is now; throws ConflictError when its config changed since
   * the page loaded or 10db can't run it, and InvalidError for a plugin's server.
   */
  approveYourMcpServer(input: ApproveYourMcpServer): Promise<TrustSettingsDto>;
  /** Each Codex account's sign-in to each OAuth server of the builder's, and the commands for Claude accounts. */
  mcpSignIns(): Promise<McpSignInsDto>;
  /**
   * Starts a Codex account's sign-in to one server, or opens its page again; throws NotFoundError for an
   * unknown account or server and ConflictError for an account that is not Codex or has no folder.
   */
  startMcpSignIn(input: StartMcpSignIn): Promise<McpSignInsDto>;
  /** A project's Trust: its overrides, the switches its sessions use, and what would come along; throws NotFoundError. */
  projectTrust(projectId: ProjectId): Promise<ProjectTrustDto>;
  setProjectTrust(projectId: ProjectId, overrides: TrustOverrides): Promise<ProjectTrustDto>;
  /** The hosts, cloud profiles and namespaces the judge treats as live in a project; throws NotFoundError. */
  liveSystems(projectId: ProjectId): LiveSystemsDto;
  /** Replaces them, trimmed and without duplicates; read when each session starts. */
  setLiveSystems(projectId: ProjectId, input: LiveSystemsDto): LiveSystemsDto;
  /** What 10db found in the repo that reads like a production system and isn't listed yet; throws NotFoundError. */
  liveSystemProposals(projectId: ProjectId): Promise<LiveSystemProposalsDto>;
  /** The checkout's `.mcp.json` servers and their verdicts, raising no card; throws NotFoundError. */
  repoMcpServers(projectId: ProjectId): RepoMcpServersDto;
  /**
   * Approves or denies one repo server for the exact config the page showed, answering its open card when
   * there is one; throws ConflictError when the config changed since, NotFoundError for an unknown server.
   */
  setRepoMcpVerdict(
    projectId: ProjectId,
    name: string,
    input: SetRepoMcpVerdict,
  ): RepoMcpServersDto;
  /** What the builder allowed in a project from now on (Always in this project), oldest first; throws NotFoundError. */
  trustGrants(projectId: ProjectId): TrustGrantDto[];
  /** Removes one of the project's grants; throws NotFoundError when the project has none by that id. */
  removeTrustGrant(projectId: ProjectId, grantId: TrustGrantId): void;
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
  /** The project's eval files at HEAD and result files from its checkout, with the recorded manifest laid over them; nothing is run. */
  evals(projectId: ProjectId): Promise<EvalsDto>;
  /** Every model the project's results graded, with its newest result per suite; nothing is run. */
  evalModels(projectId: ProjectId): Promise<EvalModelsDto>;
  /** One suite's drawer; throws NotFoundError for an unknown suite, or a run that is not one of its results. */
  evalSuite(
    projectId: ProjectId,
    key: string,
    run: string | undefined,
  ): Promise<EvalSuiteDetailDto>;
  /** Records an eval manifest unless it names a path HEAD does not track; nothing is kept then. */
  recordEvalManifest(projectId: ProjectId, manifest: EvalManifest): Promise<EvalManifestResult>;
  /**
   * Files the task that drafts an eval for the request, a normal task in the areas its files fall in; the
   * project's eval skill and suites are read at HEAD and nothing is run.
   */
  newEvalTask(projectId: ProjectId, request: NewEvalBody): Promise<TaskDto>;
  /** What 10db added to the project's hazards by itself and why, and how many removals wait on the builder. */
  getHazardAssessment(projectId: ProjectId): HazardAssessmentDto;
  /**
   * Reads the project's main checkout again and applies what it shows as the first look did:
   * additions at once, removals only through the Inbox card. Aborting `signal` (the caller went away)
   * stops the model question. A model that is unavailable or slow changes nothing.
   */
  lookAgainAtHazards(projectId: ProjectId, signal?: AbortSignal): Promise<HazardLookAgainResult>;
  /** Takes one of 10db's additions back out of its hazard; it is not added again. */
  undoHazardAddition(projectId: ProjectId, additionId: string): HazardAssessmentDto;
  listPersonas(): PersonaDto[];
  createPersona(input: PersonaInput): PersonaDto;
  patchPersona(id: PersonaId, patch: PersonaPatch): PersonaDto;
  listPeople(): PersonDto[];
  createPerson(input: PersonInput): PersonDto;
  updatePerson(id: PersonId, input: PersonInput): PersonDto;
  /** Removes a person; the builder, a goal's owner, a person on a criterion and a routed person stay. */
  removePerson(id: PersonId): void;
  /**
   * gh's login, probed when the last answer is older than a minute or `recheck` is set (which also
   * looks for gh again), plus the code and page of a Sign In that waits for the builder.
   */
  githubStatus(recheck: boolean): Promise<GithubStatusDto>;
  /** Runs `gh auth login --web`: 409 while one runs or gh is missing, 502 when gh prints no code. */
  startGithubSignin(): Promise<GithubSigninDto>;
  /** Stops the running sign-in; a no-op when none runs. */
  cancelGithubSignin(): void;
  /** Every signed-in Slack workspace as its reply watch last found it. */
  slackStatus(): SlackStatusDto;
  /** Checks the token with Slack, then keeps it in the Keychain; a refused token, or one for another team than `teamId`, is stored nowhere. */
  setSlackToken(input: SlackTokenInput): Promise<SlackStatusDto>;
  /** Signs a workspace out: its token and entry go; its contacts and project bindings stay. */
  removeSlackWorkspace(teamId: string): Promise<SlackStatusDto>;
  /** The GitHub login a project uses and the Slack workspace it is bound to. */
  projectIntegrations(projectId: ProjectId): Promise<ProjectIntegrationsDto>;
  /** From Linear: a Plan session that imports issues through the project's account; ConflictError when the account has no Linear. */
  importFromLinear(projectId: ProjectId): Promise<ChatDto>;
  /** Turns the project's Linear reporting on or off and keeps its note; off drops the updates still owed. */
  setLinearReporter(
    projectId: ProjectId,
    input: LinearReporterSettings,
  ): Promise<ProjectIntegrationsDto>;
  /**
   * Binds a project to a signed-in Slack workspace, or turns Slack off for it with a null team. The change takes back
   * what is out in another workspace (those cards go to the builder) and drafts again for the same people.
   */
  setProjectIntegrations(
    projectId: ProjectId,
    input: ProjectIntegrationsInput,
  ): Promise<ProjectIntegrationsDto>;
  /** How each agent account reaches Linear, from what is already read; it starts no probe. */
  linearSignIns(): Promise<LinearSignInsDto>;
  /** Adds, approves and signs in a service's server for the project's account; ConflictError says which step can't run. */
  connectService(service: ConnectableService, projectId: ProjectId): Promise<ConnectServiceDto>;
  figmaSignIns(): Promise<FigmaSignInsDto>;
  /** A workspace's people, optionally filtered; read from Slack at most every ten minutes. 409 when it is not signed in. */
  listSlackMembers(teamId: string, query: string): Promise<SlackMemberDto[]>;
  /** The channels of the project's Slack workspace, read at most every ten minutes; `missing_scope` when the token can't list them. 409 with no workspace. */
  projectSlackChannels(projectId: ProjectId): Promise<SlackChannelsDto>;
  slackSharing(projectId: ProjectId): ProjectSlackSharingDto;
  /** The switch and channel for posting a pass's pictures to Slack; a channel needs the project's workspace. */
  setSlackSharing(projectId: ProjectId, input: ProjectSlackSharingInput): ProjectSlackSharingDto;
  getStakeholderTimers(): StakeholderTimersDto;
  setStakeholderTimers(input: StakeholderTimersDto): StakeholderTimersDto;
  /** Who a task's questions go to, by scope. */
  questionRoutes(taskId: TaskId): QuestionRouteDto[];
  /** Sends a drafted question to its people (Send, and Send Anyway with `overrideLimit`). */
  sendInbox(id: InboxItemId, input: SendInput): Promise<StakeholderSendDto>;
  askSomeone(id: InboxItemId, input: AskSomeoneInput): InboxItemDto;
  takeBack(id: InboxItemId): Promise<InboxItemDto>;
  keepWaiting(id: InboxItemId): InboxItemDto;
  /** The builder's reply to a stakeholder's question, posted in its thread. */
  stakeholderReply(id: InboxItemId, input: StakeholderReplyInput): Promise<InboxItemDto>;
  composeFor(id: InboxItemId, personIds: PersonId[]): ComposePreviewDto;
  listModelProfiles(): ModelProfileDto[];
  patchModelProfile(id: ModelProfileId, patch: ModelProfilePatch): ModelProfileDto;
  /** The sync's last outcome; whether a key is set is read from the Keychain now. */
  benchmarkStatus(): Promise<BenchmarkStatusDto>;
  syncBenchmarks(): Promise<BenchmarkStatusDto>;
  /** Keeps the Artificial Analysis key in the Keychain and starts a sync with it; the status says it is running. */
  setBenchmarkKey(input: BenchmarkKeyInput): Promise<BenchmarkStatusDto>;
  removeBenchmarkKey(): Promise<BenchmarkStatusDto>;
  /** AA's list as stored locally; the UI shows it only with AA's attribution. */
  listAaModels(): AaModelDto[];
  /**
   * Every model any account can reach, one row each. With an account, a model it offers lists the efforts it
   * offers, priced on it. Throws NotFoundError for an unknown or archived account.
   */
  listModels(accountId?: AccountId): ModelRowDto[];
  /**
   * What routing chooses for each role on an account at the role's starting need, for a task with no settings
   * of its own, from the cells of `rigor` (Standard when left out) in a project's playbook, or the global one
   * when no project is given. Throws NotFoundError for an unknown or archived account or a missing project.
   */
  modelPicks(accountId: AccountId, rigor?: Rigor, projectId?: ProjectId): RolePicksDto;
  /**
   * The OpenRouter rows stored for one model (a catalogue id or an OpenRouter id), with the provider an account's
   * speed is measured on. Reads the database alone. Throws NotFoundError for an unknown or archived account.
   */
  modelMeasures(model: string, accountId?: AccountId): ModelMeasuresDto;
  /**
   * The playbook a project sees (its own overrides over the global ones over 10db's defaults), or, with null,
   * the global one. Throws NotFoundError for a missing project.
   */
  getPlaybook(projectId: ProjectId | null): PlaybookDto;
  /** Applies a form to one scope's playbook and answers what that scope now sees. */
  setPlaybook(projectId: ProjectId | null, input: PlaybookInput): PlaybookDto;
  /** The settings the move to the playbook could not carry over; empty once dismissed. */
  playbookMoveReport(): PlaybookMoveEntry[];
  dismissPlaybookMoveReport(): void;
  listKinds(): KindDto[];
  /** Throws ConflictError for a key another kind has. */
  createKind(input: KindInput): KindDto;
  patchKind(id: KindId, patch: KindPatch): KindDto;
  deleteKind(id: KindId): void;
  /** Puts a kind at a place in the list and answers the list. */
  moveKind(input: KindOrderInput): KindDto[];
  /** What each account offers, with its launch ID and its own price. */
  listAccountOffers(): AccountModelDto[];
  /** Where the model catalogue came from and when. */
  catalogueStatus(): CatalogueStatusDto;
  /**
   * Fetches the catalogue and reads every account's list now, and answers the catalogue's status. A call made
   * while a refresh runs joins it.
   */
  refreshModels(): Promise<CatalogueStatusDto>;
  /** Throws InvalidError when the default landing names a branch origin does not have, after asking origin. */
  patchProject(id: ProjectId, patch: ProjectPatch): ProjectDto | Promise<ProjectDto>;
  listRoutingRules(projectId: ProjectId): RoutingRuleDto[];
  setRoutingRules(projectId: ProjectId, input: RoutingRulesInput): RoutingRuleDto[];
  /** A rigor in `patch` is pinned as `rigorSource` says: the builder's when left out. */
  patchTask(id: TaskId, patch: TaskPatch, rigorSource?: RigorSource): TaskDto | Promise<TaskDto>;
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
  /** Starts an account's browser sign-in and answers the page to open, if the agent names one; its end is an `account.login_ended` event. */
  connectAccount(id: AccountId): Promise<AccountConnectDto>;
  /** The account whose sign-in holds the daemon's one slot, or null. */
  connectingAccount(): AccountConnectingDto | null;
  /** Abandons the account's waiting sign-in; with none waiting it does nothing. */
  cancelAccountConnect(id: AccountId): Promise<void>;
  /** A month's tokens and dollars, in total and per project; `null` is the current month. */
  accountUsage(id: AccountId, month: string | null): AccountUsageDto;
  /** The accounts paused now, with why, since when and until when. */
  listAccountPauses(): AccountPauseDto[];
  /** Lifts a refused or monthly-cap pause and answers the pauses still in force; a usage-limit pause is a conflict. */
  resumeAccount(id: AccountId): AccountPauseDto[];
  /**
   * One page of a project's decisions and principles together, builder-wide ones included, with how
   * many match in all. With `q` and a broken search index the list is empty and `search.available` is
   * false. Throws NotFoundError for an unknown
   * project and InvalidError for an area it lacks.
   */
  listKnowledge(projectId: ProjectId, query: KnowledgeListQuery): KnowledgeListDto;
  /** Records a decision; with `dryRun` writes nothing and says what would be written. */
  recordDecision(projectId: ProjectId, body: DecisionWrite): DecisionItem | KnowledgeDryRunDto;
  /** Replaces a current decision; a decision that isn't current is a ConflictError naming the one that is. */
  supersedeDecision(id: DecisionId, body: DecisionEdit): DecisionItem | KnowledgeDryRunDto;
  withdrawDecision(id: DecisionId, body: KnowledgeReason): DecisionItem | KnowledgeDryRunDto;
  decisionProvenance(id: DecisionId): ProvenanceDto;
  createPrinciple(projectId: ProjectId, body: PrincipleWrite): PrincipleItem | KnowledgeDryRunDto;
  supersedePrinciple(id: PrincipleId, body: PrincipleEdit): PrincipleItem | KnowledgeDryRunDto;
  retirePrinciple(id: PrincipleId, body: KnowledgeReason): PrincipleItem | KnowledgeDryRunDto;
  /** A proposed principle is a ConflictError naming the proposal to reject. */
  withdrawPrinciple(id: PrincipleId, body: KnowledgeReason): PrincipleItem | KnowledgeDryRunDto;
  principleProvenance(id: PrincipleId): ProvenanceDto;
  /** A project's principle proposals in one status, oldest first. */
  listProposals(projectId: ProjectId, query: ProposalListQuery): ProposalDto[];
  /** Confirms a proposed principle and closes its card; a decided proposal is a ConflictError. */
  acceptProposal(id: ProposalId, body: ProposalVerdictAccept): ProposalDto | KnowledgeDryRunDto;
  rejectProposal(id: ProposalId, body: ProposalVerdictReject): ProposalDto;
}
