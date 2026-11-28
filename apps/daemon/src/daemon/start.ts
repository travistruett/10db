import { createEvalCandidateList } from './eval-candidate-list';
import { applyAcceptanceAnswer } from '../acceptance';
import { applyWatchpointAnswer } from '../watchpoints';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import {
  AccountKind,
  Provider,
  ConversationOwnerKind,
  Delivery,
  type ChatId,
  type ConversationId,
  EventType,
  ConflictError,
  InvalidError,
  InboxItemId,
  JUDGE_TIMEOUT_MS,
  noOpenRouterSync,
  PROTOCOL_VERSION,
  RoutedBy,
  AgentSkillNotInstallable,
  harnessOf,
  requireHarness,
  WorkstreamId,
  WorkstreamState,
  type InboxAnswer,
  type InboxItemDto,
  type PrecedentScope,
  type ProjectDto,
  type AccountId,
  type Effort,
  type ConnectableService,
  type BatchId,
  type ProjectId,
  type ShapeId,
  type SystemCheckDto,
  type TaskId,
} from '@10db/contracts';
import {
  addStockHazardCommands,
  chatOfConversation,
  getChat,
  countBatchesInFlight,
  countWaitingOnCard,
  listOpenByFoldKeyPrefix,
  listRunningGates,
  isLaneWaitingOnCard,
  getBatch,
  getInboxItem,
  createStore,
  DB_MIGRATIONS_DIR,
  deleteAppSetting,
  getWorkstreamRow,
  deleteJudgeCallsBefore,
  deleteSessionEventsEndedBefore,
  findAccountRow,
  lanesByAccount,
  getAccountRow,
  listModelProfiles,
  listAccountModels,
  listAccounts,
  getAppSetting,
  getJudgeConfig,
  getProject,
  getSession,
  getTask,
  listPermissionRules,
  listActiveProjects,
  listProjects,
  migrateDatabase,
  openDatabase,
  patchAccount,
  refuseGatewayAccounts,
  seedDefaultAccount,
  setAppSetting,
} from '@10db/db';
import { HARNESS_PLUGIN_DIR, readDefaultPersonas, readSkillBody } from '@10db/harness';
import { WebSocketServer } from 'ws';
import {
  createAccountCardAnswers,
  createAccountLimits,
  createAccountMoves,
  createAccountPauses,
  createAccountPreparer,
  createAccountRuntime,
  createAccountService,
  createModelListWait,
  createListRefresh,
  createMcpSignIns,
  createMoveBack,
  MoveCause,
  giveOpenRouterHomes,
  removeLegacyOpenRouterKey,
  createStartGate,
  createUsageReports,
  type AccountLimits,
} from '../accounts';
import { createPushService, createVapidKeyStore, startPushSender } from '../push';
import { createApp, type SelfUpdateServices } from '../api';
import { Listener } from '../listeners';
import {
  createBenchmarkSync,
  createOpenRouterSync,
  type BenchmarkSync,
  type OpenRouterSync,
} from '../benchmarks';
import {
  createAccountLists,
  createCatalogueSync,
  readCatalogueSnapshot,
  reconcileProfiles,
  resumeModelMarks,
  type Catalogue,
} from '../catalogue';
import {
  createDecisionModelList,
  createJudge,
  createJudgeOutageWatch,
  type JudgeCallHealth,
  JUDGE_LOG_RETENTION_MS,
  type JudgeService,
} from '../judge';
import { createBenchmarkServices } from './benchmark-services';
import { checkoutState } from './checkout-state';
import { keepSocketsAlive } from './socket-keepalive';
import { createSizingService } from '../sizing';
import { settleSecondOpinionModel } from './decision-offer';
import { createJudgeCredentialReader, createJudgeServices } from './judge-services';
import {
  createLinearImport,
  answerReporterCard,
  createLinearReporter,
  reporterConversations,
  reporterHooks,
  reporterSettings,
  subscribeLinearEvents,
  type LinearReporter,
} from '../linear';
import { createServiceConnector } from './connect-service';
import { createLinearSignIns } from './linear-sign-ins';
import { createFigmaSignIns } from './figma-sign-ins';
import { createReporterLaunch } from './reporter-launch';
import { createStakeholderApiServices } from './stakeholder-services';
import {
  boundTeam,
  cleanUpSlackSignIns,
  createReplyWatches,
  createSlackClients,
  createSlackConnections,
  createStakeholderSends,
  createTimerWatch,
  createTriage,
  draftOnOpen,
  projectSlack,
  readSlackSharing,
  routedAway,
  sweepDrafts,
  type SlackClients,
} from '../stakeholders';
import { createTrustServices } from './trust-services';
import { createProjectTrustServices } from './project-trust-services';
import {
  backupBeforeMigrating,
  backupDatabase,
  hasPendingMigrations,
  pruneBackups,
  scheduleNightlyBackup,
} from '../backups';
import { systemClock, type Clock } from '../clock';
import {
  createDeviceService,
  createPairingCodes,
  createSocketRegistry,
  createTickets,
} from '../devices';
import {
  createSharingService,
  createTailscaleRun,
  findTailscaleCli,
  readTailnetName,
  TAILNET_NAME_TIMEOUT_MS,
  lsofHolderOf,
  startShareListener,
} from '../sharing';
import {
  allCheckouts,
  createBaseUpdates,
  createDependencyChanges,
  createMigrationsBase,
  createBatchCardAnswers,
  createBranchCardAnswers,
  createCiStopAnswers,
  createGhCardAnswers,
  createStartCardAnswers,
  createLostMigrationsAnswers,
  createWorktreeCardAnswers,
  createBatchStarter,
  createDeliveryJobs,
  createPrWatch,
  answerPassMoveCard,
  createKeptWorkGate,
  createPassPullRequests,
  createSlackPicturePost,
  type SlackPicturePost,
  passGateKind,
  createShipper,
  createNodeModulesTemplates,
  createWorktreeDependencies,
  createWorktreeGenerators,
  createCopyTeardown,
  DEFAULT_DELIVERY_LIMITS,
  flagWorktreeMissing,
  flagWrongBranch,
  resolveBranchReadyCards,
  moveRetiredLandings,
  checkPassOpen,
  openPass,
  readPnpmVersion,
  recoverBatches,
  closeFinishedSkippedCards,
  resolveOverBatchCards,
  closeGoneMergedWorktreeCards,
  createHandMadeFolderLook,
  removeMergedBranches,
  resolvePnpm,
  resumePassSettles,
  copyIdForBatch,
  subscribeCopyQueue,
  subscribeKeptWorkLanding,
  subscribePassSettles,
  subscribePrWatch,
  subscribeShipTrigger,
  applySkippedChoice,
  raiseSkippedCard,
  skipFollowUpStarter,
  sweepUnlistedRuns,
  templatesRoot,
  type DeliveryContext,
  type DeliveryLimits,
  type PassOpenDeps,
} from '../delivery';
import type { LogLevel } from '../env';
import {
  AccountLaunchError,
  ACCOUNT_NAMES_VERIFIED_ON,
  AgentState,
  AgentTool,
  CODEX_VERIFIED_ON,
  ModelNotLaunchableError,
  sessionConfigDir,
  createLauncher,
  exportAwsCredentials,
  downloadFile,
  ensurePinned,
  extractZipWithTar,
  REQUIRED_TOOLS,
  slackBotAccount,
  unavailableKeychain,
  type AgentTools,
  type Keychain,
  type GhLoginProbe,
  type ResolvedTools,
  accountAgentOf,
} from '../environment';
import { outboundFetch } from '../outbound';
import {
  createEventBus,
  createLiveFrames,
  createStateStore,
  type LiveFrames,
  type StateStore,
} from '../events';
import { createGit, memoryPinStore, resolveGit, runGit } from '../git';
import { readCommitted, readComposeServices } from '../folders';
import { createHazardAssessor, subscribeHazardAssessment } from '../hazards';
import {
  announceCoverage,
  backgroundSubjects,
  createWatchpointCoverage,
  subscribeWatchpointCoverage,
} from '../watchpoints';
import {
  createGh,
  createSystemGhExec,
  resolveGh,
  spawnGhLogin,
  type Gh,
  type GhLoginSpawn,
  type GhTools,
} from '../github';
import { createGithubServices } from './github-services';
import {
  applyPrecedentConflictAnswer,
  applySignInSetupChoice,
  cannotSignInCard,
  CardTier,
  clearPictureSignInCard,
  createInboxService,
  createJudgeOutageCard,
  createParkAnswers,
  createPrecedentService,
  leftWithBuilder,
  raiseNoSignInOffer,
  raisePictureSignInCard,
  withdrawStaleConversationCards,
} from '../inbox';
import { repairKnowledgeIndex } from '../knowledge';
import { backfillAttachmentRevisions } from '../plan-record';
import { guessPendingPageLabels, seedPendingPageLabels } from './page-label-guess';
import { createAgentSkill, type AgentSkillPlacement } from '../agent-skill';
import { createKeepAwake, systemCaffeinate, type CaffeinateSpawner } from '../keep-awake';
import {
  capacitySettings,
  createDiskHold,
  createLaneTempDirs,
  createLoadMonitor,
  systemFreeBytes,
  type LoadMonitorOptions,
} from '../load';
import { createLogger, openLogFile, rotateLogFile, type Logger } from '../log';
import { protectedPaths } from '../guard';
import { createBuilderMcpHandler, createBuilderTools } from '../builder';
import type { LaneBrief } from '../briefing';
import {
  createExploreEngine,
  createLiveRegistry,
  createTaskThread,
  pictureLimitsFor,
} from '../conversation';
import {
  chatFolder,
  chatHooks,
  createChatLiveSessions,
  createChatService,
  applyChatWorkAnswer,
  chatRoot,
  createChatWorkService,
  createChatWorkStateReader,
  createTitleRowGit,
  type ChatWorkService,
  finishSeals,
  createChatTools,
  createConversationFiles,
  sessionsSettings,
} from '../chat';
import {
  ClaimWaits,
  createClaimDeadlockAnswers,
  createMcpHandler,
  forgetEndedYields,
  mintSessionToken,
  withdrawStaleClaimWaits,
} from '../mcp';
import {
  answerMoveToCopy,
  answerPassCard,
  askSignOff,
  cancelSignOffWait,
  closeGateOf,
  createPassCloses,
  discardKeptWork,
  createPendingOpens,
  type OpenWhenBusyDeps,
  joinPass,
  putBackKeptWork,
  resumePassWork,
  startAbandon,
  startSignOff,
  type SignOffDeps,
  subscribeMergedPasses,
  subscribeSignOffWaits,
  takeOut,
  type AbandonDeps,
  type MoveToCopyDeps,
  type PassWorkDeps,
  type TakeOutDeps,
} from '../pass';
import {
  BROWSER_PIN,
  createBrowserHost,
  createBrowserLaunches,
  createPlaywrightCamera,
  createSignInReporter,
  launchChromium,
  refusedCamera,
  MISSED_AFTER_MS,
  startPictures,
  startPruning,
  type PageCamera,
  type Pictures,
} from '../pictures';
import {
  createLaneBrowsers,
  systemPortReaders,
  type LaneBrowsers,
  type LaunchLaneDriver,
  type PortReaders,
  launchPlaywrightDriver,
} from '../lane-browser';
import { startPreview, type Preview } from '../preview';
import { recoverOnStartup, systemProcesses, type ProcessTerminator } from '../recovery';
import { offeredModels } from '../routing';
import { createScreenBroker, createScreens, devUiMayRead, renderMayRead } from '../screens';
import {
  createShapeJev,
  createShapeService,
  gitTrackedFiles,
  shapeAgentModels,
  type ShapeLaunch,
} from '../shape';
import { createKnowledgeServices } from './knowledge-services';
import { createPlanRecordServices } from './plan-record-services';
import { createShapeServices } from './shape-services';
import { createConversationServices } from './conversation-services';
import { createChatApiServices } from './chat-services';
import { createChatChanges } from './chat-changes';
import { createChatMove } from './chat-move';
import { createChatWorktrees } from './chat-worktrees';
import {
  createFullAccessPreparer,
  createReporterPreparer,
  createShapePreparer,
  createTakeoverPreparer,
} from './shape-session-tools';
import {
  applyCheckAnswer,
  applyPlanAnswer,
  RunnerNotStartedError,
  type StartSignOff,
  createLiveSessions,
  createRunner,
  DEFAULT_RUNNER_LIMITS,
  handOverEdits,
  type Runner,
  type RunnerLimits,
  type StopPassLane,
  startTurnChecks,
  subscribeLaneTakeOut,
  TURN_CHECK_TIMEOUT_MS,
  withTurnChecks,
} from '../runner';
import { resolveSandboxRuntime } from '../paths';
import {
  claimSandboxRoots,
  createGateSandbox,
  createLaneSandbox,
  createLedgerSweep,
  reapLaneProcessLedgers,
  secretFilesIn,
  dockerAccess,
  sweepSystemTempDirs,
  sweepSystemTempFiles,
  type SweepReport,
  systemProcessTable,
  tmutilExclusion,
  type BackupExclusion,
  type LaneProcessSetup,
  type LedgerSweep,
  type SandboxRuntime,
} from '../sandbox';
import { createFolderHold } from '../folder-hold';
import { createStatusService } from '../status';
import { createAdmission, createQueueWaits, createScheduler, type Scheduler } from '../scheduler';
import { createStallCardAnswers, createStallSweep } from '../stalls';
import {
  createDrain,
  createScriptInstaller,
  createSelfUpdate,
  createSelfUpdateCardAnswers,
  githubHeadOfMain,
  githubMainIsAhead,
  holdBoth,
  midSessionWork,
  cannotUpdate,
  selfUpdateSetting,
  selfUpdateWaitMinutes,
  setSelfUpdateChoice,
  setSelfUpdateWaitMinutes,
  type BuildInfo,
  type ScriptInstaller,
  type SelfUpdate,
} from '../self-update';
import {
  codexHomeProviderOf,
  apiKeyHelperCommand,
  codexHomes,
  connectorProbeRoot,
  markOnboarded,
  sweepConnectorProbeRoot,
  type AgentAdapter,
} from '../sessions';
import {
  createOpener,
  createTakeoverService,
  liveTakeoverTempDirs,
  prepareTakeover,
  type TakeoverServers,
  type TakeoverService,
  type TakeoverSource,
} from '../takeover';
import { conversationRun, planConversationModel, routingInputs, seedTeam } from '../team';
import { createGateRunner, createGateSlots, GatePriority, limitGates } from '../verify';
import { CLIENT_APP } from '../version';
import { createWatcher, systemWatch, type WatchFn } from '../watcher';
import { autoDocker } from './auto-docker';
import { GATE_HOLD_RETRY_MS, holdStaleGates } from './gate-hold';
import { commandCallsDocker, MAX_DOCKER_SCAN_BYTES, originBaseCommit } from './docker-need';
import { createAppStart, type AppStart } from '../app-start';
import { createProjectPinStore } from './checkout-pins';
import { resolveNoticeCards } from './notice-sweep';
import {
  createCheckoutTrustedHandler,
  createGitCardAnswers,
  createGitRefusalHandler,
  refusedTrustCheckouts,
} from './git-refusal';
import { acquireInstanceLock } from './instance-lock';
import { takeFrozenKill } from './frozen-kill';
import { devUiToken, removeRuntimeFiles, writeRuntimeFiles } from '../runtime-files';
import { createAnswerWriter } from './answer-writer-launch';
import { createAreaNamer } from './area-namer';
import { systemListeners, type ListenerReader } from './listening-ports';
import { loopbackProbe, type AddressProbe } from './loopback-probe';
import {
  createEvalLiveRuns,
  createEvalSweeps,
  createEvalsAssessor,
  createEvalsService,
  createEvalSuggester,
  subscribeEvalAssessment,
} from '../evals';
import { createServices } from './services';
import {
  allSandboxRootsOf,
  keepRootsOutOfBackups,
  laneWrittenRootsOf,
  namedSandboxRoots,
  openSandboxRoots,
  sandboxDepsOf,
  sandboxesFor,
  type SandboxRootOptions,
} from './sandbox-roots';
import { assertWorktreeRootAllowed, DEFAULT_WORKTREE_BASE, worktreeRootFor } from './worktree-root';

/** How long one Slack call may take before it counts as unreachable. */
const SLACK_TIMEOUT_MS = 15_000;
/** How often a post Slack refused is tried again while its Inbox item is open. */
const SLACK_PICTURE_RETRY_MS = 15 * 60_000;
/** How long a finished task's session.context and session.activity rows are kept. */
const SESSION_EVENTS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Rows deleted per write, so the writer lock is held briefly and other work runs between batches. */
const SESSION_EVENTS_PRUNE_BATCH = 2_000;

export interface DaemonOptions {
  readonly dataDir: string;
  readonly port: number;
  /** An adapter, or a factory that gets the daemon's logger (the Claude adapter logs into daemon.log). */
  readonly adapter: AgentAdapter | ((logger: Logger) => AgentAdapter);
  readonly logLevel: LogLevel;
  /**
   * The sandbox every lane and every gate runs under. Its roots (tests) move what it makes off the
   * machine's: `tmpRoot` the temp dirs of Claude lanes, gates and MCP servers (`laneTempRoot()`),
   * `codexLaneTempRoot` a ChatGPT lane's (`~/.10db/lanes`), `filesRoot` the sealed files, env files
   * and process ledgers (`~/.10db/run`), and `systemTempRoots` the system temp dirs every ChatGPT
   * lane writes (`SYSTEM_TEMP_ROOTS`), swept once the daemon listens. `runtime` (tests) replaces srt,
   * which runs the gate. Required,
   * so no caller can forget it: null runs lanes and gates unsandboxed, which only fake sessions and
   * tests ask for, and the Claude adapter refuses such a session. `processes` (tests) replaces how
   * lane processes are read and signalled, for the sessions and for the start-up sweep of a dead
   * daemon's leftovers. `backups` (tests) replaces `tmutil addexclusion`, which asks Time Machine to
   * skip each root.
   */
  readonly sandbox:
    | (SandboxRootOptions & {
        readonly runtime?: SandboxRuntime;
        readonly processes?: LaneProcessSetup;
        readonly backups?: BackupExclusion;
      })
    | null;
  /**
   * Where worktrees are made: a base directory, under which a level named after the data dir is
   * added. Defaults to `~/.10db/worktrees`. Nothing is created there until the first worktree is cut.
   */
  readonly worktreeRoot?: string;
  /**
   * The builder's home, whose instructions, skills and installed plugins come along into each session
   * (Settings › Trust). Defaults to the user's home; tests give a temp one.
   */
  readonly builderHome?: string;
  /**
   * Whether this daemon installs the shipped `10db-task` skill into the builder's home, and where the
   * shipped copy is. Absent: from source, nothing is installed.
   */
  readonly agentSkill?: AgentSkillPlacement;
  /** better_sqlite3.node for bundled runs; source runs leave it unset. */
  readonly sqliteBinding?: string;
  readonly clock?: Clock;
  /**
   * The browser for pictures of the builder's app (Workbench spec §10): the pinned Chromium (the entry
   * point), or a camera given with how its build is fetched (tests pass a fake one). Absent, the daemon
   * takes no pictures and fetches nothing, so an in-process test never downloads a browser.
   */
  readonly pictures?:
    | { readonly kind: 'pinned' }
    | { readonly kind: 'given'; readonly camera: PageCamera; readonly prepare: () => void };
  /**
   * The lane browser: the pinned build (the entry point), or a driver tests give. Absent, lanes get no
   * browser tools and nothing is fetched.
   */
  readonly laneBrowser?:
    | { readonly kind: 'pinned' }
    | { readonly kind: 'given'; readonly launch: LaunchLaneDriver; readonly readers: PortReaders };
  /**
   * Lane caps across all projects; each account has its own `laneCap`. Absent, the cap is the
   * Capacity setting, read at each tick.
   */
  readonly caps?: { readonly global: number };
  /**
   * Watch free disk and hold new lanes below the Capacity floor. Off unless given, so a test never
   * reads the runner's disk; the entry point turns it on unless `TENDB_DISK=off`. `freeBytes`
   * replaces the volume read (tests); absent, it reads the volume the worktree root is on.
   */
  readonly disk?: { readonly freeBytes?: () => number | null };
  /** Recovery attempts, fix attempts, the gate timeout and the gate slots; merged over the runner defaults. */
  readonly limits?: Partial<RunnerLimits>;
  /** How long a lane lease lasts before the scheduler renews it. */
  readonly leaseMs?: number;
  /** How often the scheduler looks for work when nothing asks it to. */
  readonly tickMs?: number;
  /** How long a start from the Board, the API or the builder's MCP waits for sizing in flight; 4 s when left out. */
  readonly sizingWaitMs?: number;
  /** The GitHub CLI wrapper; tests pass a fake. */
  readonly gh?: Gh;
  /** Starts `gh auth login` for Sign In; tests pass a fake, so none signs in for real. */
  readonly githubLoginSpawn?: GhLoginSpawn;
  /** The login environment fetch, push and gh run in (main.ts builds it from the login shell). */
  readonly networkEnv?: () => Readonly<Record<string, string>>;
  readonly deliveryLimits?: Partial<DeliveryLimits>;
  /** How often shipped pull requests are read; defaults to 2 minutes. */
  readonly prWatchIntervalMs?: number;
  /** How long a provider stays paused when its usage limit gives no reset time. */
  readonly defaultPauseMs?: number;
  /** The environment sessions and gates start from: the captured login shell in production. */
  readonly loginEnv?: Readonly<Record<string, string>>;
  /** Where account secrets are read and written: the login Keychain in production. */
  readonly keychain?: Keychain;
  readonly processes?: ProcessTerminator;
  readonly migrationsDir?: string;
  /** The builder's Artificial Analysis key (the Keychain in production); absent means no sync. */
  readonly aaKey?: () => string | null;
  /** `TENDB_BENCHMARKS=off`: the key is neither read nor written, and the status says off. */
  readonly benchmarksOff?: boolean;
  /** Sharing finds and runs no Tailscale CLI (`TENDB_TAILSCALE=off`). */
  readonly tailscaleOff?: boolean;
  /** The Tailscale CLI to run (`TENDB_TAILSCALE_CLI`), in place of the search for the installed one. */
  readonly tailscaleCli?: string;
  /** The built served app the share listener serves at `/app/`; absent when this build carries none. */
  readonly appDir?: string | null;
  readonly fetch?: typeof fetch;
  /** The `fetch` a Plan session's Figma tools post a mock-up with and read assets with; the real one by default. */
  readonly figmaFetch?: typeof fetch;
  /**
   * Fetch the model catalogue from models.dev and keep it fresh. Off unless given, so a test never reaches
   * the network; the entry point turns it on unless `TENDB_CATALOGUE=off`.
   */
  readonly catalogueSync?: boolean;
  /** The file holding the catalogue the release embeds, read when nothing is stored; absent or missing means none. */
  readonly catalogueSnapshot?: string;
  /**
   * Talk to Slack with the bot token in the Keychain. Off unless given, so a test never reaches the
   * network; the entry point turns it on unless `TENDB_SLACK=off`.
   */
  readonly slack?: boolean;
  /** `TENDB_JUDGE=off`: the OpenRouter key is never read and no decision calls OpenRouter. */
  readonly judgeOff?: boolean;
  /** How every lane's brief carries its Plan and knowledge (`TENDB_LANE_BRIEF`); absent pastes them whole. */
  readonly laneBrief?: LaneBrief;
  /**
   * Read OpenRouter's scores and per-provider speed with the decisions account's key. Off unless given, so a
   * test never reaches the network; the entry point turns it on unless a kill switch is set. Never runs with
   * `judgeOff` or `benchmarksOff`.
   */
  readonly openRouterSync?: boolean;
  /** What listens on this Mac, for the Workbench setup's app address; `lsof` unless given. */
  readonly listeners?: ListenerReader;
  /** Whether a loopback address answers, for the Workbench setup's app address; one GET unless given. */
  readonly probe?: AddressProbe;
  /** The harness plugin folder the default personas are read from. */
  readonly harnessDir?: string;
  readonly allowedOrigins?: readonly string[];
  /** The one browser origin to accept beside `allowedOrigins` or the webview's (`TENDB_DEV_UI_ORIGIN`). */
  readonly devUiOrigin?: string;
  /** A fixed UI token (dev and Playwright); otherwise a random one per start. */
  readonly uiToken?: string;
  /** The live channel conversations stream on; one is made when none is given. */
  readonly liveFrames?: LiveFrames;
  readonly caffeinate?: CaffeinateSpawner;
  /** The system check, given the git and gh the daemon resolved so it reports the ones it runs. */
  readonly systemCheck?: (
    resolved: ResolvedTools,
    ghLogin: GhLoginProbe,
  ) => Promise<SystemCheckDto>;
  /** The pinned Claude Code and Codex the daemon runs; the system check reports them. None where nothing is managed (tests). */
  readonly agents?: AgentTools;
  /** `false` turns the file watcher off (tests that don't need it). */
  readonly watch?: WatchFn | false;
  /**
   * What this bundle was built from (main.ts reads `build-info.json`); absent for a run from source,
   * which shows no commit and never updates itself. The bundle replaces itself only when `updatable`.
   */
  readonly build?: BuildInfo | null;
  /** Self-update overrides: tests pass a short interval, a fake head of main and a fake installer. */
  readonly selfUpdate?: {
    readonly intervalMs?: number;
    readonly headOf?: (repo: string) => Promise<string>;
    readonly isAhead?: (repo: string, base: string, head: string) => Promise<boolean>;
    readonly installer?: ScriptInstaller;
  };
  /** What reads the load and the busy processes, and how much and how long counts as overloaded; tests replace them. */
  readonly load?: Pick<
    LoadMonitorOptions,
    'read' | 'processes' | 'sampleMs' | 'overloadFactor' | 'sustainedMs' | 'clearFactor'
  >;
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly mcpUrl: string;
  readonly token: string;
  readonly state: StateStore;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly benchmarks: BenchmarkSync;
  /**
   * Fetches the catalogue, reads every account's list again, rebuilds the model profiles and then updates scores. A
   * call during a run joins it. With `force` every account is read even when the fetch failed; without it a failed
   * fetch leaves alone the accounts read in the last day. Does nothing when `catalogueSync` is off.
   */
  refreshModels(opts: { readonly force: boolean }): Promise<void>;
  /** What routine decisions ask; reads the OpenRouter key from `keychain` for each call. */
  readonly judge: JudgeService;
  stop(): Promise<void>;
}

/** The Tauri webview's origins. A browser origin, such as a Vite dev UI, is opted in by `devUiOrigin`. */
const UI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;
/** Written by stop() after every runner has stopped; its absence at start means the last run crashed. */
const CLEAN_SHUTDOWN_KEY = 'daemon.clean_shutdown';

/** The session env when none is wired (tests): enough PATH for a gate to find git and test. */
const DEFAULT_SESSION_PATH = '/usr/bin:/bin';

const DEFAULTS = {
  leaseMs: 60_000,
  tickMs: 2_000,
  defaultPauseMs: 30 * 60_000,
  nightlyBackupHour: 3,
  nightlyBackupsKept: 7,
  preMigrateBackupsKept: 5,
  /** How often main is looked at: one cheap gh call a minute, so a new commit is seen within one. */
  selfUpdateIntervalMs: 60_000,
} as const;

/** Used when no system check is wired (tests): every tool reads as not found. */
function noSystemCheck(): Promise<SystemCheckDto> {
  return Promise.resolve({
    loginEnv: { source: 'inherited', warning: 'The login environment was not captured' },
    claudeCode: { verifiedOn: ACCOUNT_NAMES_VERIFIED_ON, warning: null },
    codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
    tools: REQUIRED_TOOLS.map((t) => ({
      name: t.name,
      path: null,
      version: null,
      required: t.required,
      signedIn: null,
    })),
    agents: [],
    benchmarkSync: null,
  });
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  // Every outbound call the daemon makes goes through this one fetch.
  const outbound = opts.fetch ?? outboundFetch;
  // Before anything runs git: the one git every daemon git call runs, from a fixed install prefix,
  // never a PATH, and only one that can be told to read no attributes.
  const gitBin = await resolveGit();
  // gh from the same prefixes; a missing one fails each gh call as not installed, as the system check says.
  let ghBin = resolveGh();
  // Read on every call, so a gh installed after startup (found again on Check Again) is the one run.
  const ghTools: GhTools = {
    get gh() {
      return ghBin;
    },
    git: gitBin,
  };
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  mkdirSync(join(opts.dataDir, 'logs'), { recursive: true });
  // On the system clock, not the injected one: the waits here are for another process.
  const lock = await acquireInstanceLock(opts.dataDir);
  const logPath = join(opts.dataDir, 'logs', 'daemon.log');
  rotateLogFile(logPath);
  const logFile = openLogFile(logPath);
  logFile.keepRotated(clock);
  const logger = createLogger({ level: opts.logLevel, destination: logFile.destination });
  /**
   * Ends the log file and waits for its descriptor to close. A stop right after start would otherwise
   * leak the descriptor, and the stream's late open fails once a test has removed the data directory.
   */
  const closeLog = (): Promise<void> => logFile.close();
  const adapter = typeof opts.adapter === 'function' ? opts.adapter(logger) : opts.adapter;
  // A probe that a crash cut off leaves its scratch folders; none is ever reused.
  await sweepConnectorProbeRoot(connectorProbeRoot(opts.dataDir)).catch((error: unknown) => {
    logger.warn({ err: error }, 'could not empty the connector probe folder');
  });

  const db = openDatabase(
    join(opts.dataDir, '10db.sqlite'),
    opts.sqliteBinding ? { nativeBinding: opts.sqliteBinding } : {},
  );
  const migrationsDir = opts.migrationsDir ?? DB_MIGRATIONS_DIR;
  const backupsDir = join(opts.dataDir, 'backups');
  if (hasPendingMigrations(db, migrationsDir)) {
    const { removed, failed } = await backupBeforeMigrating(
      db,
      backupsDir,
      startedAt,
      DEFAULTS.preMigrateBackupsKept,
    );
    if (removed.length > 0) {
      logger.info({ removed: removed.length }, 'old pre-migrate backups removed');
    }
    if (failed.length > 0) {
      logger.warn({ failed }, 'old pre-migrate backups could not be removed');
    }
  }
  migrateDatabase(db, migrationsDir);
  // Before anything parses an account: a retired kind would fail there with no hint of what to remove.
  refuseGatewayAccounts(db);
  // An index out of step with its table is rebuilt and logged; one that can't be rebuilt leaves search
  // off (the list route says so) and the daemon running. No card: it asks the builder nothing.
  const knowledgeIndex = repairKnowledgeIndex(db, logger.child({ component: 'knowledge' }));

  // The sandbox's roots, made private before anything is put there. A refused one refuses every lane
  // session and gate, as a temp dir the sandbox can't make does.
  const sandboxRoots = opts.sandbox ? openSandboxRoots(opts.sandbox, homedir()) : null;
  /** Logs what a sweep of the system temp dirs removed, or which daemon's mark kept it. */
  const logSweep = (report: SweepReport, what: string): void => {
    if (report.removed === 0 && report.failed === 0 && report.sharedWith === null) return;
    logger.info(
      { removed: report.removed, failed: report.failed, sharedWith: report.sharedWith },
      `swept ${what} from the system temp dirs`,
    );
  };
  // The roots lanes write: Claude lanes', ChatGPT lanes', and the system temp dirs, which Codex's base
  // policy opens to every ChatGPT lane. With no sandbox no lane runs, so none is.
  const laneWrittenRoots = sandboxRoots === null ? [] : laneWrittenRootsOf(sandboxRoots);
  const allSandboxRoots = sandboxRoots === null ? [] : allSandboxRootsOf(sandboxRoots);
  const builderHome = opts.builderHome ?? homedir();
  // Where this daemon's worktrees live, as a real path. A root that could hold lane-written files or
  // the daemon's own is refused before anything else starts.
  let worktreeRoot: string;
  try {
    worktreeRoot = worktreeRootFor(opts.worktreeRoot ?? DEFAULT_WORKTREE_BASE, opts.dataDir);
    assertWorktreeRootAllowed(worktreeRoot, {
      checkouts: listProjects(db).map((project) => project.repoPath),
      dataDir: opts.dataDir,
      sandboxRoots: allSandboxRoots,
    });
  } catch (error) {
    db.$client.close();
    lock.release();
    await closeLog();
    throw error;
  }

  const bus = createEventBus((error) => {
    logger.error({ err: error }, 'event listener failed');
  });
  const state = createStateStore(
    createStore(db, () => clock.now()),
    bus,
  );
  const folderHold = createFolderHold({ state, bus });
  // Opens of a pass that wait for chats' turns: memory only, so a restart drops them.
  const pendingOpens = createPendingOpens({ state });
  const liveFrames =
    opts.liveFrames ??
    createLiveFrames((error) => {
      logger.error({ err: error }, 'live frame listener failed');
    });
  // Specs and evals kept before revisions existed get their revision 1, before anything reads them.
  backfillAttachmentRevisions(state);
  // The projects there are when page labels first ship wait for a label guess; later ones never do.
  seedPendingPageLabels(state);
  // A malformed persona file throws and the daemon doesn't start, the same policy as a failed migration.
  seedTeam(state, readDefaultPersonas(opts.harnessDir ?? HARNESS_PLUGIN_DIR));
  // Projects keep the hazard lists they were added with; give them the stock commands added since, once.
  state.write((ctx) => {
    addStockHazardCommands(ctx);
  });
  const agentSkill = createAgentSkill({
    state,
    placement: opts.agentSkill ?? {
      kind: 'not_installable',
      reason: AgentSkillNotInstallable.FromSource,
      shippedDir: null,
    },
    home: builderHome,
    logger,
  });
  // A failed install is kept for Settings and never stops the daemon.
  agentSkill.atStart();
  const launcher = createLauncher({
    base: opts.loginEnv ?? { PATH: DEFAULT_SESSION_PATH },
    clientApp: CLIENT_APP,
    keychain: opts.keychain ?? unavailableKeychain,
  });
  // The builder's current login is the default account, so a project made without one binds to it: the
  // login shell's own Claude Code directory, else Claude Code's default.
  const seeded = state.write((ctx) =>
    seedDefaultAccount(ctx, { expectedIdentity: null, configDir: launcher.loginConfigDir() }),
  );
  // A relative login directory was ignored, so the default account landed on Claude Code's default directory: say so when it is seeded.
  const ignoredLoginDir = launcher.loginConfigDirWarning();
  if (seeded && ignoredLoginDir) logger.warn({}, ignoredLoginDir);
  const benchmarks = createBenchmarkSync({
    state,
    clock,
    fetch: outbound,
    readKey: opts.aaKey ?? (() => null),
    logger: logger.child({ component: 'benchmarks' }),
  });
  benchmarks.start();
  // The accounts' lists and the refresh that follows each fetch are made further down, once the adapter and the
  // start gate exist; they are named here so the catalogue can reach them when it runs.
  let snapshot: { readonly value: Catalogue | null } | undefined;
  const catalogue = createCatalogueSync({
    state,
    clock,
    fetch: outbound,
    logger: logger.child({ component: 'catalogue' }),
    snapshot: () => {
      // The file is part of the install and does not change while the process runs.
      snapshot ??= {
        value: opts.catalogueSnapshot ? readCatalogueSnapshot(opts.catalogueSnapshot) : null,
      };
      return snapshot.value;
    },
    onChanged: (changed) => {
      rebuildProfiles(changed);
    },
    afterSync: (fetched) => refreshAccountModels(fetched),
  });
  const accountLists = createAccountLists({
    state,
    clock,
    catalogue: () => catalogue.catalogue(),
    logger: logger.child({ component: 'catalogue' }),
  });
  const judgeKeychain = opts.keychain ?? unavailableKeychain;
  const decisionModels = createDecisionModelList({ fetch: outbound, clock });
  const readJudgeCredential = createJudgeCredentialReader({
    state,
    keychain: judgeKeychain,
    off: opts.judgeOff === true,
  });
  // The inbox is built after the judge, so the outage watch is set once it exists.
  let watchJudgeOutage: ((health: JudgeCallHealth) => void) | null = null;
  const judge = createJudge({
    state,
    clock,
    onCallHealth: (health) => watchJudgeOutage?.(health),
    fetch: outbound,
    decisionModelIds: () => decisionModels.ids(),
    readCredential: readJudgeCredential,
    off: opts.judgeOff === true,
    logger: logger.child({ component: 'judge' }),
  });
  /** The live OpenRouter accounts, the one Decisions run on first. */
  const liveOpenRouterAccounts = (): AccountId[] => {
    const decisions = getJudgeConfig(state.db).accountId;
    return listAccounts(state.db)
      .filter((a) => !a.archived && a.kind === AccountKind.OpenRouter)
      .map((a) => a.id)
      .sort((a, b) => Number(b === decisions) - Number(a === decisions));
  };
  // OpenRouter's scores and speeds are read with the decisions account's key, and never under either kill switch.
  const openRouterSync: OpenRouterSync | null =
    opts.openRouterSync === true && opts.judgeOff !== true && opts.benchmarksOff !== true
      ? createOpenRouterSync({
          state,
          clock,
          fetch: outbound,
          readKey: async () => {
            // The Decisions account's key when it is an OpenRouter account, else any live OpenRouter account's; an
            // Anthropic key or a Bedrock token must never go to openrouter.ai.
            for (const id of liveOpenRouterAccounts()) {
              const credential = await readJudgeCredential(id);
              if (credential?.kind === AccountKind.OpenRouter) return credential.key;
            }
            return null;
          },
          offered: () => {
            const live = new Set(
              listAccounts(state.db)
                .filter((a) => !a.archived)
                .map((a) => a.id),
            );
            return new Set(
              listAccountModels(state.db)
                .filter((m) => !m.unusable && live.has(m.accountId))
                .map((m) => m.model),
            );
          },
          catalogue: () => catalogue.catalogue(),
          decisionModelIds: async () => {
            try {
              return (await decisionModels.list()).models
                .filter((m) => m.cantCall === null)
                .map((m) => m.id);
            } catch {
              return [];
            }
          },
          logger: logger.child({ component: 'benchmarks' }),
        })
      : null;
  giveOpenRouterHomes(state, join(opts.dataDir, 'accounts'));
  // The key an older version kept in its own item is not used any more; an OpenRouter account holds its own.
  if (opts.judgeOff !== true) removeLegacyOpenRouterKey(judgeKeychain, logger);
  // A config saved before the second opinion on limits existed reads with OpenRouter's model for it.
  if (opts.judgeOff !== true)
    state.write((ctx) => {
      const decisions = getJudgeConfig(ctx.tx).accountId;
      settleSecondOpinionModel(
        ctx,
        decisions === null ? undefined : findAccountRow(ctx.tx, decisions),
      );
    });
  openRouterSync?.start();
  state.write((ctx) =>
    deleteJudgeCallsBefore(
      ctx,
      new Date(clock.now().getTime() - JUDGE_LOG_RETENTION_MS).toISOString(),
    ),
  );
  const instanceId = randomUUID();
  const live = createLiveSessions();
  const limits: RunnerLimits = { ...DEFAULT_RUNNER_LIMITS, ...opts.limits };
  const processes = opts.processes ?? systemProcesses;
  let mcpUrl = '';
  // The inbox, pauses and runner call into each other, so each reaches the others through these
  // references; they are set before anything can fire a callback.
  let runner: Runner | null = null;
  let chatWorkRef: ChatWorkService | null = null;
  let scheduler: Scheduler | null = null;
  // A waiting update drains the factory: no lane, session, task gate or ship starts until it installs.
  const updateDrain = createDrain();
  // Up from the moment an install takes over until the app quits or the install fails. An install at
  // an idle moment has no drain, and a Shape turn does not go through the scheduler it pauses.
  const installHold = createDrain();
  // A task that starts waiting for a claim may be waiting on one that needs a lane to finish.
  const claimWaits = new ClaimWaits({
    onWait: () => {
      scheduler?.requestTick();
    },
    // During the drain a holder that runs nothing (queued, parked before its next session or gate, or
    // waiting on a card with a live session) frees no claim until the update installs. A wait on it
    // would keep its session running, and the update waits for that session to end, so the wait is
    // refused and the session ends by itself.
    parked: (id) =>
      updateDrain.draining &&
      runner !== null &&
      (!runner.isRunning(id) || runner.isParked(id) || isLaneWaitingOnCard(state.db, id)),
  });
  let answerBatchCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerStallCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerAccountCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerGitCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerSelfUpdateCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  // Started once recovery is through; a launch before then waits for no before picture.
  let pictures: Pictures | null = null;
  // The on-demand pictures of a Design review and `check_design`, which run well after the pictures start.
  const picturesNow: Pick<Pictures, 'shootNow' | 'drawMockup' | 'bytesOf'> = {
    shootNow: (input) =>
      pictures?.shootNow(input) ?? Promise.reject(new Error('Pictures have not started yet')),
    drawMockup: (projectId, html) =>
      pictures?.drawMockup(projectId, html) ??
      Promise.reject(new Error('Pictures have not started yet')),
    bytesOf: (sha256) => pictures?.bytesOf(sha256) ?? 0,
  };
  let preview: Preview | null = null;
  let appStart: AppStart | null = null;
  // The API's port, once it listens: an app address may not name it, and no picture is taken before.
  let listenPort: number | null = null;
  const listening = Promise.withResolvers<number>();
  let answerBranchCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerCiStopCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerGhCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerStartCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerLostMigrationsCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerWorktreeCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerPassCards: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let startPageSignOff: StartSignOff | null = null;
  // Starts the follow-ups Run these now made, once the services that start tasks exist.
  let startFollowUps = (): void => undefined;
  // Starts the task Set Up Sign-In made, once the services that start tasks exist.
  let startSignInSetup: (taskId: TaskId) => void = () => undefined;

  // A claim deadlock card's answer makes a task yield its claim, or cancels it as the Board does.
  const answerDeadlockCard = createClaimDeadlockAnswers({
    state,
    cancel: (id) => {
      if (!runner) throw new RunnerNotStartedError();
      return runner.cancel(id);
    },
    waits: claimWaits,
    log: logger,
  });
  // "Park the task" on a lane's question stops the run, as a cancel from the Board does, and parks it.
  const parkAnswers = createParkAnswers({
    state,
    cancel: (id) => {
      if (!runner) throw new RunnerNotStartedError();
      return runner.cancel(id);
    },
    log: logger,
  });
  // Slack is reached only when the entry point turned it on, and only with the bot token in the Keychain.
  const slackClients: SlackClients | null =
    opts.slack === true
      ? createSlackClients({
          state,
          keychain: judgeKeychain,
          fetch: outbound,
          clock,
          timeoutMs: SLACK_TIMEOUT_MS,
        })
      : null;
  const sends = createStakeholderSends({
    state,
    slack: slackClients,
    clock,
    log: logger.child({ component: 'stakeholder-sends' }),
    hasToken: async (teamId) => (await judgeKeychain.readAsync(slackBotAccount(teamId))) !== null,
    slackFor: (projectId) => projectSlack(state.db, projectId).teamId,
    boundTo: (projectId) => boundTeam(state.db, projectId),
    parkFor: (id) => {
      runner?.parkFor(id);
    },
  });
  const draftOpts = {
    afterDraft: (id: InboxItemId): void => {
      sends.afterDraft(id).catch((error: unknown) => {
        logger.warn({ err: error, cardId: id }, 'a drafted question could not be sent');
      });
    },
    log: logger.child({ component: 'drafts' }),
  };
  // A question no explicit route claimed is routed by the judge right after its card commits.
  const triage = createTriage({
    state,
    judge,
    log: logger.child({ component: 'triage' }),
    // A card routed away from the builder is drafted, and the sessions waiting on it park, so the
    // stakeholder's words are answered through the card and never reach a live ask_human call.
    afterRouted: (id) => {
      const after = state.write((ctx) => draftOnOpen(ctx, getInboxItem(ctx.tx, id), draftOpts));
      // Read after the draft, which hands a person's card back to the builder for want of Slack. A
      // card that now goes to someone else parks its sessions; one left with the builder waits live,
      // except in a lane nobody watches, which answers at once.
      const routed = getInboxItem(state.db, id);
      if (routedAway(routed)) runner?.parkFor(id);
      else if (leftWithBuilder(routed))
        inbox.answerAwayWaits(id, (sessionId) => live.get(sessionId)?.away !== undefined);
      after?.();
    },
  });
  // Standing approvals: candidates, their card and the answers. It reads the base through `git`, made below.
  const precedents = createPrecedentService({
    state,
    clock,
    log: logger.child({ component: 'precedents' }),
    readerFor: (project) => readCommitted(git, project, project.repoPath),
  });
  const inbox = createInboxService({
    state,
    judgeOff: opts.judgeOff === true,
    parkWaiting: (id) => {
      runner?.parkFor(id);
    },
    onQuestionOpened: (ctx, item) =>
      item.routedBy === RoutedBy.TriagePending
        ? () => {
            void triage.run(item.id);
          }
        : draftOnOpen(ctx, item, draftOpts),
    onParkedAnswer: (target, item) => {
      runner?.deliverParkedAnswer(target, item);
    },
    onParkAnswer: parkAnswers,
    log: logger,
    onFlagAnswerInWrite: (ctx, item, answer) => {
      const retried = answerReporterCard(ctx, item, answer);
      applyPrecedentConflictAnswer(ctx, item, answer);
      const madeRoutine: { programKey: string; scope: PrecedentScope }[] = [];
      let after: (() => void) | undefined;
      if (
        applySkippedChoice(ctx, item, answer, (kind) => {
          madeRoutine.push(kind);
        })
      ) {
        after = () => {
          startFollowUps();
          // The hash of what each kind runs is read once the answer is committed.
          if (madeRoutine.length > 0) void precedents.settleHashes(item.projectId, madeRoutine);
        };
      } else {
        const setUp = applySignInSetupChoice(ctx, item, answer);
        if (setUp !== null)
          after = () => {
            startSignInSetup(setUp);
          };
        else if (chatWorkRef !== null)
          after = applyChatWorkAnswer(chatWorkRef, logger, ctx, item, answer);
      }
      if (retried === null) return after;
      return () => {
        after?.();
        lateLinearReporter?.wake(retried);
      };
    },
    onCheckAnswer: (ctx, item, answer) => {
      const signOffPage = startPageSignOff;
      if (!runner || !signOffPage) throw new RunnerNotStartedError();
      return applyCheckAnswer(runner, ctx, item, answer, signOffPage);
    },
    onAcceptanceAnswer: (ctx, item, answer) => {
      applyAcceptanceAnswer(ctx, item, answer);
    },
    onWatchpointAnswer: (ctx, item, answer) => {
      applyWatchpointAnswer(ctx, item, answer);
    },
    onPlanAnswer: (ctx, item, answer) => {
      if (!runner) throw new RunnerNotStartedError('plan');
      return applyPlanAnswer(runner, ctx, item, answer);
    },
    onFlagAnswer: (item, answer) => {
      runner?.retryTurn(item, answer);
      answerBatchCard?.(item, answer);
      answerAccountCard?.(item, answer);
      answerGitCard?.(item, answer);
      answerSelfUpdateCard?.(item, answer);
      answerBranchCard?.(item, answer);
      answerCiStopCard?.(item, answer);
      answerGhCard?.(item, answer);
      answerStartCard?.(item, answer);
      answerLostMigrationsCard?.(item, answer);
      answerWorktreeCard?.(item, answer);
      answerPassCards?.(item, answer);
      answerDeadlockCard(item, answer);
      answerStallCard?.(item, answer);
    },
  });
  const watch = createJudgeOutageWatch({
    clock,
    logger: logger.child({ component: 'judge' }),
    sink: createJudgeOutageCard({ state, inbox }),
  });
  watchJudgeOutage = watch;
  // A card a stopped daemon left is closed at once when the judge is off.
  if (opts.judgeOff === true) watch({ kind: 'off' });
  // Holds that pause work and end by themselves show as a line in the app's header, not as Inbox cards.
  const status = createStatusService({
    clock,
    onChange: (dto) => {
      state.write((ctx) => {
        ctx.emit({
          type: EventType.StatusChanged,
          entityType: 'app',
          entityId: 'status',
          data: dto,
        });
      });
    },
  });
  // A lane that finds no model profile for its account waits for the profiles instead of retrying every tick.
  const modelWait = createModelListWait({
    db,
    clock,
    inbox,
    status,
    logger: logger.child({ component: 'catalogue' }),
    onReleased: () => {
      scheduler?.requestTick();
    },
  });
  /**
   * Writes the model profiles from `catalogue` and ends the wait of every account they now cover. The rebuild is
   * idempotent, so it runs from a fetch, an account list, the catalogue the daemon already holds at start and
   * when an account is created, with no network.
   */
  function rebuildProfiles(from: Catalogue): void {
    state.write((ctx) => {
      reconcileProfiles(ctx, from);
    });
    modelWait.release((id) => {
      const provider = harnessOf(getAccountRow(db, id));
      return listModelProfiles(db).some((p) => p.provider === provider);
    });
  }
  // Sustained overload holds new lane sessions and gates and shows a status line naming what is busy.
  const laneTempDirs = createLaneTempDirs();
  const loadGuard = createLoadMonitor({
    state,
    inbox,
    status,
    clock,
    logger: logger.child({ component: 'load' }),
    daemonPid: process.pid,
    tempRoot: sandboxRoots?.temp ?? null,
    tempDirs: laneTempDirs,
    onCleared: () => {
      scheduler?.requestTick();
    },
    ...opts.load,
  });
  // What holds a lane's next session and a task's gate: an overloaded Mac, or the drain. Low disk
  // holds only new lanes: a lane that has started finishes, and its ship frees the disk.
  const startHold = holdBoth([loadGuard, updateDrain]);
  const diskHold = createDiskHold({
    freeBytes: opts.disk ? (opts.disk.freeBytes ?? systemFreeBytes(worktreeRoot)) : () => null,
    floorBytes: () => capacitySettings(state.db).diskFloorGb * 1_000_000_000,
    db: state.db,
    inbox,
    logger: logger.child({ component: 'disk' }),
  });
  const laneCaps = opts.caps ?? {
    get global() {
      return capacitySettings(state.db).machineLaneCap;
    },
  };
  // The one gate in front of new lanes: the load, free disk and the drain.
  const admission = createAdmission({
    load: loadGuard,
    disk: diskHold,
    drain: updateDrain,
    laneCap: () => laneCaps.global,
    db: state.db,
  });
  const git = createGit({
    onRefused: createGitRefusalHandler({ db: state.db, inbox, logger }),
    onTrusted: createCheckoutTrustedHandler({ db: state.db, inbox }),
    onBookkeepingDropped: (root, dropped) => {
      for (const { rel, writtenBy } of dropped)
        logger.info(
          { root, path: rel, writtenBy },
          'left a Claude Code bookkeeping file out of a commit',
        );
    },
    refusedCheckouts: refusedTrustCheckouts(state.db),
    pins: createProjectPinStore(state, memoryPinStore()),
    bin: gitBin,
    checkouts: () => listProjects(state.db).map((project) => project.repoPath),
    // Where sandboxed lanes and gates make their temp dirs, and the system temp dir every ChatGPT
    // lane writes. With no sandbox no lane runs, so nothing lane-written lies in them.
    laneRoots: [...laneWrittenRoots, worktreeRoot],
    worktreeRoot,
  });
  // srt, which runs every gate and every repo stdio MCP server.
  const runtime = opts.sandbox ? (opts.sandbox.runtime ?? resolveSandboxRuntime()) : null;
  if (sandboxRoots?.refusal) {
    logger.error(
      { err: sandboxRoots.refusal.message },
      'a sandbox root was refused, so no lane session or gate can start',
    );
  }
  // Before any session or gate starts: what a crashed run left in the roots is stale. A refused root
  // is neither swept nor claimed.
  const claimedRoots =
    sandboxRoots?.refusal === null
      ? claimSandboxRoots(
          {
            temps: [sandboxRoots.temp, sandboxRoots.codexLanes],
            files: sandboxRoots.files,
          },
          process.pid,
          // The servers of a chat still in the builder's terminal run on, so their temp dirs stay.
          liveTakeoverTempDirs(db, opts.dataDir),
        )
      : null;
  // Off the event loop and never waited on by a start: `tmutil` can be slow, and a root it could
  // not exclude costs backup space, not a lane. `stop()` ends what still runs.
  const backupsAbort = new AbortController();
  const rootsKeptOutOfBackups =
    sandboxRoots === null
      ? Promise.resolve()
      : keepRootsOutOfBackups(
          sandboxRoots,
          opts.sandbox?.backups ?? tmutilExclusion,
          logger.child({ component: 'sandbox' }),
          backupsAbort.signal,
        );
  if (
    claimedRoots &&
    (claimedRoots.removed > 0 || claimedRoots.failed > 0 || claimedRoots.sharedWith !== null)
  ) {
    logger.info(
      {
        removed: claimedRoots.removed,
        failed: claimedRoots.failed,
        sharedWith: claimedRoots.sharedWith,
      },
      'swept the sandbox roots',
    );
  }
  // Before recovery and before any session: processes the lane sessions of a daemon that died left
  // running (a lane's background loops reparent to launchd when their session goes) are stopped
  // from the ledgers those sessions kept in the files root. Each ledger names its daemon: one
  // sharing the root that still runs keeps its own, and every dead one's is reaped even then. What a
  // machine whose processes can't be read leaves is swept again while the daemon runs, and so is
  // what a session of this daemon could not stop as it ended; the next start takes whatever is
  // still left.
  const laneProcesses = opts.sandbox?.processes ?? { table: systemProcessTable };
  let ledgerSweep: LedgerSweep | null = null;
  if (sandboxRoots !== null && sandboxRoots.refusal === null) {
    const ledgerRoot = sandboxRoots.files;
    let sweepFailing = false;
    ledgerSweep = createLedgerSweep(ledgerRoot, laneProcesses, {
      onSwept: (report) => {
        sweepFailing = false;
        if (report.ledgers === 0) return;
        logger.info(
          { ledgers: report.ledgers, stopped: report.stopped },
          'stopped the processes ended lane sessions left running',
        );
      },
      onFailed: (error) => {
        // Once until a sweep reads the machine again: one runs every half minute meanwhile.
        if (sweepFailing) return;
        sweepFailing = true;
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'could not stop the processes ended lane sessions left running; trying again',
        );
      },
    });
    try {
      const reaped = await reapLaneProcessLedgers(ledgerRoot, laneProcesses);
      if (reaped.ledgers > 0) {
        logger.info(
          { ledgers: reaped.ledgers, stopped: reaped.stopped },
          'stopped the processes a previous daemon’s lane sessions left running',
        );
      }
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not stop the processes a previous daemon’s lane sessions left running; trying again while the daemon runs',
      );
      ledgerSweep.later();
    }
  }
  // Every browser, pictures' and each lane's, is launched and found under one lock, and they share one
  // fetch of the pinned build: the fetch is lazy, and neither fetches while the other does.
  const browserLaunches = createBrowserLaunches();
  const pinnedBuild = (() => {
    let current: Promise<string> | null = null;
    let fetching = false;
    return {
      ready(): Promise<string> {
        if (current !== null) return current;
        fetching = true;
        const made = ensurePinned(opts.dataDir, BROWSER_PIN, {
          download: downloadFile,
          extract: extractZipWithTar,
        }).then(
          (exe) => {
            fetching = false;
            return exe;
          },
          (error: unknown) => {
            // A refused fetch is tried again by the next ask.
            fetching = false;
            current = null;
            throw error;
          },
        );
        current = made;
        return made;
      },
      fetching: () => fetching,
    };
  })();
  const laneBrowsers: LaneBrowsers | null =
    opts.laneBrowser === undefined
      ? null
      : createLaneBrowsers({
          dataDir: opts.dataDir,
          ledgers:
            ledgerSweep && sandboxRoots ? { sweep: ledgerSweep, root: sandboxRoots.files } : null,
          processes: laneProcesses,
          launches: browserLaunches,
          build: pinnedBuild,
          launch:
            opts.laneBrowser.kind === 'given' ? opts.laneBrowser.launch : launchPlaywrightDriver,
          readers:
            opts.laneBrowser.kind === 'given'
              ? opts.laneBrowser.readers
              : systemPortReaders(homedir(), process.env, laneProcesses.table, clock),
          daemonPort: () => listenPort,
          clock,
          logger: logger.child({ component: 'lane-browser' }),
        });
  // After the reap, before any lane session or gate can start: a sealed file of 10db's in a system
  // temp dir is readable to every ChatGPT lane, and a ledger there could be one a lane wrote.
  if (sandboxRoots !== null) {
    logSweep(sweepSystemTempFiles(sandboxRoots.systemTemps), "10db's files");
  }
  // Every lane session and every gate runs in one of these; over a refused root both refuse.
  const sandboxes =
    opts.sandbox && sandboxRoots && runtime
      ? sandboxesFor(sandboxRoots, {
          lane: () =>
            createLaneSandbox({
              // The home the setup is found in is the one its paths are judged and named by.
              home: builderHome,
              dataDir: opts.dataDir,
              loginConfigDir: launcher.loginConfigDir(),
              loginCodexHome: launcher.loginCodexHome(),
              gitDirs: (repo) => git.gitDirs(repo),
              ...sandboxDepsOf(sandboxRoots),
              ...(opts.sandbox?.processes === undefined
                ? {}
                : { processes: opts.sandbox.processes }),
              ...(ledgerSweep === null ? {} : { ledgers: ledgerSweep }),
              log: logger.child({ component: 'sandbox' }),
              runtime,
              worktreeRoot,
            }),
          gate: () =>
            createGateSandbox({
              home: homedir(),
              dataDir: opts.dataDir,
              loginConfigDir: launcher.loginConfigDir(),
              loginCodexHome: launcher.loginCodexHome(),
              gitDirs: (repo) => git.gitDirs(repo),
              ...sandboxDepsOf(sandboxRoots),
              log: logger.child({ component: 'sandbox' }),
              runtime,
            }),
        })
      : null;
  // Shared by every gate: a task's, at its green run, and a batch's, at ship. One limiter caps them
  // all, so the machine never runs more than `limits.gateSlots` at once.
  // Every project's gate gets its Docker switch as it stands, and 10db turns it on when the gate
  // needs Docker (`auto-docker.ts`); an install or a generator names no project and is left alone.
  const evalsService = createEvalsService({
    state,
    git,
    logger: logger.child({ module: 'evals' }),
  });
  const gateRunner = autoDocker(
    createGateRunner({
      sandbox: sandboxes?.gate ?? null,
      logger: logger.child({ component: 'gate' }),
    }),
    {
      state,
      inbox,
      logger: logger.child({ component: 'gate' }),
      baseCommit: (repoPath, baseBranch) => originBaseCommit(git, repoPath, baseBranch),
      readBase: async (repoPath, commit, path) => {
        const read = await git.fileAt(repoPath, commit, path, MAX_DOCKER_SCAN_BYTES);
        return read.kind === 'file' ? read.text : null;
      },
    },
  );
  const gateSlots = createGateSlots(limits.gateSlots);
  // A suite's live arm, run only when the builder presses Run: the unslotted runner (a paid eval never
  // holds or waits for a gate slot), its processes in a ledger. What a crash left is stopped here, after
  // the ledger reap above and before any route serves.
  const evalLiveRuns = createEvalLiveRuns({
    gates: gateRunner,
    ledgers:
      ledgerSweep && sandboxRoots
        ? { sweep: ledgerSweep, root: sandboxRoots.files, processes: laneProcesses }
        : null,
    sandboxed: sandboxes?.gate != null,
    dataDir: opts.dataDir,
    state,
    evals: evalsService,
    checkouts: () => allCheckouts(state.db),
    env: () => launcher.projectEnv(),
    logger: logger.child({ component: 'eval-live' }),
  });
  await evalLiveRuns.recoverAtStart();
  const evalCandidates = createEvalCandidateList({
    db: state.db,
    evals: evalsService,
    catalogue,
    clock,
  });
  // A sweep a crash left `running` ends after its run did: nothing resumes.
  const evalSweeps = createEvalSweeps({
    state,
    live: evalLiveRuns,
    evals: evalsService,
    candidates: evalCandidates,
    logger: logger.child({ component: 'eval-sweeps' }),
  });
  evalSweeps.recoverAtStart();
  // A final gate that fails because the project's dev stack isn't up to date waits, with one card,
  // instead of failing the task. It wraps the limiter, so a waiting gate holds no slot.
  const gateHoldDeps = {
    clock,
    state,
    inbox,
    logger: logger.child({ component: 'gate' }),
    retryMs: GATE_HOLD_RETRY_MS,
    held: new Map<ProjectId, number>(),
  };
  // A task's gate has no hold here: the runner holds it, for the load and the drain, before it takes
  // its batch's turn and its slot, so a held gate keeps neither.
  const gate = holdStaleGates(
    limitGates(gateRunner, {
      slots: gateSlots,
      clock,
      logger: logger.child({ component: 'gate' }),
    }),
    gateHoldDeps,
  );
  // A batch's shipping gate belongs to a ship that has begun, and a drain lets that finish: only
  // the load holds it. No new ship begins during the drain (`holdShips`).
  const shipGate = holdStaleGates(
    limitGates(gateRunner, {
      slots: gateSlots,
      clock,
      logger: logger.child({ component: 'gate' }),
      hold: loadGuard,
    }),
    gateHoldDeps,
  );
  // The check after a Workbench turn is advice: same load hold and slots, but it waits behind any
  // gate that decides whether work lands.
  const turnCheckGate = limitGates(gateRunner, {
    slots: gateSlots,
    clock,
    logger: logger.child({ component: 'gate' }),
    hold: loadGuard,
    priority: GatePriority.Advice,
  });
  const answerGit = createGitCardAnswers(git);
  answerGitCard = (item, answer) => {
    // A re-trust reads the checkout first; a refusal it meets raises its own card.
    answerGit(item, answer).catch((error: unknown) => {
      logger.error({ err: error }, 'could not re-trust a checkout');
    });
  };
  const deliveryJobs = createDeliveryJobs(logger.child({ component: 'delivery' }));
  // What the install and the generators of a worktree run with: the gate's sandbox and login env.
  const worktreeTools = {
    gate: gateRunner,
    clock,
    dataDir: opts.dataDir,
    logger: logger.child({ component: 'worktree-install' }),
    sessionEnv: () => launcher.projectEnv(),
    rules: (project: ProjectDto) => listPermissionRules(state.db, project.id, null),
    checkouts: () => allCheckouts(state.db),
    timeoutMs: limits.gateTimeoutMs,
    copyIdOf: (batchId: BatchId) => copyIdForBatch(state.db, batchId),
    resolvePnpm,
    pnpmVersion: readPnpmVersion,
    templates: createNodeModulesTemplates({
      root: templatesRoot(opts.dataDir),
      logger: logger.child({ component: 'node-modules-template' }),
    }),
  };
  const delivery: DeliveryContext = {
    state,
    folderHold,
    git,
    gh: opts.gh ?? createGh(createSystemGhExec(ghTools)),
    inbox,
    jobs: deliveryJobs,
    logger: logger.child({ component: 'delivery' }),
    clock,
    limits: {
      ...DEFAULT_DELIVERY_LIMITS,
      gateTimeoutMs: limits.gateTimeoutMs,
      ...opts.deliveryLimits,
    },
    networkEnv: opts.networkEnv ?? (() => ({ PATH: DEFAULT_SESSION_PATH })),
    onWorkQueued: () => {
      scheduler?.requestTick();
    },
    // An ordinary start of a taken-out task puts its saved work back in the checkout it runs in.
    putBack: (input) =>
      putBackKeptWork({ state, git, inbox, jobs: deliveryJobs, logger, clock }, input),
    worktreeRoot,
    // Not behind the gate slots: waiting out a long gate would hold the cut. A cut whose lockfile has
    // a template clones it; the first cut of a lockfile downloads the whole tree (the run's store is
    // empty), so several such cuts at once are several downloads.
    dependencies: createWorktreeDependencies(worktreeTools),
    generators: createWorktreeGenerators(worktreeTools),
    copyTeardown: createCopyTeardown({
      gate: gateRunner,
      clock,
      dataDir: opts.dataDir,
      logger: logger.child({ component: 'copy-teardown' }),
      timeoutMs: limits.gateTimeoutMs,
      sessionEnv: () => launcher.projectEnv(),
      rules: (project) => listPermissionRules(state.db, project.id, null),
      checkouts: () => allCheckouts(state.db),
    }),
  };
  answerBranchCard = createBranchCardAnswers(delivery);
  answerCiStopCard = createCiStopAnswers(delivery);
  // A pass's work in Your folder, and its cards (set below, once its take-outs are built).
  const passWork: PassWorkDeps = { state, git, inbox, jobs: delivery.jobs, logger, clock };
  const starter = createBatchStarter(delivery);
  // Rules and the judge size each new or edited task; a start from the Board, the API or the builder's
  // MCP waits for the sizing still in flight (`settleSizing`).
  const sizing = createSizingService({
    state,
    bus,
    judge,
    clock,
    log: logger.child({ component: 'sizing' }),
    joiningProblem: (taskId) => starter.joiningProblem(taskId),
  });
  answerStartCard = createStartCardAnswers({ state, starter });
  answerLostMigrationsCard = createLostMigrationsAnswers(delivery);
  // One for the runner and the shipper alike, so a batch's verify and shipping gates run in turn.
  const baseUpdates = createBaseUpdates(delivery);
  // Before a task gets the migrations hazard, from request_claim or at its start.
  const migrationsBase = createMigrationsBase(delivery, baseUpdates);
  // A lane's dependency change, installed in the batch's turn by the daemon (install_dependencies).
  const dependencyChanges = createDependencyChanges(delivery, baseUpdates);
  const shipper = createShipper({
    ...delivery,
    gate: shipGate,
    holdShips: () => updateDrain.draining,
    baseUpdates,
    clock,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    identifyProcess: (pid) => processes.identify(pid),
    isRunning: (id) => runner?.isRunning(id) ?? false,
    load: loadGuard,
  });
  // Where a project's pictures go in Slack: a pass's pull request and a finished task each post once.
  const picturePost: SlackPicturePost | null =
    slackClients === null
      ? null
      : createSlackPicturePost({
          state,
          inbox,
          logger: logger.child({ component: 'slack-pictures' }),
          skipped: (taskId) => {
            const outlook = pictures?.outlook(taskId);
            return outlook?.kind === 'skipped' ? outlook.reason : null;
          },
          channelOf: (projectId) => {
            const sharing = readSlackSharing(state.db, projectId);
            // The channel belongs to the workspace it was picked in; another binding now leaves it unused.
            if (
              !sharing.enabled ||
              sharing.teamId === null ||
              sharing.channelId === null ||
              projectSlack(state.db, projectId).teamId !== sharing.teamId
            )
              return null;
            return {
              teamId: sharing.teamId,
              channelId: sharing.channelId,
              enabledAt: sharing.enabledAt ?? null,
            };
          },
          clientFor: (teamId) => slackClients.clientFor(teamId),
        });
  // A pass's pull request: its push and draft in the delivery key, its gate and one review outside it.
  const passPullRequests = createPassPullRequests({
    ...delivery,
    gate: shipGate,
    holdShips: () => updateDrain.draining,
    clock,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    identifyProcess: (pid) => processes.identify(pid),
    slack: picturePost,
    review: {
      adapter,
      launch: (accountId, model) => {
        const session = launcher.session(
          getAccountRow(state.db, accountId),
          model,
          listAccountModels(state.db, accountId),
        );
        return { model: session.model, env: session.env, expect: session.expect };
      },
      scratchRoot: tmpdir(),
    },
  });
  answerWorktreeCard = createWorktreeCardAnswers(delivery, {
    starter,
    abandon: (id) => shipper.abandon(id),
  });
  answerStallCard = createStallCardAnswers({
    state,
    cancel: (id) => {
      if (!runner) throw new RunnerNotStartedError();
      return runner.cancel(id);
    },
    retry: (id) => {
      starter.retry(id);
      scheduler?.requestTick();
    },
    abandon: (id) => {
      shipper.abandon(id);
    },
    log: logger,
  });
  answerBatchCard = createBatchCardAnswers({
    retry: (id, note) => {
      starter.retry(id, note);
      scheduler?.requestTick();
    },
    shipper,
  });
  const watcher =
    opts.watch === false
      ? null
      : createWatcher({
          state,
          bus,
          inbox,
          git,
          logger,
          clock,
          watch: opts.watch ?? systemWatch,
        });
  const keepAwake = createKeepAwake({
    state,
    spawn: opts.caffeinate ?? systemCaffeinate,
    daemonPid: process.pid,
    logger,
  });
  const accountPauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: (id) => runner?.stopAccount(id, 'paused') ?? Promise.resolve(),
    onResume: () => {
      scheduler?.requestTick();
    },
  });
  const accounts = createAccountRuntime({
    state,
    clock,
    inbox,
    pauses: accountPauses,
    defaultPauseMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
  });
  const reports = createUsageReports({
    clock,
    staleMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
  });
  // Built after the moves, which tell it when a project moved.
  let accountLimits: AccountLimits | null = null;
  // Built later. A move wakes it, so the project's updates held for a Linear sign-in go out on the new account,
  // and so does a Retry on its Inbox card, so the failed updates go out now.
  let lateLinearReporter: Pick<LinearReporter, 'wake'> | null = null;
  const moveBack = createMoveBack({
    state,
    clock,
    inbox,
    pauses: accountPauses,
    reports,
    defaultPauseMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
    back: (projectId, to) => {
      moves.move(projectId, to, { cause: MoveCause.MoveBack });
    },
  });
  const moves = createAccountMoves({
    state,
    inbox,
    pauses: accountPauses,
    moveBack,
    handOff: (projectId, accountId, reason) => {
      runner?.handOff(projectId, accountId, reason);
    },
    onMoved: (projectId) => {
      accountLimits?.forget(projectId);
      scheduler?.requestTick();
      lateLinearReporter?.wake(projectId);
    },
  });
  accountLimits = createAccountLimits({
    state,
    clock,
    inbox,
    pauses: accountPauses,
    moves,
    reports,
  });
  answerAccountCard = createAccountCardAnswers({
    resume: (id, about) => {
      accountPauses.resume(id, about);
    },
    confirm: (id, identity, answering) => {
      state.write((ctx) => patchAccount(ctx, id, { expectedIdentity: identity }));
      accounts.saved(id, answering);
      scheduler?.requestTick();
    },
    move: (projectId, to, why, answering) => {
      moves.move(projectId, to, why, { answering });
    },
    stay: (projectId) => {
      moves.stay(projectId);
    },
    recheck: (id, projectId, answering, forgetIdentity) => {
      preparer.retry(getAccountRow(state.db, id), projectId, answering, { forgetIdentity });
    },
    raiseCap: (id, toUsd, answering) => {
      // A cap raised since the card was written is never lowered by it.
      const raised = Math.max(toUsd, getAccountRow(state.db, id).monthlyCapUsd ?? 0);
      state.write((ctx) => patchAccount(ctx, id, { monthlyCapUsd: raised }));
      accounts.saved(id, answering);
      scheduler?.requestTick();
    },
  });
  const startGate = createStartGate();
  const preparer = createAccountPreparer({
    state,
    clock,
    inbox,
    adapter,
    lists: accountLists,
    launcher,
    startGate,
    dataDir: opts.dataDir,
    logger: logger.child({ component: 'accounts' }),
    onReady: () => {
      scheduler?.requestTick();
    },
  });
  const listRefresh = createListRefresh({
    state,
    clock,
    adapter,
    launcher,
    startGate,
    lists: accountLists,
    dataDir: opts.dataDir,
    fetch: outbound,
    logger: logger.child({ component: 'catalogue' }),
  });
  // What runs after every fetch of the catalogue: each account's list is read again through the identity probe, then
  // the profiles are rebuilt from what the accounts now offer. Scores for the models that changed are read after the
  // profiles exist, so a new model has a row to put them on.
  async function refreshAccountModels(fetched: boolean): Promise<void> {
    // After a failed fetch only accounts not read in the last day are read, so a retry loop does not probe them all;
    // the builder's own refresh reads every account.
    const everyAccount = fetched || forced;
    const builderAsked = forced;
    forced = false;
    await listRefresh.readAll({ staleOnly: !everyAccount });
    const current = catalogue.catalogue();
    if (current !== null) rebuildProfiles(current);
    // Scores come last, so every new model has a row to put them on; with no key or benchmarks off nothing is fetched.
    await benchmarks.syncForCatalogue({ force: builderAsked });
  }
  // One path for the daily timer, the start-up catch-up and the Models page: a call during a run joins it.
  // Off, nothing is fetched and no account is probed.
  const modelRefreshOn = opts.catalogueSync === true;
  /** A forced refresh is waiting for the run in flight to read the accounts. */
  let forced = false;
  const refreshModels = async ({ force }: { readonly force: boolean }): Promise<void> => {
    if (!modelRefreshOn) return;
    forced ||= force;
    await catalogue.sync();
    // A run already past its read never saw the request: read once more.
    if (forced) await refreshAccountModels(true);
  };
  // Profiles come from the catalogue the daemon holds (the stored copy, else the release's snapshot), not from a
  // fetch: a daemon that never fetches still plans and launches on real models. The rebuild is idempotent, so a
  // fetch that lands later only changes what differs.
  const held = catalogue.catalogue();
  if (held !== null) rebuildProfiles(held);
  if (modelRefreshOn) catalogue.start();
  const accountService = createAccountService({
    state,
    clock,
    dataDir: opts.dataDir,
    keychain: opts.keychain ?? unavailableKeychain,
    launcher,
    adapter,
    lists: accountLists,
    // Off, a finished sign-in reads no list either.
    listRefresh: modelRefreshOn ? listRefresh : { readOne: () => Promise.resolve() },
    startGate,
    runtime: accounts,
    pauses: accountPauses,
    logger: logger.child({ component: 'accounts' }),
    liveLanes: (id) => lanesByAccount(db).get(id) ?? 0,
    onSaved: () => {
      scheduler?.requestTick();
    },
    onCreated: () => {
      const held = catalogue.catalogue();
      if (held !== null) rebuildProfiles(held);
    },
  });
  // The data directory, and the default account's sign-in wherever the login shell keeps it.
  const guarded = protectedPaths({
    dataDir: opts.dataDir,
    home: homedir(),
    loginConfigDir: launcher.loginConfigDir(),
  });
  // Shape conversations (spec §5): a read-only session per conversation on the project's account and
  // the `plan` role's model. The MCP address is known once the server listens, so it is read lazily.
  // `see_screen` (§5.5): the window draws a screen on the daemon's request, held to reads by a token
  // that belongs to that one request.
  const screenBroker = createScreenBroker();
  // Where each plan's folder lives: `<data>/shapes/<plan>`.
  const shapesDir = join(opts.dataDir, 'shapes');
  const screens = createScreens({
    state,
    broker: screenBroker,
    filesDir: shapesDir,
  });
  const laneSandbox = sandboxes?.lane ?? null;
  // One engine runs every explore conversation's session (sessions spec §6.1); Plan registers on it.
  const exploreEngine = createExploreEngine({
    state,
    adapter,
    clock,
    log: logger.child({ component: 'explore' }),
    dataDir: opts.dataDir,
    frames: liveFrames,
    // A waiting update starts no new turn: a conversation's session is no lane, and the install
    // would cut off one that began during the drain, or while the install starts.
    hold: holdBoth([updateDrain, installHold]),
    bus,
    mintToken: mintSessionToken,
    // A start the account runtime holds (a pause, a monthly cap) waits it out, as a lane's does.
    accountBlocked: (accountId, projectId) =>
      accounts.blocked(getAccountRow(db, accountId), projectId),
    defaultPauseMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
    withdrawCard: (id) => {
      inbox.withdraw(id);
    },
  });
  const conversationModels = (projectId: ProjectId) => {
    const project = getProject(db, projectId);
    const inputs = routingInputs(db, project);
    return {
      default: planConversationModel(db, project, null)?.model ?? null,
      offered: offeredModels(inputs.profiles),
    };
  };
  const conversationLaunch = (
    projectId: ProjectId,
    chosen: string | null,
    effort: Effort | null,
  ): ShapeLaunch => {
    const project = getProject(db, projectId);
    const row = getAccountRow(db, project.accountId);
    const run = conversationRun(db, project, chosen, effort);
    if (run === undefined) throw new InvalidError(`${row.label} offers no model for planning`);
    // The builder's pick runs at the conversation's effort snapped to that model's own efforts; one the
    // account has stopped offering gives way to the Plan cell's model.
    const modelId = run.model;
    const session = launcher.session(row, modelId, listAccountModels(db, row.id));
    return {
      cwd: project.repoPath,
      model: session.model,
      modelId,
      effort: run.effort,
      agentModels: shapeAgentModels(row.kind, requireHarness(row)),
      env: session.env,
      account: session.expect,
      fullAccess: () => {
        const taken = launcher.takeover(row, modelId, listAccountModels(db, row.id));
        return {
          apiKeyHelper:
            taken.apiKeyHelperAccount === null
              ? null
              : apiKeyHelperCommand(taken.apiKeyHelperAccount),
          // An API key with no helper stays in the env, where Claude Code would run in auto mode over it.
          keyInEnv:
            taken.scrub ||
            (row.kind === AccountKind.AnthropicApiKey && taken.apiKeyHelperAccount === null),
          defaultConfigDir: row.configDir === null,
        };
      },
      access: {
        checkout: project.repoPath,
        home: homedir(),
        protectedReads: guarded.map((p) => p.path),
        sandboxRoots: allSandboxRootsOf(sandboxRoots ?? namedSandboxRoots({}, homedir())),
      },
    };
  };
  // Plan's and a chat's sessions run commands only in a read-only lane sandbox; with none they run none.
  const conversationPrepare =
    laneSandbox === null
      ? undefined
      : createShapePreparer({
          state,
          inbox,
          git,
          logger: logger.child({ component: 'shape' }),
          laneSandbox,
          protectedPaths: guarded,
          projectEnv: () => launcher.projectEnv(),
          exportAwsCredentials,
          builderHome,
          laneWritableRoots: [worktreeRoot, ...allSandboxRoots],
          worktreeBase: worktreeRoot,
          codexLaneTempRoot: (sandboxRoots ?? namedSandboxRoots({}, homedir())).codexLanes,
        });
  // A Full access chat's session: no sandbox of its own, so it needs none to start.
  const conversationPrepareFullAccess = createFullAccessPreparer({
    state,
    inbox,
    git,
    logger: logger.child({ component: 'shape' }),
    laneSandbox,
    protectedPaths: guarded,
    projectEnv: () => launcher.projectEnv(),
    exportAwsCredentials,
    builderHome,
    laneWritableRoots: [worktreeRoot, ...allSandboxRoots],
    worktreeBase: worktreeRoot,
    codexLaneTempRoot: (sandboxRoots ?? namedSandboxRoots({}, homedir())).codexLanes,
  });
  // The chat's open sessions: the shape service takes a session's owed planning rules from them.
  const chatLive = createChatLiveSessions();
  const shape = createShapeService({
    state,
    adapter,
    owedRules: (conversationId, sessionId) =>
      chatLive.get(conversationId, sessionId)?.planRules?.take() ?? null,
    reviewOf: (conversationId, sessionId) =>
      chatLive.get(conversationId, sessionId)?.review() ?? [],
    noSubagents: (conversationId, sessionId) =>
      chatLive.get(conversationId, sessionId)?.inSession() ?? true,
    reviewBusy: (conversationId) => {
      const live = chatLive.current(conversationId);
      return live?.inSession() === true ? live.review().length > 0 : null;
    },
    engine: exploreEngine,
    clock,
    log: logger.child({ component: 'shape' }),
    filesDir: shapesDir,
    joiningProblem: (taskId) => starter.joiningProblem(taskId),
    screens,
    pictures: picturesNow,
    figmaFetch: opts.figmaFetch ?? outbound,
    jev: createShapeJev({
      state,
      judge,
      log: logger.child({ component: 'shape-jev' }),
      now: () => clock.now(),
    }),
    models: conversationModels,
    launch: conversationLaunch,
  });
  const chat = createChatService({
    state,
    engine: exploreEngine,
    folderHold,
    worktrees: createChatWorktrees({ state, git }),
    reopenBranch: (chatId) => chatWork.reopen(chatId),
    work: () => chatWork,
    fullAccessNotes: (projectId) => {
      const row = getAccountRow(db, getProject(db, projectId).accountId);
      if (requireHarness(row) === Provider.Codex)
        return [
          '10db brings your instructions and MCP servers across.',
          'Your ~/.codex settings don’t load yet.',
        ];
      return row.configDir === null
        ? ['Your own settings, hooks, skills and MCP servers load.']
        : [
            '10db brings your plugins, instructions and MCP servers across.',
            'Your ~/.claude settings and hooks don’t load on this account.',
          ];
    },
    pendingOpens,
    clock,
    dataDir: opts.dataDir,
    shapesDir,
    log: logger.child({ component: 'chat-service' }),
    now: () => clock.now(),
    modelsOf: conversationModels,
    webSearchOf: (projectId) =>
      adapter.capabilities(
        accountAgentOf(getAccountRow(db, getProject(db, projectId).accountId)),
        null,
      ).webSearch,
    takeover: () => takeoverService,
    planHeard: (conversationId, itemId) => {
      shape.heard(conversationId, itemId);
    },
  });
  // What the chat's session ran with, for the builder's terminal: a launch that names no secret.
  const takeoverSource = (
    conv: {
      readonly id: ConversationId;
      readonly model: string | null;
      readonly effort: Effort | null;
    },
    project: ProjectDto,
  ): TakeoverSource => {
    const row = getAccountRow(db, project.accountId);
    const run = conversationRun(db, project, conv.model, conv.effort);
    if (run === undefined) throw new ConflictError(`${row.label} offers no model for a chat`);
    const agent = accountAgentOf(row);
    try {
      const launch = launcher.takeover(row, run.model, listAccountModels(db, row.id));
      const chatRow = chatOfConversation(db, conv.id);
      return {
        // Where the session works: its worktree on a branch, the checkout otherwise.
        cwd: chatRow === null ? project.repoPath : chatRoot(chatRow, project).root,
        ...agent,
        model: launch.model,
        effort: run.effort,
        launch,
        web: adapter.capabilities(agent, run.model).webSearch,
      };
    } catch (error) {
      if (error instanceof AccountLaunchError || error instanceof ModelNotLaunchableError)
        throw new ConflictError(error.message);
      throw error;
    }
  };
  const takeoverServers =
    laneSandbox === null
      ? null
      : createTakeoverPreparer({
          state,
          inbox,
          git,
          logger: logger.child({ component: 'takeover' }),
          laneSandbox,
          protectedPaths: guarded,
          projectEnv: () => launcher.projectEnv(),
          exportAwsCredentials,
          builderHome,
          laneWritableRoots: [worktreeRoot, ...allSandboxRoots],
          worktreeBase: worktreeRoot,
          codexLaneTempRoot: (sandboxRoots ?? namedSandboxRoots({}, homedir())).codexLanes,
        });
  const NO_SANDBOX_NOTE =
    "The sandbox is unavailable, so this terminal has none of the chat's MCP servers or setup.";
  const NO_SANDBOX_SERVERS: TakeoverServers = {
    instructions: null,
    pluginDirs: [],
    projectMcpServers: {},
    yourMcpServers: {},
    notes: [NO_SANDBOX_NOTE],
    tempDirs: [],
    remove: () => Promise.resolve(),
  };
  const takeoverCodexHomes = codexHomes();
  let takeoverService: TakeoverService | null = null;
  const takeover = createTakeoverService({
    state,
    engine: exploreEngine,
    folderHold,
    chats: () => chat,
    work: () => chatWork,
    dataDir: opts.dataDir,
    now: () => clock.now(),
    log: logger.child({ component: 'takeover' }),
    app: () => sessionsSettings(db).terminalApp,
    opener: createOpener(),
    sourceOf: takeoverSource,
    prepare: (input, signal) =>
      prepareTakeover(
        {
          adapter,
          servers: (project, folder, source) => {
            // Without a sandbox nothing of the chat's servers or setup can be launched safely, so the terminal
            // opens without them and the popover says so.
            if (takeoverServers === null) return Promise.resolve(NO_SANDBOX_SERVERS);
            const row = getAccountRow(db, project.accountId);
            // The model is the launch id the source already holds, which the launcher takes as it is.
            const env = launcher.session(row, source.model, listAccountModels(db, row.id)).env;
            return takeoverServers({
              project,
              folder,
              env,
              configDir: sessionConfigDir(requireHarness(row), env, homedir()),
            });
          },
          onboard: async (source) => {
            const claudeDir = source.launch.set['CLAUDE_CONFIG_DIR'];
            if (claudeDir !== undefined) await markOnboarded(claudeDir, source.cwd);
            const codexDir = source.launch.set['CODEX_HOME'];
            if (codexDir !== undefined)
              await takeoverCodexHomes(codexDir, codexHomeProviderOf(source.kind)).prepare(
                source.cwd,
              );
          },
          newSetId: () => randomBytes(5).toString('hex'),
        },
        input,
        signal,
      ),
    notesOf: (source) => adapter.takeoverNotes(source),
    setupNotes: () => (takeoverServers === null ? [NO_SANDBOX_NOTE] : []),
    changedPaths: (checkout) => git.changedPaths(checkout),
  });
  takeoverService = takeover;
  const firstStartAfterMove = new Set<ChatId>();
  const chatMovesAbort = new AbortController();
  const chatWork = createChatWorkService({
    state,
    engine: exploreEngine,
    folderHold,
    firstStartAfterMove,
    move: createChatMove({ state, delivery, signal: chatMovesAbort.signal }),
    facts: createChatWorkStateReader({
      state,
      git,
      gh: delivery.gh,
      net: () => ({
        env: delivery.networkEnv(),
        timeoutMs: delivery.limits.networkTimeoutMs,
      }),
      folderHold,
      clock,
    }),
    carryOn: (chatId, text) => {
      chat.carryOn(chatId, text);
    },
    log: logger.child({ component: 'chat-work' }),
    now: () => clock.now(),
  });
  chatWorkRef = chatWork;
  exploreEngine.register(
    ConversationOwnerKind.Chat,
    chatHooks({
      precedents: precedents.events,
      live: chatLive,
      state,
      folderHold,
      checkoutState: (checkout) => checkoutState(git, checkout),
      firstStartAfterMove,
      log: logger.child({ component: 'chat' }),
      dataDir: opts.dataDir,
      now: () => clock.now(),
      mcp: {
        get url() {
          return mcpUrl;
        },
      },
      launch: conversationLaunch,
      ...(conversationPrepare === undefined ? {} : { prepare: conversationPrepare }),
      prepareFullAccess: conversationPrepareFullAccess,
      parkForFolder: (chatId) => {
        chat.parkForFolder(chatId);
      },
      backgroundRunning: (conversationId) => exploreEngine.backgroundTaskCount(conversationId) > 0,
      plan: shape.planParts,
      limitsFor: pictureLimitsFor,
      judgeOf: (account, model) => adapter.capabilities(account, model).judge,
      webSearchOf: (account, model) => adapter.capabilities(account, model).webSearch,
      subagentsOf: (account, model) => adapter.capabilities(account, model).subagents,
      clock,
      judge,
      composeServices: (project) => readComposeServices(git, project),
      readCommitted: (project, checkout) => readCommitted(git, project, checkout),
      firstChange: (chatId) => {
        chatWork.firstChange(chatId);
      },
    }),
  );
  const conversationFiles = createConversationFiles({
    state,
    now: () => clock.now().getTime(),
    trackedFiles: gitTrackedFiles,
  });
  // The marks from an error's wording that ended, or will end, while the daemon was down.
  resumeModelMarks({ state, clock });
  // What each task conversation's session streams now; the runner owns those sessions.
  const laneLive = createLiveRegistry();
  const createdRunner = createRunner({
    evals: evalsService,
    judge,
    precedents: precedents.events,
    gitTools: { git: gitBin, gh: ghBin },
    awaitBeforePicture: (task, signal) => pictures?.awaitBefore(task, signal) ?? Promise.resolve(),
    protectedPaths: guarded,
    laneSandbox,
    gateSandbox: sandboxes?.gate ?? null,
    codexLaneTempRoot: (sandboxRoots ?? namedSandboxRoots({}, homedir())).codexLanes,
    worktreeRoot,
    builderHome,
    laneWritableRoots: allSandboxRoots,
    hold: startHold,
    laneTempDirs,
    ...(laneBrowsers === null ? {} : { endLaneBrowser: (id) => laneBrowsers.end(id) }),
    state,
    adapter,
    inbox,
    git,
    jobs: deliveryJobs,
    gate,
    baseUpdates,
    migrationsBase,
    clock,
    logger,
    exportAwsCredentials,
    dataDir: opts.dataDir,
    live,
    frames: liveFrames,
    laneLive,
    limits,
    mcpUrl: () => mcpUrl,
    skillBody: (name) => readSkillBody(name, opts.harnessDir ?? HARNESS_PLUGIN_DIR),
    launcher,
    startGate,
    modelWait,
    accounts: {
      ...accounts,
      prepare: (account, projectId) => {
        preparer.prepare(account, projectId);
      },
      usageReported: (accountId, report) => {
        accountLimits.usageReported(accountId, report);
      },
    },
    onLaneFreed: () => {
      scheduler?.requestTick();
    },
    ...(watcher
      ? { afterSession: (id: WorkstreamId) => watcher.stepEnd(id).then(() => undefined) }
      : {}),
    identifyProcess: (pid) => processes.identify(pid),
    // The reporter is made after the runner; a lane starts only once both exist.
    linearSnapshot: (taskId) => linearReporter.snapshot(taskId),
    ...(opts.laneBrief === undefined ? {} : { laneBrief: opts.laneBrief }),
  });
  runner = createdRunner;
  const closedNoticeCards = resolveNoticeCards(state.db, inbox);
  if (closedNoticeCards > 0) {
    logger.info({ closed: closedNoticeCards }, 'closed open cards that are notices now');
  }
  const queueWaits = createQueueWaits({ state, clock });
  // One gate for the scheduler and the take-out of a failed run's work, which holds the run's Retry.
  const keptWork = createKeptWorkGate(delivery);
  const createdScheduler = createScheduler({
    state,
    folderHold,
    runner: createdRunner,
    accounts: {
      ...accounts,
      prepare: (account, projectId) => {
        preparer.prepare(account, projectId);
      },
      // Off, no session start reads a list.
      ...(modelRefreshOn
        ? {
            readList: (id: AccountId) => {
              void listRefresh.readIfStale(id);
            },
          }
        : {}),
    },
    connecting: () => accountService.connecting(),
    // A run in Your folder of a local project waits for its task's saved work to go back (call 33).
    keptWork,
    modelWait,
    clock,
    instanceId,
    logger,
    caps: laneCaps,
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    tickMs: opts.tickMs ?? DEFAULTS.tickMs,
    branches: git,
    onWrongBranch: (batch, current, checkout) => {
      flagWrongBranch(inbox, batch, current, checkout);
    },
    onBranchReady: (batch) => {
      resolveBranchReadyCards({ db, git, inbox }, batch).catch((error: unknown) => {
        logger.warn({ err: error, batchId: batch.id }, 'could not close a wrong-branch card');
      });
    },
    onWorktreeMissing: (batch, path) => {
      flagWorktreeMissing(inbox, batch, path);
    },
    awaitedHolders: () => claimWaits.awaitedHolders(),
    held: () => admission.held(),
    waits: queueWaits,
  });
  scheduler = createdScheduler;
  // The watchdog: one Stuck card per run or batch that stopped moving. It writes nothing else.
  const stallSweep = createStallSweep({
    state,
    inbox,
    waits: queueWaits,
    held: () => admission.held(),
    clock,
    logger: logger.child({ component: 'stalls' }),
  });

  // The changed-files check after a page's turn (Workbench spec §8.1): advice, through the shared
  // slots at advice priority. Started before recovery, which settles turns a stopped daemon
  // ended and so raises their Ready: a check that daemon left running is stopped first, so a new one
  // never runs beside it or takes its pid's place.
  const {
    checks: turnChecks,
    unsubscribe: unsubscribeTurnChecks,
    begin: beginTurnChecks,
  } = await startTurnChecks({
    state,
    git,
    gate: turnCheckGate,
    bus,
    processes,
    logger: logger.child({ component: 'gate' }),
    clock,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    identifyProcess: (pid) => processes.identify(pid),
    timeoutMs: Math.min(TURN_CHECK_TIMEOUT_MS, limits.gateTimeoutMs),
  });
  // What the close and Abandon stop of a pass's checks: its pull request's, then its turn check.
  const passShip = withTurnChecks(passPullRequests, turnChecks);

  const cleanShutdown = getAppSetting(db, CLEAN_SHUTDOWN_KEY) !== undefined;
  state.write((ctx) => {
    deleteAppSetting(ctx, CLEAN_SHUTDOWN_KEY);
  });
  // Read only now, with the instance lock held, so a daemon that loses the lock never takes it.
  const frozenKill = takeFrozenKill(opts.dataDir);
  if (frozenKill !== null) {
    logger.warn(
      { killedPid: frozenKill.pid, at: frozenKill.at, frozenAfterMs: frozenKill.frozenAfterMs },
      'the app killed the previous daemon as frozen or stuck starting; runs are not charged for the restart',
    );
  }
  await recoverOnStartup({
    state,
    inbox,
    git,
    jobs: deliveryJobs,
    clock,
    processes,
    maxRecoveryAttempts: limits.maxRecoveryAttempts,
    logger,
    cleanShutdown,
    frozenKill: frozenKill !== null,
  });
  // An ended unattended run lists what it skipped while nobody watched, once; the sweep raises the
  // item of a run that ended before a crash, or that recovery just failed.
  const skippedDeps = { state, git, log: logger.child({ component: 'skipped' }) };
  // The raises still reading a run's changed paths, which stop() waits for before the store closes.
  const skippedRaises = new Set<Promise<void>>();
  // A card for a task's skipped calls, or for a write nobody could own, has nothing left to do once the
  // task is finished or abandoned, or its run ends.
  const unsubscribeSettled = bus.subscribe((event) => {
    if (event.type === EventType.TaskChanged) {
      closeFinishedSkippedCards(state.db, inbox);
    } else if (event.type === EventType.BatchUpdated) {
      // A failed run's card has nothing left to decide once its pull request merged or its batch is gone.
      resolveOverBatchCards(state.db, inbox);
    } else if (
      event.type === EventType.WorkstreamChanged &&
      [WorkstreamState.Done, WorkstreamState.Failed, WorkstreamState.Cancelled].some(
        (ended) => ended === event.data['to'],
      )
    ) {
      watcher?.resolveSettledStrays().catch((error: unknown) => {
        logger.warn({ err: error }, 'could not close the stray-write cards of an ended run');
      });
    }
  });
  const unsubscribeSkipped = bus.subscribe((event) => {
    if (event.type !== EventType.WorkstreamChanged) return;
    const to = event.data['to'];
    if (to !== WorkstreamState.Done && to !== WorkstreamState.Failed) return;
    const id = WorkstreamId.safeParse(event.entityId);
    if (!id.success) return;
    const raised = raiseSkippedCard(skippedDeps, id.data)
      .catch((error: unknown) => {
        logger.warn(
          { err: error, workstreamId: id.data },
          'could not raise the skipped item of a run',
        );
      })
      .finally(() => {
        skippedRaises.delete(raised);
      });
    skippedRaises.add(raised);
  });
  await sweepUnlistedRuns(skippedDeps);
  // Each project's proposal card is recomputed from the rows, and again every hour while one is open.
  precedents.start();
  // Cards an earlier daemon left open that have nothing left to do close now, so a backlog clears
  // without the builder. The stray-write cards close once the watcher has been synced, below.
  const closedAtStart =
    closeFinishedSkippedCards(state.db, inbox) +
    closeGoneMergedWorktreeCards(state.db, inbox) +
    resolveOverBatchCards(state.db, inbox);
  if (closedAtStart > 0)
    logger.info({ closed: closedAtStart }, 'closed open cards with nothing left');
  // A card a crash left waiting for triage takes the lane's rule, a routed card without its message gets
  // one. A send that was mid-post is looked for by its workspace's reply watch.
  for (const after of state.write((ctx) => sweepDrafts(ctx, draftOpts))) after();
  // Slack tokens are kept by workspace: the old single item and contacts of no signed-in workspace go.
  if (slackClients !== null) cleanUpSlackSignIns({ state, keychain: judgeKeychain, log: logger });
  const slackConnections = createSlackConnections({ state, off: slackClients === null });
  const answerWriter = createAnswerWriter({
    adapter,
    launcher,
    db: state.db,
    clock,
    paused: (id) => accountPauses.pausedFor(id) !== null,
    scratchRoot: tmpdir(),
    codex: () => {
      const status = opts.agents?.statuses().find((s) => s.tool === AgentTool.Codex);
      if (status?.state !== AgentState.Ready || status.path === null) return null;
      return {
        codexPath: status.path,
        logger: logger.child({ component: 'codex-complete' }),
        homes: takeoverCodexHomes,
      };
    },
  });
  const replyWatches = createReplyWatches({
    state,
    slack: slackClients,
    inbox,
    judge,
    sends,
    clock,
    log: logger.child({ component: 'reply-watch' }),
    connections: slackConnections,
    answerWriter,
  });
  // The timers need no Slack: a card comes back to the builder even while Slack is down.
  const timerWatch = createTimerWatch({
    state,
    clock,
    log: logger.child({ component: 'stakeholder-timers' }),
  });
  bus.subscribe((event) => {
    if (event.type !== EventType.InboxChanged) return;
    const id = InboxItemId.safeParse(event.entityId);
    if (!id.success) return;
    sends.onCardChanged(getInboxItem(state.db, id.data)).catch((error: unknown) => {
      logger.warn({ err: error, cardId: id.data }, 'could not settle the send of a changed card');
    });
  });
  // A pass's take-outs and Abandon stop its lanes through the runner, and tell the watcher which
  // files their put-back wrote.
  const stopLane: StopPassLane = (id) => createdRunner.stopPassLane(id);
  const passTakeOuts: TakeOutDeps & SignOffDeps = {
    ...passWork,
    stopLane,
    wrote: (repo, paths) => watcher?.daemonWrote(repo, paths) ?? Promise.resolve(),
    // Once the pass has a pull request, each page committed is pushed to it.
    committed: (passId) => {
      passPullRequests.pushCommitted(passId).catch((error: unknown) => {
        logger.warn({ passId, err: error }, 'committed page not pushed');
      });
    },
  };
  // A Ready page's Sign Off, from its route or its check item; one waiting for another page's hold
  // goes on once that hold closes.
  startPageSignOff = (taskId) => {
    startSignOff(passTakeOuts, taskId);
  };
  const unsubscribeSignOffWaits = subscribeSignOffWaits(bus, passTakeOuts);
  // A pass page that asked for migrations or deps: Move to a Separate Copy takes it out and starts
  // it in a copy, as the Board's Start does.
  const passMoves: MoveToCopyDeps = {
    ...passTakeOuts,
    startInCopy: (taskId) => {
      starter.startTask(taskId);
      createdScheduler.requestTick();
    },
  };
  answerPassCards = (item, answer) => {
    answerPassCard({ ...passWork, folderHold }, item, answer);
    answerPassMoveCard(delivery, item, answer);
    void answerMoveToCopy(passMoves, item, answer);
  };
  // A task has saved work only once a take-out has kept it; a later pass puts it back.
  const passOpenDeps: PassOpenDeps = {
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    putBack: (input) => putBackKeptWork(passWork, input),
  };
  // Close Pass, its steps under the delivery key with its gate and pull request through 7b's seam;
  // a pass whose pull request merged while it was open closes by itself, its unfinished pages
  // carried over to a follow-on pass.
  const passCloses = createPassCloses({
    ...passTakeOuts,
    ship: passShip,
    gateWhere: (pass) => closeGateOf(passGateKind(getProject(state.db, pass.projectId))),
    openFollowOn: (input) => openPass(delivery, input, passOpenDeps),
  });
  const unsubscribeMergedPasses = subscribeMergedPasses(bus, state.db, passCloses);
  // Abandon Pass stops what ships for the pass first: its pull request's checks and its close.
  const passAbandons: AbandonDeps = {
    ...passTakeOuts,
    stopShip: async (passId) => {
      await passShip.stopPassChecks(passId);
      await passCloses.abort(passId);
    },
  };
  // Each open pass goes on from its rows: its folder card, a put-back, take-outs and sign-offs cut short.
  await resumePassWork(passTakeOuts);
  // The previous daemon's claim waits ended with it; their cards would name holders nobody waits for.
  withdrawStaleClaimWaits(state, inbox);
  // Nor does a chat's or Plan's session wait on a card from before: its call ended with the daemon.
  withdrawStaleConversationCards(state.db, inbox);
  accountPauses.restore();
  // A move back that came due reads the pauses.
  moveBack.restore();
  await recoverBatches({
    folderHold,
    state,
    git,
    inbox,
    jobs: delivery.jobs,
    processes,
    shipper,
    starter,
    logger: logger.child({ component: 'delivery' }),
    worktrees: { ctx: delivery, root: worktreeRoot },
  });
  // The batches' recovery has stopped the gates the last daemon left: the checks recovery's Ready
  // turns asked for may run now.
  beginTurnChecks();
  // Pictures of the builder's app (Workbench spec §10): after recovery, so a page recovery made Ready
  // is not shot half settled. The dev login runs through the unslotted gate runner, as an install does.
  // The pinned browser is launched only with a ledger to hold its processes: with the sandbox's roots
  // refused, its host refuses and fetches nothing.
  const browserHost =
    opts.pictures?.kind === 'pinned'
      ? createBrowserHost({
          dataDir: opts.dataDir,
          ledgers:
            ledgerSweep && sandboxRoots ? { sweep: ledgerSweep, root: sandboxRoots.files } : null,
          processes: laneProcesses,
          clock,
          logger: logger.child({ component: 'pictures' }),
          launch: launchChromium,
          launches: browserLaunches,
          ensure: () => pinnedBuild.ready(),
        })
      : null;
  const pictureCamera =
    opts.pictures?.kind === 'given'
      ? opts.pictures.camera
      : browserHost
        ? createPlaywrightCamera(browserHost, logger.child({ component: 'pictures' }))
        : refusedCamera('This daemon takes no pictures');
  const prepareBrowser =
    opts.pictures?.kind === 'given'
      ? opts.pictures.prepare
      : () => {
          void browserHost?.prepare();
        };
  // The project's dev server, while a pass is open and its preview command is set: run under the
  // gate's sandbox, as the dev login is, its processes in a ledger as the browser's are.
  preview = startPreview({
    state,
    bus,
    gate: gateRunner,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    rules: (project) => listPermissionRules(state.db, project.id, null),
    checkouts: () => allCheckouts(state.db),
    logger: logger.child({ component: 'preview' }),
    ledgers:
      ledgerSweep && sandboxRoots
        ? { sweep: ledgerSweep, root: sandboxRoots.files, processes: laneProcesses }
        : null,
  });
  const previewNow = preview;
  // The project's own start command brings its dev stack up when a picture or the dev login finds the
  // app address down, run under the gate's sandbox with Docker allowed.
  const appStartNow = createAppStart({
    state,
    inbox,
    gate: gateRunner,
    dataDir: opts.dataDir,
    clock,
    logger: logger.child({ component: 'app-start' }),
    sessionEnv: () => launcher.projectEnv(),
    rules: (project) => listPermissionRules(state.db, project.id, null),
    checkouts: () => allCheckouts(state.db),
    dockerSockets: () => dockerAccess(homedir(), launcher.projectEnv()).sockets,
    usesDocker: (project) => commandCallsDocker(git, project, project.appStartCommand),
  });
  appStart = appStartNow;
  // The card an earlier build raised for a failed picture sign-in has a fold key nothing closes now.
  for (const old of listOpenByFoldKeyPrefix(state.db, 'pictures-sign-in:')) inbox.withdraw(old.id);
  pictures = startPictures({
    ensureApp: (projectId, signal) => appStartNow.ensureUp(projectId, signal),
    onNoAnswer: (projectId) => {
      void previewNow.lost(projectId);
    },
    // A finished task's pictures go to its project's Slack channel, once per after.
    onAfterCapture: (taskId) => {
      picturePost?.announceTask(taskId);
    },
    // A project's dev login that fails raises its one card, and one that signs in closes it.
    onSignIn: (report) => {
      if (report.problem === null) clearPictureSignInCard({ state, inbox }, report.projectId);
      else raisePictureSignInCard({ state, inbox }, { ...report, problem: report.problem });
    },
    // A project left with an app address and no dev login is offered one.
    onNoSignIn: (projectId) => {
      raiseNoSignInOffer({ state, inbox }, projectId);
    },
    // An on-demand picture (Design review, `check_design`) holds the preview up with no pass open.
    holdApp: (projectId, say) => previewNow.hold(projectId, say),
    // 10db's own dev UI draws nothing without the daemon, so its pictures read it as Open Page's tab does.
    devUi: opts.devUiOrigin ? { origin: opts.devUiOrigin, token: devUiToken(opts.dataDir) } : null,
    state,
    bus,
    signInReporter: createSignInReporter({ state }),
    camera: pictureCamera,
    daemonPort: listening.promise,
    prepareBrowser,
    git,
    signIn: {
      gate: gateRunner,
      dataDir: opts.dataDir,
      now: () => clock.now().getTime(),
      sessionEnv: () => launcher.projectEnv(),
      rules: (project) => listPermissionRules(state.db, project.id, null),
      checkouts: () => allCheckouts(state.db),
    },
    dataDir: opts.dataDir,
    clock,
    logger: logger.child({ component: 'pictures' }),
  });
  // A task finished just before the daemon stopped, and a post Slack refused, are announced again.
  picturePost?.catchUp(clock.now().getTime() - MISSED_AFTER_MS);
  void picturePost?.retryTasks();
  const pictureRetries = setInterval(() => {
    void picturePost?.retryTasks();
  }, SLACK_PICTURE_RETRY_MS);
  pictureRetries.unref();
  // A separate copy's landing that waits is looked at every minute on the injected clock: the folder
  // watcher reports writes, not HEAD or ref moves, so the timer is the one contract.
  const COPY_RECHECK_MS = 60_000;
  let copyRecheck = clock.setTimeout(function recheckCopies() {
    try {
      shipper.recheckCopies();
    } catch (error) {
      logger.warn({ err: error }, 'separate copy landings not rechecked');
    } finally {
      copyRecheck = clock.setTimeout(recheckCopies, COPY_RECHECK_MS);
    }
  }, COPY_RECHECK_MS);
  // Turn pictures go 14 days after their task is done: swept now and once a day.
  const picturePruning = startPruning({
    planFilesDir: (shapeId) => join(shapesDir, shapeId),
    state,
    dataDir: opts.dataDir,
    clock,
    logger: logger.child({ component: 'pictures' }),
  });
  // Tasks made for a branch that is gone from origin land in their project's default now. It asks
  // origin, so it runs beside the start (an offline start waits on no timeout) and ends with it.
  const retiredLandingsAbort = new AbortController();
  const retiredLandings = moveRetiredLandings(delivery, retiredLandingsAbort.signal).catch(
    (error: unknown) => {
      logger.warn({ err: error }, 'tasks on retired landing branches not moved');
    },
  );
  // Pages of the projects listed at the first start take the labels the app's nav shows. It reads
  // git, so it runs beside the start and ends with it.
  const pageLabelsAbort = new AbortController();
  const pageLabels = guessPendingPageLabels(
    { state, git, logger: logger.child({ component: 'page-labels' }) },
    pageLabelsAbort.signal,
  ).catch((error: unknown) => {
    if (!pageLabelsAbort.signal.aborted) logger.warn({ err: error }, 'page labels not guessed');
  });
  const unsubscribeShip = subscribeShipTrigger(bus, state.db, shipper);
  // A copy waiting for its turn is cut when the copy in progress ends, and once now: recovery left
  // a waiting copy as it was, so one whose predecessor ended while the daemon was down goes on.
  const unsubscribeCopyQueue = subscribeCopyQueue(bus, starter);
  starter.advanceCopyQueue();
  // A pass that closes unsettled gets its Move card, and each closed pass is looked at again; a
  // started task's saved work goes once its work lands.
  const unsubscribePassSettles = subscribePassSettles(bus, delivery);
  const unsubscribeKeptWork = subscribeKeptWorkLanding(bus, delivery);
  // A failed Your-folder run of a Commit Directly project takes its work out of the folder.
  const unsubscribeLaneTakeOut = subscribeLaneTakeOut(bus, delivery, keptWork);
  resumePassSettles(delivery);
  // A close a restart cut short goes on from its last step, once recovery has swept what the stopped
  // daemon left: its scratch gate's worktree and process are its own from here.
  passCloses.resume();
  // Outside the delivery job queues: a slow or offline gh never holds a cut or a ship.
  const lookAtHandMadeFolders = createHandMadeFolderLook(delivery);
  const prWatch = createPrWatch({
    ctx: delivery,
    clock,
    ciFix: { dataDir: opts.dataDir },
    // A pull request that conflicts gets its base merged in, and a merge GitHub refused is retried.
    landing: shipper,
    // A pull request that merges or closes ends the fix session still working on it.
    endFixes: {
      cancel: (id) => createdRunner.cancel(id),
      abandon: (id) => shipper.abandon(id),
    },
    ...(opts.prWatchIntervalMs ? { intervalMs: opts.prWatchIntervalMs } : {}),
    // A merged pull request's local branch goes in the round that reads the merge. Then, now and
    // then, the builder's hand-made worktrees whose pull request merged are offered for removal.
    afterRound: async (signal) => {
      await removeMergedBranches(delivery, signal);
      await lookAtHandMadeFolders(signal);
    },
  });
  const unsubscribePrWatch = subscribePrWatch(bus, prWatch);
  answerGhCard = createGhCardAnswers(prWatch);

  // Lanes start and stop through workstream events; keep-awake and the watcher follow them.
  const unsubscribeLanes = bus.subscribe((event) => {
    if (event.type === EventType.WorkstreamCreated || event.type === EventType.WorkstreamChanged) {
      keepAwake.refresh();
      watcher?.sync();
    }
  });
  // A task waiting for a chat's turn, and a put-back that waited for it, start once the folder frees.
  const unsubscribeFolderHold = bus.subscribe((event) => {
    if (event.type === EventType.FolderHoldChanged) createdScheduler.requestTick();
  });
  // A yield the builder chose for a task that then ended is never delivered; drop it.
  const unsubscribeYields = forgetEndedYields(bus, claimWaits);
  keepAwake.refresh();
  watcher?.sync();
  watcher
    ?.resolveSettledStrays()
    .then((closed) => {
      if (closed > 0) logger.info({ closed }, 'closed stray-write cards with nothing left');
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, 'could not close the settled stray-write cards');
    });

  const token = opts.uiToken ?? randomBytes(32).toString('base64url');
  const areaNamer = createAreaNamer({ adapter, launcher, db: state.db, scratchRoot: tmpdir() });
  // Reads each project's repository for its hazards: when it is added, when a commit changes a
  // manifest, lockfile, makefile, compose file or AGENTS.md, and when Settings asks. The model gets text
  // and no tool, like the area namer, and when it is unavailable or slow nothing changes.
  const hazardAssessor = createHazardAssessor({ state, git, asker: areaNamer, logger });
  const projectOfWorkstream = {
    projectOfWorkstream: (id: WorkstreamId): ProjectId | null => {
      try {
        return getWorkstreamRow(state.db, id).projectId;
      } catch {
        return null;
      }
    },
  };
  const unsubscribeHazards = subscribeHazardAssessment(bus, projectOfWorkstream, hazardAssessor);
  // Counts the files each watchpoint covers in a project's checkout, with no model: when the project is added and
  // when a commit is recorded, so Settings finds the counts kept. A count that lands is announced.
  const watchpointCoverage = createWatchpointCoverage({
    git,
    subjects: (projectId) => backgroundSubjects(state.db, projectId),
    landed: (projectId) => {
      announceCoverage(state, projectId);
    },
    logger,
  });
  const unsubscribeCoverage = subscribeWatchpointCoverage(
    bus,
    projectOfWorkstream,
    watchpointCoverage,
  );
  // Assesses each project's evals the same way: when it is added, when a commit changes an eval file, and
  // when the Evals page asks.
  const evalsAssessor = createEvalsAssessor({
    state,
    git,
    evals: evalsService,
    asker: areaNamer,
    logger: logger.child({ module: 'evals' }),
  });
  const evalSuggester = createEvalSuggester({
    db: state.db,
    git,
    asker: areaNamer,
    logger: logger.child({ module: 'evals' }),
  });
  const unsubscribeEvalAssessment = subscribeEvalAssessment(
    bus,
    {
      projectOfWorkstream: (id) => {
        try {
          return getWorkstreamRow(state.db, id).projectId;
        } catch {
          return null;
        }
      },
    },
    evalsAssessor,
  );
  const github = createGithubServices({
    clock,
    spawn: opts.githubLoginSpawn ?? spawnGhLogin({ git: gitBin }),
    resolveGh: () => {
      ghBin = resolveGh();
      return ghBin;
    },
    readLogin: () =>
      delivery.gh.authLogin({
        env: delivery.networkEnv(),
        timeoutMs: delivery.limits.networkTimeoutMs,
      }),
    env: () => delivery.networkEnv(),
    emit: (data) => {
      state.write((ctx) => {
        ctx.emit({
          type: EventType.GithubLoginEnded,
          entityType: 'github',
          entityId: 'login',
          data,
        });
      });
    },
  });
  const thread = createTaskThread({
    state,
    dataDir: opts.dataDir,
    pages: {
      deliver: (taskId, messageId, how) => createdRunner.deliverMessage(taskId, messageId, how),
    },
  });
  const { appMcpPlan, projectMcpServers, ...trust } = createTrustServices({
    state,
    precedents,
    builderHome,
    laneWritableRoots: [worktreeRoot, ...allSandboxRoots],
    worktreeBase: worktreeRoot,
    login: {
      configDir: () => launcher.loginConfigDir(),
      codexHome: () => launcher.loginCodexHome(),
    },
    laneSandbox,
    adapter,
    judge,
    log: logger.child({ component: 'trust' }),
    loginEnv: () => launcher.projectEnv(),
  });
  const mcpSignIns = createMcpSignIns({
    state,
    adapter,
    launcher,
    clock,
    plan: appMcpPlan,
    logger: logger.child({ component: 'mcp-sign-ins' }),
  });
  const linearSignIns = createLinearSignIns({
    state,
    plan: appMcpPlan,
    mcpSignIns,
    connectorNames: (account) => adapter.cachedConnectorNames?.(account),
  });
  const figmaSignIns = createFigmaSignIns({
    state,
    plan: appMcpPlan,
    mcpSignIns,
    connectorNames: (account) => adapter.cachedConnectorNames?.(account),
  });
  // The Linear reporter: one short session of its own per task with updates owed, on the explore engine.
  const linearReporter = createLinearReporter({
    send: outbound,
    state,
    clock,
    log: logger.child({ component: 'linear-reporter' }),
    engine: exploreEngine,
    conversations: reporterConversations(state),
    signIns: linearSignIns,
    inbox,
    picturesOutlook: (taskId) => pictures.outlook(taskId),
  });
  lateLinearReporter = linearReporter;
  /** Each service's own next step once it works for a project. Linear: the project reports to it. */
  const whenConnectedWorks: Record<ConnectableService, (projectId: ProjectId) => void> = {
    linear: (projectId) => {
      linearReporter.setSettings(projectId, { ...reporterSettings(db, projectId), on: true });
    },
    // Figma has no per-project switch: the builder starts every send from a mock-up.
    figma: () => undefined,
  };
  const connector = createServiceConnector({
    state,
    mcp: projectMcpServers,
    bus,
    whenWorks: (service, projectId) => {
      whenConnectedWorks[service](projectId);
    },
    approve: (input) => trust.approveYourMcpServer(input),
    mcpSignIns,
    agents: () => opts.agents ?? null,
    loginEnv: () => launcher.projectEnv(),
    builderHome,
  });
  exploreEngine.register(
    ConversationOwnerKind.Reporter,
    reporterHooks({
      state,
      log: logger.child({ component: 'linear-reporter' }),
      mcp: {
        get url() {
          return mcpUrl;
        },
      },
      runs: linearReporter,
      signIns: linearSignIns,
      launch: createReporterLaunch({ db, launcher }),
      prepare: createReporterPreparer({
        state,
        inbox,
        git,
        logger: logger.child({ component: 'linear-reporter' }),
        laneSandbox,
        protectedPaths: guarded,
        projectEnv: () => launcher.projectEnv(),
        exportAwsCredentials,
        builderHome,
        laneWritableRoots: [worktreeRoot, ...allSandboxRoots],
        worktreeBase: worktreeRoot,
        codexLaneTempRoot: (sandboxRoots ?? namedSandboxRoots({}, homedir())).codexLanes,
      }),
    }),
  );
  // The reporter's owed updates, from the events of tasks linked to Linear issues.
  const unsubscribeLinearEvents = subscribeLinearEvents(bus, {
    state,
    clock,
    reporter: linearReporter,
    log: logger.child({ component: 'linear-reporter' }),
  });
  const linearImport = createLinearImport({ state, chat, signIns: linearSignIns });
  const openWhenBusyDeps: OpenWhenBusyDeps = {
    folderHold,
    pendingOpens,
    stopChatForOpen: (chatId) => chat.stopForOpen(chatId),
    logger: logger.child({ component: 'pass-open' }),
    draining: () => updateDrain.draining,
    notify: (projectId, name, title, body) => {
      inbox.notice({
        tier: CardTier.Notice,
        projectId,
        taskId: null,
        // A pass that waited has no id yet, so its name tells one open from another.
        key: `pass-open-failed:${name.slice(0, 120)}`,
        tone: 'warning',
        line: title,
        body,
      });
    },
  };
  const services = createServices({
    state,
    watchpointCoverage,
    slackConnections,
    github: {
      githubStatus: github.githubStatus,
      startGithubSignin: github.startGithubSignin,
      cancelGithubSignin: github.cancelGithubSignin,
    },
    clock,
    bus,
    liveFrames,
    runner: createdRunner,
    scheduler: createdScheduler,
    startFollowUps: () => {
      startFollowUps();
    },
    waits: queueWaits,
    moves,
    inbox,
    keepAwake,
    agentSkill,
    admission,
    status,
    systemCheck: () =>
      opts.systemCheck
        ? opts.systemCheck({ git: gitBin, gh: ghBin }, () =>
            delivery.gh.authLogin({
              env: delivery.networkEnv(),
              timeoutMs: delivery.limits.networkTimeoutMs,
            }),
          )
        : noSystemCheck(),
    agents: opts.agents ?? null,
    benchmarks,
    benchmarkApi: createBenchmarkServices({
      benchmarks,
      keychain: judgeKeychain,
      off: opts.benchmarksOff === true,
      openRouter: () =>
        openRouterSync?.status() ?? {
          ...noOpenRouterSync(),
          off: opts.judgeOff === true || opts.benchmarksOff === true,
        },
    }),
    catalogue,
    refreshModels,
    catalogueOn: modelRefreshOn,
    openRouterOff: opts.judgeOff === true || opts.benchmarksOff === true,
    // Without a live OpenRouter account the rows are Artificial Analysis's alone.
    openRouterOn: () => openRouterSync !== null && liveOpenRouterAccounts().length > 0,
    trust: { ...trust, ...createProjectTrustServices({ state, inbox, git }) },
    precedents,
    mcpSignIns,
    linearSignIns,
    connector,
    figmaSignIns,
    judge: createJudgeServices({
      state,
      keychain: judgeKeychain,
      judge,
      models: decisionModels,
      off: opts.judgeOff === true,
      onAccountChanged: () => {
        void openRouterSync?.poke();
      },
      clock,
    }),
    stakeholders: createStakeholderApiServices({
      state,
      keychain: judgeKeychain,
      slack: slackClients,
      sends,
      connections: slackConnections,
      clock,
      fetch: outbound,
      watches: replyWatches,
      draftOpts,
      githubLogin: () => Promise.resolve(github.cachedLogin()),
      linear: linearImport,
      onSlackSharingSaved: () => {
        void picturePost?.retryTasks();
      },
      reporter: {
        // Turning updates off also drops a Connect still waiting on a sign-in, which would turn them back on.
        setSettings: (projectId, input) => {
          if (!input.on) connector.forget('linear', projectId);
          linearReporter.setSettings(projectId, input);
        },
      },
    }),
    shape: createShapeServices({
      shape,
      state,
      clock,
      log: logger.child({ component: 'shape-services' }),
      // Reads `services` at call time, as the follow-up starter does.
      startTasks: async (projectId, title, taskIds) => {
        await services.settleSizing(taskIds);
        if (getProject(db, projectId).delivery === Delivery.PullRequest)
          services.startBatch(projectId, { title, taskIds: [...taskIds] });
        else for (const id of taskIds) services.startTask(id);
      },
    }),
    conversation: createConversationServices({
      state,
      engine: exploreEngine,
      chat,
      files: (id, q) => Promise.resolve(conversationFiles(id, q)),
      dataDir: opts.dataDir,
      laneLive,
      task: {
        post: (taskId, message, how) => thread.postTaskMessage(taskId, message, how),
      },
    }),
    chat: createChatApiServices({
      state,
      chat,
      work: chatWork,
      takeover,
      folderHold,
      pendingOpens,
      changes: createChatChanges({ state, git }),
      titleRow: createTitleRowGit({
        state,
        folderHold,
        work: chatWork,
        git,
        gh: delivery.gh,
        filesDir: (conversationId) => chatFolder(opts.dataDir, conversationId),
        secretFilesOf: secretFilesIn,
        net: () => ({
          env: delivery.networkEnv(),
          timeoutMs: delivery.limits.networkTimeoutMs,
        }),
      }),
      git: (repo, args) => runGit(repo, args, { bin: gitBin }),
      now: () => clock.now(),
      log: logger.child({ component: 'chat' }),
    }),
    planRecord: createPlanRecordServices({
      state,
      dataDir: opts.dataDir,
      worktreeRoot,
      sandboxRoots: allSandboxRoots,
    }),
    pictures,
    preview: previewNow,
    daemonPort: () => listenPort,
    thread,
    knowledge: createKnowledgeServices({
      state,
      searchAvailable: knowledgeIndex.failed.length === 0,
    }),
    starter,
    sizing,
    sizingWaitMs: opts.sizingWaitMs ?? JUDGE_TIMEOUT_MS,
    openWhenBusy: openWhenBusyDeps,
    openPass: (input) => openPass(delivery, input, passOpenDeps),
    checkPassOpen: (input) => {
      checkPassOpen(state.db, input);
    },
    takeOut: (input) => takeOut(passTakeOuts, input),
    abandonPass: (passId) => startAbandon(passAbandons, passId),
    joinPass: (passId, input) => joinPass(delivery, passId, input, passOpenDeps),
    discardKeptWork: (taskId) => discardKeptWork(passWork, taskId),
    passPullRequests,
    closes: passCloses,
    signOff: (passId, taskId) => askSignOff(passTakeOuts, passId, taskId),
    cancelSignOff: (passId, taskId) => {
      cancelSignOffWait(passTakeOuts, passId, taskId);
    },
    shipper,
    accounts: accountService,
    worktreeRoot,
    git,
    branchOnOrigin: (repoPath, branch) =>
      git.branchOnOrigin(repoPath, branch, {
        env: delivery.networkEnv(),
        timeoutMs: delivery.limits.networkTimeoutMs,
      }),
    protectedRoots: [opts.dataDir, ...allSandboxRoots, worktreeRoot],
    areaNamer,
    listeners: opts.listeners ?? systemListeners,
    probe: opts.probe ?? loopbackProbe(),
    hazards: hazardAssessor,
    evals: evalsService,
    evalsAssessor,
    evalSuggester,
    evalLive: evalLiveRuns,
    evalSweeps,
    evalCandidates,
    pinCheckout: (repoPath) => {
      // A checkout git can't read yet is recorded at the first git call that succeeds there.
      git.gitDirs(repoPath).catch(() => undefined);
    },
  });
  // A follow-up starts once its source lets it: looked at on every batch and run change, and now.
  startFollowUps = skipFollowUpStarter({
    state,
    log: logger.child({ component: 'skip-follow-ups' }),
    starts: {
      join: (projectId, taskId, batchId) => {
        services.startBatch(projectId, {
          title: getBatch(db, batchId).title,
          taskIds: [taskId],
          batchId,
        });
      },
      base: (taskId) => {
        services.startTask(taskId);
      },
    },
  });
  bus.subscribe((event) => {
    if (event.type === EventType.BatchUpdated || event.type === EventType.WorkstreamChanged)
      startFollowUps();
  });
  startFollowUps();
  startSignInSetup = (taskId) => {
    try {
      const task = getTask(db, taskId);
      if (getProject(db, task.projectId).delivery === Delivery.PullRequest)
        services.startBatch(task.projectId, { title: task.title, taskIds: [taskId] });
      else services.startTask(taskId);
    } catch (error) {
      // The task stays on the board, where the builder can start it.
      logger.warn(
        { taskId, err: error instanceof Error ? error.message : String(error) },
        'could not start the sign-in setup task',
      );
    }
  };
  const build = opts.build ?? null;
  let selfUpdate: SelfUpdate | null = null;
  // What an update waits for, as counts. A queued ship, checkout return or cleanup is a delivery job
  // before it is a row. A lane or gate parked by the drain has begun nothing: it is not cut off by
  // the quit (the stop leaves its saved action for recovery), and counting it would keep the drain
  // going for ever. A shaping conversation with a turn under way counts: it is no workstream, and
  // the quit would cut off the answer in front of the builder. The drain and the install's hold park
  // a turn that has not started (it waits in one of them, so `parked()` takes it off the count, and
  // the quit tells the builder it went unanswered); one running finishes. A lane waiting on a card counts until the drain begins and not after: it runs nothing, the quit ends
  // its session and recovery parks it on its card again, so it must not hold the install, and every
  // lane behind it, for as long as the builder leaves the card.
  // `shapes`, `batches` and `jobs` are the kinds of work among `working` that are no lane or gate, so
  // a drain only they hold can say where to look instead of naming a running step the Board lacks.
  const midSessionWaits = (): {
    working: number;
    waitingOnCard: number;
    batches: number;
    jobs: number;
    shapes: { id: ShapeId; title: string }[];
  } => {
    const waitingOnCard = countWaitingOnCard(state.db);
    const working = Math.max(
      0,
      midSessionWork(state.db, deliveryJobs, shape, { waitingOnCard: false }) -
        updateDrain.parked() -
        installHold.parked(),
    );
    return {
      working,
      waitingOnCard,
      batches: countBatchesInFlight(state.db),
      jobs: deliveryJobs.pending(),
      shapes: shape.runningTurns(),
    };
  };
  const midSessionCount = (): number => {
    const { working, waitingOnCard } = midSessionWaits();
    return updateDrain.draining ? working : working + waitingOnCard;
  };
  // Only a bundle in Applications that knows the repository it was built for follows it; a project,
  // its checkout and its origin have no say in where an update comes from.
  const updateRepository = build?.updatable === true ? build.repository : null;
  if (build !== null && updateRepository !== null) {
    const updateLogger = logger.child({ component: 'self-update' });
    const installer =
      opts.selfUpdate?.installer ??
      (ghBin === null
        ? null
        : createScriptInstaller({
            releaseDir: build.releaseDir,
            workDir: join(opts.dataDir, 'self-update'),
            dataDir: opts.dataDir,
            gh: ghBin,
            env: () => delivery.networkEnv(),
            logger: updateLogger,
          }));
    if (installer === null) {
      updateLogger.warn({}, 'gh is not installed, so the app cannot update itself');
    } else {
      const ghExec = createSystemGhExec(ghTools);
      const ghCall = () => ({
        env: delivery.networkEnv(),
        timeoutMs: delivery.limits.networkTimeoutMs,
      });
      selfUpdate = createSelfUpdate({
        state,
        inbox,
        status,
        clock,
        logger: updateLogger,
        runningCommit: build.commit,
        intervalMs: opts.selfUpdate?.intervalMs ?? DEFAULTS.selfUpdateIntervalMs,
        repository: updateRepository,
        enabled: () => selfUpdateSetting(state.db).enabled,
        // A card only needs a project to sit under in the Inbox.
        cardProject: () => listActiveProjects(state.db)[0]?.id ?? null,
        headOf: opts.selfUpdate?.headOf ?? githubHeadOfMain(ghExec, ghCall),
        isAhead: opts.selfUpdate?.isAhead ?? githubMainIsAhead(ghExec, ghCall),
        stage: (target, running, skip, keep) => installer.stage(target, running, skip, keep),
        stopStage: () => installer.stop(),
        cancelStage: () => installer.cancel(),
        apply: (staged) => installer.apply(staged),
        outcome: installer.outcome,
        rollback: installer.rollback,
        midSession: midSessionCount,
        shapeTurns: () => shape.runningTurns(),
        gates: () =>
          listRunningGates(state.db).map((gate) => ({
            label: `${gate.kind} “${gate.title}”`,
          })),
        waitLimitMs: () => selfUpdateWaitMinutes(state.db) * 60_000,
        drain: {
          begin: (since) => {
            updateDrain.begin(since);
            // An open that waits for chats' turns would hold the update's wait on 10db's jobs for good.
            for (const { projectId, name } of pendingOpens.cancelAll())
              inbox.notice({
                tier: CardTier.Notice,
                projectId,
                taskId: null,
                key: `pass-open-cancelled:${name.slice(0, 120)}`,
                tone: 'info',
                line: `Pass ‘${name}’ was cancelled for 10db’s update`,
                body: 'It was waiting for chats’ turns to end. Open it again once the update is done.',
              });
          },
          end: () => {
            updateDrain.end();
            // A chat that waited for Your folder through the drain runs now.
            folderHold.serveWaiters();
            // Lanes start again, and a batch whose work finished while new ships were held ships.
            createdScheduler.requestTick();
            shipper.checkOpenBatches();
          },
        },
        // New work waits from here on, and the tick the scheduler is in has finished: it may be
        // reading branches and about to launch a lane.
        pause: async () => {
          installHold.begin(clock.now());
          createdScheduler.stop();
          stallSweep.stop();
          await createdScheduler.idle();
        },
        resume: () => {
          installHold.end();
          folderHold.serveWaiters();
          createdScheduler.start();
          stallSweep.start();
          createdScheduler.requestTick();
        },
      });
      answerSelfUpdateCard = createSelfUpdateCardAnswers(selfUpdate, updateLogger);
    }
  }
  // What this install can never do, known now; a test's own installer needs no gh.
  const cannotUpdateAtAll = cannotUpdate(
    build,
    ghBin !== null || opts.selfUpdate?.installer != null,
  );
  const selfUpdateServices: SelfUpdateServices = {
    selfUpdateStatus: () => {
      const progress = selfUpdate?.status();
      return {
        blocker: cannotUpdateAtAll ?? progress?.problem ?? null,
        ...selfUpdateSetting(state.db),
        runningCommit: build?.commit ?? null,
        availableCommit: progress?.availableCommit ?? null,
        notInstalling: progress?.notInstalling ?? null,
        waitMinutes: selfUpdateWaitMinutes(state.db),
        waitingSince: progress?.waitingSince?.toISOString() ?? null,
        draining: progress?.draining ?? false,
        drainingSince: progress?.drainingSince?.toISOString() ?? null,
        midSession: midSessionWaits(),
      };
    },
    setSelfUpdateWait: (minutes) => {
      setSelfUpdateWaitMinutes(state, minutes);
      return selfUpdateServices.selfUpdateStatus();
    },
    installNow: () => {
      selfUpdate?.installNow();
      return selfUpdateServices.selfUpdateStatus();
    },
    setSelfUpdate: (enabled) => {
      setSelfUpdateChoice(state, enabled);
      // A head of main whose update failed, or the build make rollback-app replaced, is tried again
      // once the builder touches the switch.
      selfUpdate?.retry();
      // Off means nothing installs: a stage under way is killed, and a check under way sees the
      // switch before it installs.
      if (!enabled) {
        selfUpdate?.turnOff().catch((error: unknown) => {
          logger.warn({ err: error }, 'could not stop the self-update’s stage');
        });
      }
      return selfUpdateServices.selfUpdateStatus();
    },
  };
  const deviceSockets = createSocketRegistry();
  const sharingLog = logger.child({ component: 'sharing' });
  const tailscaleCli = () =>
    opts.tailscaleOff ? null : (opts.tailscaleCli ?? findTailscaleCli(existsSync));
  const sharing = createSharingService({
    state,
    clock,
    log: sharingLog,
    cli: tailscaleCli,
    run: createTailscaleRun,
    listen: (sharePort) =>
      startShareListener({
        fetch: (req, env) => app.fetch(req, env),
        keepAlive: (wss) => {
          keepSocketsAlive(wss, clock, logger.child({ component: 'events' }));
        },
        port: sharePort,
        sockets: deviceSockets,
        // An unreadable holder is logged and shown as "another process": the port is still held, so the share
        // stays blocked rather than turning into a retry or a non-refusal error.
        holderOf: (port) =>
          lsofHolderOf(port).catch((error: unknown) => {
            sharingLog.warn(
              { error: String(error) },
              'sharing: could not read the port holder from lsof',
            );
            return null;
          }),
      }),
    sockets: deviceSockets,
    mainPort: () => listenPort ?? opts.port,
  });
  const devices = createDeviceService({
    state,
    clock,
    codes: createPairingCodes({ clock }),
    sockets: deviceSockets,
    sharing: () => sharing.status(),
    tailnetName: async (ip) => {
      const cli = tailscaleCli();
      const name =
        cli === null
          ? null
          : await readTailnetName(createTailscaleRun(cli), ip, TAILNET_NAME_TIMEOUT_MS);
      if (name === null) sharingLog.debug({}, 'no tailnet name for the pairing device');
      return name;
    },
  });
  const streamTickets = createTickets({ clock });
  const vapidKeys = createVapidKeyStore(opts.keychain ?? unavailableKeychain);
  const pushService = createPushService({ state, keys: vapidKeys });
  const stopPushSender = startPushSender({
    bus,
    state,
    keys: vapidKeys,
    log: logger.child({ component: 'push' }),
  });
  const app = createApp({
    commit: build?.commit ?? null,
    listenPort: () => listenPort,
    share: { allowlists: () => sharing.allowlists(), hostLogin: () => sharing.hostLogin() },
    remote: { sharing, devices },
    appDir: opts.appDir ?? null,
    push: pushService,
    devices,
    tickets: streamTickets,
    sockets: deviceSockets,
    skillVersion: agentSkill.shippedVersion(),
    devUiOrigin: opts.devUiOrigin ?? null,
    // Only when a dev UI is opted in; it reads and nothing else, and outlives a restart.
    devUi: opts.devUiOrigin ? { token: devUiToken(opts.dataDir), mayRead: devUiMayRead } : null,
    selfUpdate: selfUpdateServices,
    startedAt,
    allowedOrigins: [
      ...(opts.allowedOrigins ?? UI_ORIGINS),
      ...(opts.devUiOrigin ? [opts.devUiOrigin] : []),
    ],
    token,
    services,
    taskRemoval: services,
    builderMcp: createBuilderMcpHandler({ services, log: logger }),
    screens: {
      claim: (signal) => screenBroker.claim(signal),
      deliver: (id, image) => screenBroker.deliver(id, image),
      refuse: (id, reason) => screenBroker.refuse(id, reason),
      tokenValid: (token) => screenBroker.tokenValid(token),
      mayRead: renderMayRead,
      image: (shapeId, name) => screens.image(shapeId, name),
    },
    upgradeWebSocket,
    onUnexpectedError: (error) => {
      logger.error({ err: error }, 'unhandled API error');
    },
    mcp: createMcpHandler({
      protectedPaths: guarded,
      state,
      inbox,
      git,
      log: logger,
      waitObserverFor: (id) => live.get(id)?.observer,
      sessionSignal: (id) => live.get(id)?.signal,
      dataDir: opts.dataDir,
      askedToHandOff: (id) => live.get(id)?.askedToHandOff(),
      showImages: (id, images) => {
        const lane = live.get(id);
        if (lane !== undefined) {
          lane.showImages?.(images);
          return;
        }
        // A chat's or plan's session is no lane: it is found by its conversation.
        const conversationId = getSession(db, id).conversationId;
        if (conversationId !== null) chatLive.get(conversationId, id)?.showImages?.(images);
      },
      awayFor: (id) => live.get(id)?.away,
      claimWaits,
      handOverClaim: (handover) => handOverEdits({ state, git }, handover),
      deliverMessage: (taskId, messageId) =>
        createdRunner.deliverMessage(taskId, messageId, { redo: false }),
      migrationsBase,
      dependencyChanges,
      shapeTools: shape.toolsFor,
      pictures: picturesNow,
      signInSetup: {
        check: (projectId, command) => pictures.checkDevLogin(projectId, command),
        save: async (projectId, devLoginCommand) => {
          await services.patchProject(projectId, { devLoginCommand });
        },
        cannot: (projectId, words) => {
          cannotSignInCard({ state, inbox }, projectId, words);
        },
      },
      ...(laneBrowsers === null
        ? {}
        : { laneBrowser: { browsers: laneBrowsers, sessionOf: (id) => live.get(id)?.browser } }),
      reporter: linearReporter,
      chatTools: createChatTools({
        state,
        bus,
        inbox,
        live: chatLive,
        clock,
        builder: createBuilderTools(services),
        getTask: (id) => services.getTask(id),
        gitTools: {
          git,
          folderHold,
          live: chatLive,
          gh: delivery.gh,
          filesDir: (conversationId) => chatFolder(opts.dataDir, conversationId),
          repoOf: (projectId) => getProject(state.db, projectId).repoPath,
          placeOf: (chatId) => {
            const row = getChat(state.db, chatId);
            return { place: row.workPlace, worktree: row.worktreePath };
          },
          secretFilesOf: secretFilesIn,
          net: () => ({
            env: delivery.networkEnv(),
            timeoutMs: delivery.limits.networkTimeoutMs,
          }),
          takeHere: (chatId) => {
            chatWork.takeHereForGitTool(chatId);
          },
          forgetPullRequest: (chatId, branch) => {
            chatWork.forgetPullRequest(chatId, branch);
          },
        },
      }),
    }),
  });
  // What a restart found of each explore conversation is settled before the API serves it.
  // A move the daemon lost keeps its session's starts held until `finishMoves` has made its worktree.
  chatWork.holdMoving();
  await exploreEngine.recover();
  // After recovery, which cools a reporter conversation a crash cut off: its rows are due, and run.
  linearReporter.start();
  // A takeover the daemon lost while it was opening left files for a chat that is not in the terminal.
  takeover.recover();
  await finishSeals({
    state,
    engine: exploreEngine,
    chat,
    tasks: { start: (taskId) => services.startTask(taskId) },
    logger: logger.child({ component: 'do-it' }),
  });
  const wss = new WebSocketServer({ noServer: true });
  keepSocketsAlive(wss, clock, logger.child({ component: 'events' }));
  const server = serve({
    // The env is marked in place: the server reads back what the upgrade helper writes on this very object.
    fetch: (req, env) => app.fetch(req, Object.assign(env, { listener: Listener.Main })),
    hostname: '127.0.0.1',
    port: opts.port,
    // ws declares `options.noServer?: boolean`, which WebSocketServerLike rejects under
    // exactOptionalPropertyTypes; the runtime shape is what @hono/node-server expects.
    websocket: { server: wss as WebSocketServerLike },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  // A server listening on a TCP port reports an AddressInfo.
  const port = (server.address() as AddressInfo).port;
  listenPort = port;
  listening.resolve(port);
  // A move the restart interrupted finishes now that the server answers; its starts were held meanwhile.
  void chatWork.finishMoves();
  const url = `http://127.0.0.1:${String(port)}`;
  mcpUrl = `${url}/mcp`;
  writeRuntimeFiles(
    opts.dataDir,
    {
      pid: process.pid,
      port,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: startedAt.toISOString(),
    },
    token,
  );
  // Once the daemon listens, off the event loop, which a lane can fill with names; `stop()` ends it.
  const systemTempAbort = new AbortController();
  const systemTempSwept = (
    sandboxRoots === null
      ? Promise.resolve()
      : sweepSystemTempDirs(sandboxRoots.systemTemps, systemTempAbort.signal).then((report) => {
          logSweep(report, "10db's temp dirs");
        })
  ).catch((error: unknown) => {
    logger.warn({ err: error }, "could not sweep 10db's temp dirs from the system temp dirs");
  });

  // Aborted first in `shutdown()`, so no batch starts once a stop has begun; the next night resumes.
  const sessionEventsPruneAbort = new AbortController();
  const pruneSessionEvents = async (): Promise<void> => {
    const cutoff = new Date(clock.now().getTime() - SESSION_EVENTS_RETENTION_MS).toISOString();
    const startedAt = performance.now();
    let total = 0;
    try {
      for (;;) {
        if (sessionEventsPruneAbort.signal.aborted) break;
        const deleted = state.write((ctx) =>
          deleteSessionEventsEndedBefore(ctx, cutoff, SESSION_EVENTS_PRUNE_BATCH),
        );
        total += deleted;
        if (deleted < SESSION_EVENTS_PRUNE_BATCH) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error: unknown) {
      logger.warn({ err: error, deleted: total }, 'could not prune old session events');
      return;
    }
    logger.info(
      {
        deleted: total,
        elapsedMs: Math.round(performance.now() - startedAt),
        stopped: sessionEventsPruneAbort.signal.aborted,
      },
      'pruned old session events',
    );
  };

  const nightly = scheduleNightlyBackup(
    clock,
    async () => {
      await backupDatabase(db, backupsDir, 'nightly', clock.now());
      pruneBackups(backupsDir, 'nightly', DEFAULTS.nightlyBackupsKept);
      await pruneSessionEvents();
    },
    DEFAULTS.nightlyBackupHour,
    (error) => {
      logger.error({ err: error }, 'nightly backup failed');
    },
  );
  // How an install that was under way ended is reported before the scheduler can start anything.
  selfUpdate?.settle();
  selfUpdate?.closeInstalled().catch((error: unknown) => {
    logger.error({ err: error }, 'could not close the failed-update cards of an update that took');
  });
  createdScheduler.start();
  stallSweep.start();
  createdScheduler.requestTick();
  loadGuard.start();
  prWatch.start();
  // After recovery: each workspace's watch first looks for the posts its sends left mid-flight, then reads replies.
  replyWatches.start();
  timerWatch.start();
  // Tasks made while the daemon was down are sized now; the judge is asked about the last day's only.
  sizing.sweep();
  if (selfUpdate) {
    selfUpdate.start();
    selfUpdate.tick().catch((error: unknown) => {
      logger.error({ err: error }, 'the first self-update check failed');
    });
  }
  // After the main listener is up and recovery has run. It never throws, and a slow Tailscale CLI must not hold startup.
  void sharing.start();
  logger.info({ port, dataDir: opts.dataDir }, 'daemon started');

  async function shutdown(): Promise<void> {
    sessionEventsPruneAbort.abort();
    try {
      // First, so a shutdown killed part-way has already unshared.
      await sharing.stop();
      // First: a check that is holding the scheduler back would otherwise start it again while the
      // rest of this shutdown runs. Its flags are set at the call; what it settles on is a stage
      // under way, killed with the gh it started, which is awaited beside the delivery jobs.
      const selfUpdateStopped = (selfUpdate?.stop() ?? Promise.resolve()).catch(
        (error: unknown) => {
          logger.warn({ err: error }, 'could not stop the self-update’s stage');
        },
      );
      createdScheduler.stop();
      // A step that settles during the rest of the stop must not start a new paid run: sweeps end first.
      await evalSweeps.stopAll();
      stallSweep.stop();
      precedents.stop();
      // A move under way leaves its worktree and its row for the next start to finish.
      chatMovesAbort.abort();
      // A sign-in's agent is a child of ours: it is told to end now, in step with the lanes, and awaited
      // before the database closes, so a slow stop does not eat the window the lanes need.
      github.stop();
      const loginStopped = accountService.stop().catch((error: unknown) => {
        logger.warn({ err: error }, 'could not stop the sign-in');
      });
      unsubscribeShip();
      unsubscribeCopyQueue();
      unsubscribeLinearEvents();
      unsubscribePassSettles();
      sizing.stop();
      unsubscribeSignOffWaits();
      unsubscribeMergedPasses();
      unsubscribeKeptWork();
      unsubscribeLaneTakeOut();
      unsubscribePrWatch();
      await prWatch.stop();
      await Promise.all([replyWatches.stop(), timerWatch.stop()]);
      retiredLandingsAbort.abort();
      pageLabelsAbort.abort();
      await Promise.all([retiredLandings, pageLabels]);
      systemTempAbort.abort();
      await systemTempSwept;
      backupsAbort.abort();
      await rootsKeptOutOfBackups;
      // A pass's gate and review on its pushed tip run outside the delivery jobs, as its turn checks do.
      // A capture in flight is dropped; its browser closes with it.
      clearInterval(pictureRetries);
      copyRecheck.cancel();
      await pictures?.stop();
      await appStart?.stop();
      // The dev server 10db started ends with it; a builder's own is never 10db's to stop.
      await preview?.stop();
      // Each live eval run ends `interrupted` and its stop command runs, before the store closes. The
      // sweeps ended at the top of the stop, so none starts a step once its run is interrupted.
      await evalLiveRuns.stopAll();
      picturePruning.stop();
      await pictureCamera.close();
      await laneBrowsers?.close();
      unsubscribeTurnChecks();
      await Promise.all([passPullRequests.stop(), turnChecks.stopAll()]);
      // A gate that waits must not start because shutdown freed the slot of the one it killed.
      gateSlots.close();
      // Aborts a shipping gate and any git or gh child; the batch stays SHIPPING for recovery.
      // Before the delivery jobs: a takeover's open or opener ends, so nothing waits on the terminal.
      await takeover.stop();
      await Promise.all([deliveryJobs.stop(), selfUpdateStopped]);
      benchmarks.stop();
      openRouterSync?.stop();
      await openRouterSync?.idle();
      catalogue.stop();
      await listRefresh.stop();
      accountPauses.stop();
      await mcpSignIns.stopAll().catch((error: unknown) => {
        logger.warn({ err: error }, 'could not stop the mcp sign-ins');
      });
      await adapter.stop?.().catch((error: unknown) => {
        logger.warn({ err: error }, 'could not stop the adapter');
      });
      moveBack.stop();
      nightly.cancel();
      unsubscribeLanes();
      unsubscribeFolderHold();
      folderHold.close();
      unsubscribeYields();
      unsubscribeHazards();
      hazardAssessor.stop();
      unsubscribeCoverage();
      watchpointCoverage.stop();
      unsubscribeEvalAssessment();
      evalsAssessor.stop();
      watcher?.stop();
      keepAwake.stop();
      // A probe in flight writes to the database; the runner can ask for another while it stops.
      await preparer.idle();
      await shape.close();
      // Its rows stay as they are; a run the engine's close cuts is picked up again at the next start.
      await linearReporter.stop();
      await exploreEngine.close();
      await createdRunner.stopAll('shutdown');
      // After the runner: a lane or gate held for load ends on its own stop, and nothing samples again.
      loadGuard.stop();
      updateDrain.stop();
      installHold.stop();
      // After every source that holds or releases a line: a pending timer must not write to the closed database.
      status.stop();
      // After the runner too: what its sessions could not stop stays for the next start.
      ledgerSweep?.stop();
      await preparer.idle();
      await loginStopped;
      // A tick asked for before the stop may still be reading the branches; it launches nothing now,
      // but it reads and writes the database until it ends.
      await createdScheduler.idle();
      unsubscribeSettled();
      stopPushSender();
      unsubscribeSkipped();
      await Promise.all(skippedRaises);
      state.write((ctx) => {
        setAppSetting(ctx, CLEAN_SHUTDOWN_KEY, { at: ctx.now });
      });
      // Neither wss.close() nor server.close() ends sockets that are already open, so a connected
      // UI client would keep stop() waiting forever.
      for (const client of wss.clients) client.terminate();
      wss.close();
      // Only the HTTP/1 server can drop keep-alive sockets; serve() returns it here.
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      removeRuntimeFiles(opts.dataDir);
      claimedRoots?.release();
      db.$client.close();
      lock.release();
    } finally {
      await closeLog();
    }
  }
  // SIGINT then SIGTERM both call stop(); a second shutdown would write to the closed database.
  let stopping: Promise<void> | null = null;

  return {
    url,
    port,
    mcpUrl,
    token,
    state,
    runner: createdRunner,
    scheduler: createdScheduler,
    benchmarks,
    refreshModels,
    judge,
    stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
