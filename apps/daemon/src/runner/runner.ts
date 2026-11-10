import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ClaimKind,
  ConflictError,
  currentStep,
  EventType,
  findingNotes,
  FIX_ATTEMPT_LIMIT,
  InboxKind,
  isModelTier,
  JudgeCallId,
  JudgeDecision,
  JudgeOutcome,
  ModelMarkBasis,
  parseFindings,
  PermissionChoice,
  REVIEW_CARD_DETAIL,
  REVIEW_ROLES,
  StepRole,
  StepStatus,
  ToolAccess,
  Verdict,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamFailure,
  WorkstreamState as S,
  AccountKind,
  AccountProblem,
  type AccountId,
  type AccountModelDto,
  type AccountRefusal,
  type HandoffId,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type InboxTarget,
  type NextAction,
  type ProjectId,
  type ReviewCardDetail,
  type SessionId,
  type TaskMessageId,
  type WorkstreamId,
  type WorkstreamStep,
  InvalidError,
  MIGRATIONS_RENUMBERED_NOTICE_KEY,
  MIGRATIONS_UNCARRIED_NOTICE_KEY,
  PASS_RETRY_TURN_CHOICE,
  PassState,
  PassTurnEnding,
  PassTurnId,
  Provider,
  providerOf,
  TakeOutStep,
  type PassId,
  type TaskId,
} from '@10db/contracts';
import {
  activeClaims,
  clearLease,
  endSession,
  getAccountRow,
  getBatch,
  getJudgeConfig,
  getEvidence,
  getInboxItem,
  getPersona,
  getProject,
  getSessionByProviderId,
  getTask,
  getPassTurn,
  getTaskMessageRow,
  getWorkstream,
  getWorkstreamRow,
  handoffForSession,
  insertDeviation,
  insertEvidence,
  insertRetryLimitFollowUp,
  insertPassTurn,
  insertSession,
  insertSource,
  insertSystemNotice,
  lastTakeOut,
  listAccountModels,
  listModelProfiles,
  latestHandoffForStep,
  latestPassTurn,
  latestToolOp,
  listPermissionRules,
  listSessions,
  listEvidence,
  listTaskFileRows,
  listUndeliveredTaskMessages,
  markSessionStarted,
  markTaskFilesInline,
  markTaskMessagesPushed,
  answeredCardsForTask,
  deniedPermissionsForWorkstream,
  openItemsForWorkstream,
  openPassTurn,
  passPageAreas,
  patchWorkstream,
  recordJudgeOutcome,
  recordProfileOutcome,
  releaseClaim,
  releaseClaims,
  setTaskStatus,
  StaleFenceError,
  type AccountRow,
  type DbReader,
  transitionWorkstream,
  updateSessionUsage,
  type RetryLimitFindings,
  type WorkstreamRow,
  type WriteContext,
} from '@10db/db';
import {
  BACKGROUND_DONE_NUDGE,
  BACKGROUND_DONE_NUDGE_READ_ONLY,
  briefedFromHandoff,
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  contextPackedEvent,
  denialsForLane,
  HANDOFF_FIRM_NUDGE,
  HANDOFF_FIRM_NUDGE_ACCOUNT,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_ACCOUNT,
  HANDOFF_NUDGE_ACCOUNT_READ_ONLY,
  HANDOFF_NUDGE_READ_ONLY,
  PackReason,
  RESULT_NUDGE,
} from '../briefing';
import { handoffStands, nextUnaskedRun, workLeftIn, type UnaskedRun } from './handoff-rule';
import {
  unready,
  type AccountLimits,
  type AccountPreparer,
  type AccountRuntime,
  type ModelListWait,
  type StartGate,
} from '../accounts';
import { clearModelMark, markModelUnusable } from '../catalogue';
import type { Clock, Timer } from '../clock';
import {
  allCheckouts,
  batchCardFields,
  checkoutOf,
  fileFlakyTests,
  flakeNote,
  gateNote,
  MIGRATIONS_HAZARD,
  projectAtCheckout,
  rerunFlaky,
  stepCheck,
  uncarriedSaid,
  type BaseUpdate,
  type BaseUpdates,
  type DeliveryJobs,
  type FlakyTest,
  type MigrationsBase,
} from '../delivery';
import type { StateStore } from '../events';
import {
  AccountLaunchError,
  KeychainError,
  sessionConfigDir,
  type AwsCredentialsExporter,
  type Launcher,
  type SessionLaunch,
} from '../environment';
import type { Git } from '../git';
import { judgePreToolUse, type ProtectedPath } from '../guard';
import type { Judge } from '../judge';
import {
  createPermissionBroker,
  raiseGateHostCards,
  createProjectMcpReader,
  flagMcpFailure,
  type InboxService,
  type WaitObserver,
} from '../inbox';
import type { Logger } from '../log';
import { mintSessionToken } from '../mcp';
import { foldHandEdits, keepTurnWork, passFolderOn, type PassWorkDeps } from '../pass';
import { allowedToolsFor, laneAutoMode, storableRule } from '../permissions';
import { takeFoundHostsReading } from '../registries';
import { retryStep } from '../routing';
import { resolveStep } from './resolve-step';
import {
  fileAccessJudge,
  SandboxProfileError,
  SandboxTempDirError,
  type LaneSandbox,
  type LaneSession,
} from '../sandbox';
import {
  SessionEndReason,
  skippedServersNote,
  splitProjectMcp,
  type SessionAdapter,
  type SessionHandle,
  type TurnResult,
} from '../sessions';
import {
  actionEntering,
  advanceSteps,
  countSendBack,
  failStep,
  moveAfter,
  routingInputs,
  sendBackSteps,
  sendBackTarget,
  type StepEntry,
} from '../team';
import {
  BlockedRun,
  type GateRequest,
  type GateResult,
  type GateRunner,
  type Hold,
} from '../verify';
import { pictureLimitsFor } from '../screens';
import { buildThreadDigest, FRESH_SESSION_NOTICE, taskFilesDir } from '../thread';
import { findClaimed } from '../watcher';
import type { LiveSessions } from './live-sessions';
import { checkedCommits, raiseBuilderCheck, waitsForCheck } from './builder-check';
import { outstandingFixEvidence } from './fix-evidence';
import { shipsAtRetryLimit } from './limit-ship';
import {
  REVIEW_SIZE_DIFF_BYTES,
  REVIEW_SIZE_QUESTION,
  reviewSizeRule,
  reviewSizeState,
} from './review-size';
import {
  createLaneMessages,
  outgoingMessage,
  untakenMessages,
  type LaneMessages,
} from './lane-messages';
import { PASS_TURN_DETAIL } from './pass-check';
import {
  endTurnSteps,
  finishEndedTurn,
  passOfWorkstream,
  queueUntaken,
  startTurn,
} from './pass-turn';
import {
  keepingFeedback,
  nextActionAfterCrash,
  nextActionOnAnotherAccount,
  resumedSessionOf,
  withUndelivered,
} from './next-action';
import { threadInlineBytes } from './thread-pictures';

/**
 * A continuation session starts with the briefing already in context. If that baseline is near or over
 * `handoffPct`, it may hand off only after growing this many points past its first reading. A session
 * that resumes such a conversation keeps the same line.
 */
const HANDOFF_BASELINE_MARGIN_PCT = 5;

/** Why a lane is stopped; `closed` is the runner closing a pass task's session itself. */
export type StopReason = 'cancelled' | 'paused' | 'shutdown' | 'closed';

export interface RunnerLimits {
  readonly maxRecoveryAttempts: number;
  readonly maxFixAttempts: number;
  readonly gateTimeoutMs: number;
  /**
   * How long a session that ended its turn may leave a command running in the background before the
   * step fails naming the command (a hung test would otherwise hold the lane for ever).
   */
  readonly backgroundMs: number;
  /** Gates running at once across the whole daemon. */
  readonly gateSlots: number;
  /**
   * How long a pass task's session waits after a turn ends with nothing more from the agent before
   * it closes and frees its lane; the next message resumes it (Workbench spec §6.3, W14).
   */
  readonly warmIdleMs: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  maxRecoveryAttempts: 3,
  maxFixAttempts: FIX_ATTEMPT_LIMIT,
  gateTimeoutMs: 30 * 60_000,
  backgroundMs: 15 * 60_000,
  // One at a time: a gate runs a whole test suite, and several at once overload the machine.
  gateSlots: 1,
  warmIdleMs: 10 * 60_000,
};

export interface RunnerOptions {
  /** Paths no session tool or command may touch. */
  readonly protectedPaths: readonly ProtectedPath[];
  readonly state: StateStore;
  readonly adapter: SessionAdapter;
  readonly inbox: InboxService;
  /** Told when a step finds no model profile for its account, so the scheduler leaves that account's work alone. */
  readonly modelWait?: Pick<ModelListWait, 'hold'>;
  readonly git: Git;
  /** The daemon's delivery jobs, which a pass task's kept work is written beside. */
  readonly jobs: DeliveryJobs;
  readonly gate: GateRunner;
  /** Brings a batch's base as origin has it now into its branch before each of its gates. */
  readonly baseUpdates: BaseUpdates;
  /** Asked whether a review that is next in line is needed. */
  readonly judge: Judge;
  /**
   * Brings a task's base into its branch before a run that holds the migrations hazard from its
   * start; absent, it isn't.
   */
  readonly migrationsBase?: MigrationsBase;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Gives a repo MCP server that names an AWS profile that profile's short-lived credentials. */
  readonly exportAwsCredentials: AwsCredentialsExporter;
  readonly dataDir: string;
  readonly live: LiveSessions;
  readonly limits: RunnerLimits;
  mcpUrl(): string;
  /** A craft skill's text, for a session that has no plugin to load it from; null when there is none. */
  skillBody(name: string): string | null;
  /** Builds each session's launch, and the env the gate runs in. */
  readonly launcher: Pick<Launcher, 'projectEnv' | 'session'>;
  /** Usage limits, refusals and the monthly cap, per account. */
  readonly accounts: Pick<AccountRuntime, 'blocked' | 'rateLimited' | 'refused' | 'sessionEnded'> &
    Pick<AccountPreparer, 'prepare'> &
    Pick<AccountLimits, 'usageReported'>;
  /** One start at a time on a subscription account. */
  readonly startGate: StartGate;
  onLaneFreed(): void;
  /** Runs after every session ends (the watcher's step-end diff). Errors are logged, never thrown. */
  readonly afterSession?: (workstreamId: WorkstreamId) => Promise<void>;
  /** The OS start time of a pid, stored beside it so recovery can tell a reused PID apart. */
  identifyProcess?(pid: number): Promise<string | null>;
  /** Runs every lane session under the lane sandbox; null (fake sessions and tests) runs none. */
  readonly laneSandbox: LaneSandbox | null;
  /**
   * Where a ChatGPT lane's temp dir is made (`codexLaneTempRoot` of the home, as the daemon made it
   * private), apart from Claude lanes' and outside `/private/tmp`, which Codex opens to every lane.
   */
  readonly codexLaneTempRoot: string;
  /** Where the daemon makes lane copies: no prompt repeats a denied read of it outside the lane's copy. */
  readonly worktreeRoot: string;
  /**
   * While this holds (the Mac is overloaded, or an update drains the factory) no session or task gate
   * starts: each waits here, before anything is built or launched and before a gate takes its batch's
   * turn or a slot, and a stop or cancel ends the wait. Nothing that runs is stopped.
   */
  readonly hold?: Hold;
  /**
   * Told each lane session's temp dir while it runs and when it is gone, so the load guard can name
   * the lane a busy process left in it belongs to.
   */
  readonly laneTempDirs?: {
    set(id: WorkstreamId, dir: string): void;
    delete(id: WorkstreamId): void;
  };
}

/** What has to happen after the write that changed a workstream has committed. */
export type AfterCommit = () => void;

export interface Runner {
  launch(id: WorkstreamId, fence: number): void;
  stop(id: WorkstreamId, reason: StopReason): Promise<void>;
  cancel(id: WorkstreamId): Promise<void>;
  stopAccount(accountId: AccountId, reason: StopReason): Promise<void>;
  stopAll(reason: StopReason): Promise<void>;
  isRunning(id: WorkstreamId): boolean;
  /**
   * Whether the lane waits for the start hold (an overloaded Mac, the update drain) before its next
   * session or its gate: it keeps its claims and frees none until the hold clears.
   */
  isParked(id: WorkstreamId): boolean;
  /**
   * Asks the project's lanes whose session runs on the account to hand off; a lane already asked isn't
   * asked again. A lane between sessions, or waiting for its start slot, needs no nudge: its next
   * session runs where the project is now.
   */
  handOff(projectId: ProjectId, accountId: AccountId, reason: string): void;
  idle(): Promise<void>;
  deliverParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
  /**
   * The builder approved the work a gate-less task finished: it is done, with no session and no review
   * card. Runs inside the write that closes the card, and throws `ConflictError` for a workstream that
   * is not waiting for its check. The result runs once that write has committed.
   */
  approveCheck(ctx: WriteContext, id: WorkstreamId): AfterCommit;
  /**
   * The builder sent the work back with a note: the step that did the work restarts to fix it, counted
   * against the fix attempts like a failed gate, and the workstream fails past them. Runs inside the
   * write that closes the card, and throws `ConflictError` for a workstream that is not waiting for its
   * check. The result runs once that write has committed.
   */
  sendBack(ctx: WriteContext, id: WorkstreamId, note: string): AfterCommit;
  /**
   * Hands the builder's message to a page of a pass (Workbench spec §6.3). A live session gets it at
   * once, after the builder's hand edits are kept and named ahead of it, starting a turn unless one
   * is open; with no session the page is queued to start one with it. The message's row is written.
   */
  deliverMessage(
    taskId: TaskId,
    messageId: TaskMessageId,
    opts: { readonly redo: boolean },
  ): Promise<void>;
  /**
   * The builder chose Retry Turn on a pass task's failed turn: a new turn starts from the failed
   * one's message, in a fresh session. A flag that is not the page's failed turn is left alone.
   */
  retryTurn(item: InboxItemDto, answer: InboxAnswer): void;
  /**
   * Closes a pass task's warm session, freeing its lane, if the page is still Ready and no message
   * waits for a turn: decided in one write, so a message that arrives first keeps it open.
   */
  closeWarm(id: WorkstreamId): Promise<void>;
  /**
   * Ends a pass lane's session, if any (Workbench spec §5.4, §6.3): a working turn is stopped as a
   * stop does and closes as `stopped`, its work kept, with no Ready item and no notification; the
   * page goes back to the queue resuming that session, and runs nothing until the builder writes.
   * Resolves at once with no session.
   */
  stopPassLane(id: WorkstreamId): Promise<void>;
}

/** What the pass module is given to end a pass lane's session. */
export type StopPassLane = Runner['stopPassLane'];

type Outcome =
  | { readonly kind: 'handoff'; readonly handoffId: HandoffId }
  | {
      /** The project moved while the lane waited for its start slot. */
      readonly kind: 'moved';
    }
  | {
      readonly kind: 'step_done';
      readonly withoutHandoff: boolean;
      /** Set when a run of handoffs nobody asked for ended the step: how many it held. */
      readonly unaskedRun: number | null;
      /** How the session ended, in a plain clause: what a step that records no result is failed with. */
      readonly ending: string;
      /** What the session wrote as its last message in its longest turn; '' when it wrote nothing. */
      readonly wrote: string;
    }
  | {
      readonly kind: 'parked';
      readonly inboxId: InboxItemId;
      readonly providerSessionId: string | null;
    }
  | {
      readonly kind: 'paused';
      readonly until: Date | null;
      readonly providerSessionId: string | null;
    }
  | {
      /** The account can take no session now: it is paused or at its monthly cap. */
      readonly kind: 'held';
      readonly until: Date | null;
      /** Set when the account refused the session: it is paused with this reason. */
      readonly refusal: AccountRefusal | null;
      readonly providerSessionId: string | null;
    }
  | {
      /** The account can't start a session yet (no confirmed identity, no secret): it is prepared, not refused. */
      readonly kind: 'unready';
      readonly refusal: AccountRefusal;
      readonly providerSessionId: null;
    }
  | {
      /**
       * No model profile of the account's provider exists yet, before the first read of the catalogue. That is not
       * the account's fault: the step goes back to the queue and is tried again on a later tick.
       */
      readonly kind: 'awaiting_profiles';
      readonly providerSessionId: null;
    }
  | {
      readonly kind: 'crashed';
      readonly message: string;
      readonly providerSessionId: string | null;
    }
  | {
      /** A billing check refused the session; a retry would be refused the same way. */
      readonly kind: 'refused';
      readonly message: string;
      readonly providerSessionId: string | null;
    }
  | {
      /** The account cannot run the model the session launched on; the lane starts over on another. */
      readonly kind: 'model_refused';
      readonly model: string;
      readonly message: string;
      /** What the refusal rests on: Claude Code's own `model_not_found`, or an error's wording alone. */
      readonly basis: ModelMarkBasis;
    }
  | {
      /** The session ended its turn with a command running in the background that never finished. */
      readonly kind: 'background_hung';
      readonly message: string;
      readonly providerSessionId: string | null;
    }
  | {
      readonly kind: 'stopped';
      readonly reason: StopReason;
      readonly providerSessionId: string | null;
    }
  | {
      /** A pass task's session ended between its turns: the page waits for the builder as it was. */
      readonly kind: 'closed';
      readonly providerSessionId: string | null;
    };

type Terminal = Exclude<
  Outcome,
  { kind: 'handoff' } | { kind: 'moved' } | { kind: 'step_done' } | { kind: 'model_refused' }
>;

const PERMISSION_ANSWER_TEXT: Readonly<Record<string, string>> = {
  [PermissionChoice.AllowOnce]:
    'allowed once. Retry the call now; 10db lets this exact call through once.',
  [PermissionChoice.AllowWorkstream]: 'allowed for the rest of this workstream. Retry the call.',
  [PermissionChoice.AllowProject]: 'always allowed in this project. Retry the call.',
  [PermissionChoice.AllowMcpServer]:
    'allowed, with every tool the server listed, in this project. Retry the call.',
  [PermissionChoice.Deny]:
    'denied. The denial covers any equivalent: do not retry it, or a variant of it in another form; work without it, or ask with ask_human.',
};

/** An allow choice with no stored rule behind it (a one-time allow, or a call with no safe rule to store) lets the first identical call through. */
function needsOneTimeAllowance(choice: string, toolName: string, summary: string): boolean {
  if (choice === PermissionChoice.AllowOnce) return true;
  const stored =
    choice === PermissionChoice.AllowWorkstream || choice === PermissionChoice.AllowProject;
  return stored && storableRule(toolName, summary) === undefined;
}

/** A permission card answered while the workstream was parked, as prompt text plus any one-time allowance. */
function permissionAnswer(item: InboxItemDto): {
  prompt: { question: string; answer: string; note: string | null };
  allowOnce: { toolName: string; summary: string; cardId: InboxItemId } | null;
} | null {
  const toolName = item.detail?.['toolName'];
  const summary = item.detail?.['summary'];
  if (!item.answer || typeof toolName !== 'string' || typeof summary !== 'string') return null;
  return {
    prompt: {
      question: `${item.title} ${summary}`,
      answer: PERMISSION_ANSWER_TEXT[item.answer.choice] ?? item.answer.choice,
      note: item.answer.note ?? null,
    },
    allowOnce: needsOneTimeAllowance(item.answer.choice, toolName, summary)
      ? { toolName, summary, cardId: item.id }
      : null,
  };
}

/**
 * Starts watching what a lane session's commands start. A start time `ps` could not read is left to
 * the watch, which reads the process itself; while nothing watches the session it is logged, so
 * what its commands leave running is never stopped unexplained.
 */
function watchLaneProcesses(
  laneSession: LaneSession,
  pid: number | null,
  startedAt: string | null,
  log: Logger,
): void {
  if (pid === null) {
    log.warn({}, 'the lane session reported no process, so what its commands start is not watched');
    return;
  }
  void laneSession.trackProcesses({ pid, startedAt }).then((watched) => {
    if (!watched) {
      log.warn(
        { pid },
        'the lane session’s process could not be read, so what its commands start is watched only once a later reading finds it',
      );
    }
  });
}

/** Stops what a lane session's commands left running; a failure is logged, never thrown, so the session still ends. */
async function stopLaneProcesses(
  laneSession: LaneSession | null,
  workstreamId: WorkstreamId,
  logger: Logger,
): Promise<void> {
  if (laneSession === null) return;
  try {
    await laneSession.endProcesses();
  } catch (error) {
    logger.warn(
      { workstreamId, err: error instanceof Error ? error.message : String(error) },
      'the processes a lane session started could not be stopped',
    );
  }
}

/** A failure as the workstream records it: its kind, which the desktop words, and the detail. */
interface Failure {
  readonly kind: WorkstreamFailure;
  readonly reason: string;
}

/** Why a session is asked to hand off: its context filled, or its account neared its usage limit. */
type HandoffCause = 'context' | 'account';

/** What a session is told when asked to hand off, by why it is asked. */
const NUDGES: Readonly<
  Record<HandoffCause, { readonly edit: string; readonly readOnly: string; readonly firm: string }>
> = {
  context: { edit: HANDOFF_NUDGE, readOnly: HANDOFF_NUDGE_READ_ONLY, firm: HANDOFF_FIRM_NUDGE },
  account: {
    edit: HANDOFF_NUDGE_ACCOUNT,
    readOnly: HANDOFF_NUDGE_ACCOUNT_READ_ONLY,
    firm: HANDOFF_FIRM_NUDGE_ACCOUNT,
  },
};

interface Control {
  readonly fence: number;
  readonly projectId: ProjectId;
  /** The account of the lane's current session, or of its next one: read from the project before each session, so a move applies at the lane's next session. */
  accountId: AccountId;
  stopReason: StopReason | null;
  handle: SessionHandle | null;
  /** Set while a session runs: asks it to hand off once. */
  requestHandoff: ((cause: HandoffCause, reason: string) => void) | null;
  /** Set while the gate runs; aborting it kills the gate's process group. */
  gateAbort: AbortController | null;
  /** Set while the lane waits for an overloaded Mac to calm down before it starts a session. */
  holdAbort: AbortController | null;
  /** True while the lane waits for the hold (a session's or the gate's) to clear: it has begun nothing. */
  parked: boolean;
  /** Set while a session runs; ends its inbox waits so later answers go to the card. */
  endWaits: (() => void) | null;
  /**
   * The step's run of handoffs nobody asked for with no commit between them. Any other session ending
   * clears it; a move, which starts no session, and a refused model leave it, so the run only grows.
   */
  unaskedHandoffs: UnaskedRun | null;
  /** Set while a pass task's session runs: the builder messages it was handed. */
  messages: LaneMessages | null;
  /** The builder stopped the pass task's turn: it closes as stopped. */
  builderStop: boolean;
  /** Closes a pass task's session once it has been idle since its last turn ended. */
  idleTimer: Timer | null;
  done: Promise<void>;
}

/** Per-session mutable state, kept in one object so callbacks and the event loop share it. */
interface SessionState {
  providerSessionId: string | null;
  handoffRequested: boolean;
  /**
   * A tool's answer told the session to hand off if it can't finish (a claim held by a lane the update
   * drain parked). Unlike `handoffRequested`, it sends no nudge and leaves the lane running.
   */
  handoffAskedByTool: boolean;
  /** Why the session was asked to hand off, so a firm nudge uses the same words. */
  handoffCause: HandoffCause;
  /**
   * The first context reading of the conversation's briefing, which its handoff margin is measured
   * from: inherited by a resumed session, taken at the first reading of a briefed session that has
   * none, and null for a conversation that began bare.
   */
  briefingBaselinePct: number | null;
  /** A briefed conversation with no baseline yet: the session's first context reading becomes it. */
  awaitingBriefingBaseline: boolean;
  firmSent: boolean;
  /** A read-only step that ended its turn without a result is asked once. */
  resultNudged: boolean;
  /** How the session's last turn ended; null before any turn did. */
  lastTurn: TurnResult | null;
  /** A turn of the session ended well, so a mark from an error's wording on its model has been cleared. */
  modelProven: boolean;
  /**
   * The longest last message any turn of the session wrote ('' when none did). A review that ends
   * without recording a verdict has usually written its findings here, and the failure card shows them;
   * the longest, because the turn after a nudge only says "done".
   */
  wrote: string;
  /** The share of its context window the session last reported using. */
  contextPct: number | null;
  parkedFor: InboxItemId | null;
  /**
   * The cards the session is waiting on, oldest first, with how many waits each has: a folded card can
   * be asked twice. A card leaves the map when its last wait ends.
   */
  waitingOn: Map<InboxItemId, number>;
  waitTimer: Timer | null;
  /** The commands the session started in the background that still run, as the adapter last reported. */
  backgroundTasks: readonly { readonly id: string; readonly description: string }[];
  /**
   * Set when a turn ended with commands still running in the background: the step is held open, not
   * done. Cleared when the session works again, or when the commands finish and it is told so.
   */
  heldForBackground: boolean;
  /** Fails the step when the held session's commands have not finished in time. */
  backgroundTimer: Timer | null;
  /** Set by the `started` event; a session that never started has no conversation to resume. */
  started: boolean;
  /** Set when the session's handoff ended a run of handoffs nobody asked for: how many it held. */
  unaskedRunEnded: number | null;
  outcome: Outcome | null;
}

/**
 * How a session ended, as one plain clause: its last turn (normal, at the turn limit, or an error) and
 * the share of its context it had used. A session that gave no verdict is failed with this, so the card
 * says whether a retry can help.
 */
function describeEnding(
  st: Pick<SessionState, 'lastTurn' | 'contextPct' | 'unaskedRunEnded'>,
): string {
  const how =
    st.unaskedRunEnded !== null
      ? `it handed off ${String(st.unaskedRunEnded)} times in a row with nobody asking and no commit between`
      : st.lastTurn === null
        ? 'its session closed before any turn finished'
        : st.lastTurn === 'max_turns'
          ? 'its last turn stopped at the turn limit'
          : st.lastTurn === 'error'
            ? 'its last turn ended with an error'
            : 'its last turn ended normally';
  const context =
    st.contextPct === null
      ? ''
      : `, with ${String(Math.round(st.contextPct))}% of its context used`;
  return `${how}${context}.`;
}

/**
 * A pass task's session that would start bare while a turn is open: it cannot resume the turn's
 * conversation, so it starts fresh from the thread's digest and the message the turn began with,
 * as Retry Turn does (Workbench spec §6.3).
 */
function turnMessageFirst(reader: DbReader, taskId: TaskId, action: NextAction): NextAction {
  if (action.kind !== 'start') return action;
  const messageId = openPassTurn(reader, taskId)?.messageId ?? null;
  return messageId === null ? action : { kind: 'feedback', messageId, providerSessionId: null };
}

/** A review that ends without a verdict is rerun once by itself; a second such ending fails the task. */
const NO_VERDICT_ENDINGS_ALLOWED = 2;

/** Reads the stop reason afresh: a stop can land at any await, which narrowing cannot see. */
function stopRequested(ctl: { readonly stopReason: StopReason | null }): StopReason | null {
  return ctl.stopReason;
}

/** A gate stopped before it started, while it waited for its batch's turn. */
function stoppedWaiting(logPath: string): GateResult {
  return {
    exitCode: 130,
    durationMs: 0,
    tail: '',
    logPath,
    timedOut: false,
    aborted: true,
    blockedHosts: [],
  };
}

/** The most of a gate's output its evidence keeps, a note on its base included. */
const GATE_SUMMARY_CHARS = 2000;

/**
 * A gate's evidence text: the note on why it ran without its base as origin has it, when there is
 * one, then as much of the end of its output as fits. A fix session reads both.
 */
function gateSummary(note: string | null, tail: string): string {
  if (note === null) return tail.slice(-GATE_SUMMARY_CHARS);
  const head = `${note}\n\n`;
  const room = GATE_SUMMARY_CHARS - head.length;
  return room > 0 ? `${head}${tail.slice(-room)}` : note.slice(0, GATE_SUMMARY_CHARS);
}

export function createRunner(opts: RunnerOptions): Runner {
  const db = opts.state.db;
  const projectMcpReader = createProjectMcpReader({
    state: opts.state,
    inbox: opts.inbox,
    logger: opts.logger,
    exportAwsCredentials: opts.exportAwsCredentials,
  });
  const active = new Map<WorkstreamId, Control>();
  let idleWaiters: (() => void)[] = [];
  const identify = (pid: number | null): Promise<string | null> =>
    pid === null || !opts.identifyProcess ? Promise.resolve(null) : opts.identifyProcess(pid);

  /** What a pass task's turns keep their work and raise their items with. */
  const passWork: PassWorkDeps = {
    state: opts.state,
    git: opts.git,
    inbox: opts.inbox,
    jobs: opts.jobs,
    logger: opts.logger,
    clock: opts.clock,
  };

  /** Closes the pass task's session once it has been idle `warmIdleMs` since a turn ended. */
  function armIdleClose(id: WorkstreamId, ctl: Control): void {
    ctl.idleTimer?.cancel();
    ctl.idleTimer = opts.clock.setTimeout(() => {
      ctl.idleTimer = null;
      runner.closeWarm(id).catch((error: unknown) => {
        opts.logger.warn(
          { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
          'a warm session did not close when idle',
        );
      });
    }, opts.limits.warmIdleMs);
  }

  function disarmIdleClose(ctl: Control): void {
    ctl.idleTimer?.cancel();
    ctl.idleTimer = null;
  }

  /**
   * Keeps what the builder changed by hand since the page's last turn with the page (Workbench spec
   * §6.4), before a turn opens, and answers what the agent's next message starts with. An edit that
   * cannot be kept now (Your folder off the pass's branch) is kept with the turn's work instead, and
   * the message goes without its note.
   */
  async function foldForTurn(id: WorkstreamId): Promise<string | null> {
    try {
      return (await foldHandEdits(passWork, { workstreamId: id })).agentNote;
    } catch (error) {
      opts.logger.warn(
        { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
        "the builder's hand edits were not folded; the message goes without its note",
      );
      return null;
    }
  }

  /** The provider session the workstream's last session ran, or null when none started. */
  function lastProviderSession(id: WorkstreamId): string | null {
    return (
      [...listSessions(db, id)].reverse().find((s) => s.providerSessionId !== null)
        ?.providerSessionId ?? null
    );
  }

  function freshAction(reader: DbReader, id: WorkstreamId): NextAction {
    const latest = latestHandoffForStep(reader, getWorkstreamRow(reader, id));
    return latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' };
  }

  /**
   * The oldest builder message a session of the workstream was handed and no turn took, or null.
   * The builder writes to the task's implementer, so only an implement step's sessions are handed
   * messages and held to them (Workbench spec §6.3).
   */
  function untakenMessage(reader: DbReader, id: WorkstreamId): TaskMessageId | null {
    const row = getWorkstreamRow(reader, id);
    // A pass task's message waits for a turn whether or not a session was ever handed it.
    if (passOfWorkstream(reader, id)) return untakenMessages(reader, row.taskId)[0] ?? null;
    if (currentStep(row).role !== StepRole.Implement) return null;
    return listUndeliveredTaskMessages(reader, row.taskId)[0]?.id ?? null;
  }

  /**
   * `next`, once a session of the workstream has ended: a builder message it was handed and no turn
   * took starts the next session as `feedback`, so it is not lost (Workbench spec §6.3).
   */
  function carryingUndelivered(reader: DbReader, id: WorkstreamId, next: NextAction): NextAction {
    return withUndelivered(next, untakenMessage(reader, id));
  }

  /**
   * A conversation lives in the config directory of the account its session ran on, so once the
   * project has moved the lane can't resume it: its next action becomes a fresh start on the
   * project's account (accounts spec §6). The new action is saved with the session row, so a lane
   * that never launches there still resumes if the project moves back.
   */
  function actionOnAnotherAccount(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
  ): NextAction | null {
    const action = row.nextAction;
    const resumeId = resumedSessionOf(action);
    if (resumeId === null) return null;
    const ranOn = getSessionByProviderId(db, id, resumeId)?.accountId;
    if (ranOn === undefined || ranOn === ctl.accountId) return null;
    return nextActionOnAnotherAccount(
      action,
      latestHandoffForStep(db, row),
      outstandingFixEvidence(db, row),
    );
  }

  function cancelNow(id: WorkstreamId, fence: number | null): void {
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, {
        to: S.Cancelled,
        fence,
        patch: { currentSessionId: null },
        reason: 'cancelled by the builder',
      });
      releaseClaims(ctx, id);
      clearLease(ctx, id);
    });
    opts.inbox.cancelForWorkstream(id);
  }

  /** FAILED inside a write the caller owns; `patch` adds to what the failure records. */
  function failIn(
    ctx: WriteContext,
    id: WorkstreamId,
    fence: number | null,
    row: WorkstreamRow,
    failure: Failure,
    patch: {
      readonly nextAction?: NextAction;
      readonly stepIndex?: number;
      readonly steps?: WorkstreamStep[];
    } = {},
  ): void {
    const reason = failure.reason;
    // A workstream waiting for the builder reaches FAILED through VERIFYING, as it reaches DONE.
    if (row.state === S.WaitingHuman)
      transitionWorkstream(ctx, id, { to: S.Verifying, fence, reason });
    transitionWorkstream(ctx, id, {
      to: S.Failed,
      fence,
      patch: {
        failureReason: reason,
        failureKind: failure.kind,
        currentSessionId: null,
        ...(row.steps.length > 0 ? { steps: failStep(row.steps, row.stepIndex) } : {}),
        ...patch,
      },
      reason,
    });
    releaseClaims(ctx, id);
    clearLease(ctx, id);
  }

  /** The failed card; `review` is the reviewer's rejection that ended the workstream, when one did. */
  function flagFailed(row: WorkstreamRow, reason: string, review?: ReviewCardDetail): void {
    const batch = batchCardFields(row);
    opts.inbox.flag({
      projectId: row.projectId,
      workstreamId: row.id,
      title: `${WORKSTREAM_FAILED_TITLE_PREFIX}${getTask(db, row.taskId).title}`,
      body: reason,
      ...(batch ? { options: batch.options } : {}),
      ...(batch || review
        ? { detail: { ...batch?.detail, ...(review ? { [REVIEW_CARD_DETAIL]: review } : {}) } }
        : {}),
    });
  }

  function fail(
    id: WorkstreamId,
    fence: number | null,
    failure: Failure,
    review?: ReviewCardDetail,
  ): void {
    const row = getWorkstreamRow(db, id);
    opts.state.write((ctx) => {
      failIn(ctx, id, fence, row, failure);
    });
    flagFailed(row, failure.reason, review);
  }

  /** A step entered now; its floor is the sessions this workstream has run so far. */
  function entryFor(ctx: WriteContext, id: WorkstreamId): StepEntry {
    return { now: ctx.now, sessions: getWorkstream(ctx.tx, id).sessionCount };
  }

  /** Observed stats for the frontier: a finished step counts for its profile. */
  function countFinished(ctx: WriteContext, step: WorkstreamStep): void {
    if (step.profileId)
      recordProfileOutcome(ctx, step.profileId, {
        firstPass: step.attempts === 0,
        escalated: false,
      });
  }

  /** One profile up a retried step's own score. */
  function escalated(
    row: WorkstreamRow,
    step: WorkstreamStep,
    why: string,
    leased: AccountId,
  ): { step: WorkstreamStep; moved: boolean } {
    const project = getProject(db, row.projectId);
    // The account the lane ran on, as `resolveOn` reads it, which differs from the project's after a move.
    const inputs = routingInputs(db, { ...project, accountId: leased });
    const result = retryStep(step, {
      choose: {
        ...inputs,
        def: { role: step.role, need: step.need },
        persona: step.personaId ? getPersona(db, step.personaId) : undefined,
        task: getTask(db, row.taskId),
        project,
      },
      escalate: {
        budgetCeiling: project.budgetCeiling,
        profiles: inputs.profiles,
        ...(inputs.accountModels === undefined ? {} : { accountModels: inputs.accountModels }),
        why,
      },
    });
    return { step: result.step, moved: result.escalated };
  }

  /**
   * DONE: the task is done and its claims and lease are released. No review card is raised: the only
   * answer one could offer is "looks good", which does nothing. The builder reviews the pull request,
   * and the Board's In review column shows the task until it merges.
   */
  function markDone(
    ctx: WriteContext,
    id: WorkstreamId,
    fence: number | null,
    row: WorkstreamRow,
    reason: string,
  ): void {
    transitionWorkstream(ctx, id, { to: S.Done, fence, reason });
    setTaskStatus(ctx, row.taskId, 'done');
    releaseClaims(ctx, id);
    clearLease(ctx, id);
  }

  /**
   * Whether the commits since the batch's base touch Markdown files and nothing else. A git failure
   * (checkout gone, index locked) answers false: QA stays in the plan rather than the error ending
   * the workstream.
   */
  async function changesOnlyMarkdown(row: WorkstreamRow, checkout: string): Promise<boolean> {
    if (row.baseHead === null) return false;
    try {
      const files = await opts.git.filesChangedBetween(
        checkout,
        row.baseHead,
        await opts.git.head(checkout),
      );
      return files.length > 0 && files.every((f) => f.endsWith('.md'));
    } catch (err) {
      opts.logger.warn(
        { workstreamId: row.id, err: err instanceof Error ? err.message : String(err) },
        'keeping the QA step: the changed files could not be listed',
      );
      return false;
    }
  }

  /**
   * QA checks a change as its user would, and a change of Markdown files alone has no behavior to
   * exercise. Whether that is so is known only after implement, from the paths the commits touched, so
   * it is decided when an approving review is about to hand over to QA. The QA step then leaves the
   * plan, as a step an existing skip rule drops never enters one, and the reason is logged. A review
   * that rejects at the retry limit and ships anyway hands over to QA as an approval does, so it
   * gets the same check (`shipping`).
   */
  async function withoutDocsOnlyQa(
    id: WorkstreamId,
    row: WorkstreamRow,
    step: WorkstreamStep,
    shipping = step.result?.verdict === Verdict.Approve,
  ): Promise<WorkstreamRow> {
    const qaIndex = row.stepIndex + 1;
    if (
      step.role !== StepRole.Review ||
      !shipping ||
      row.steps[qaIndex]?.role !== StepRole.Qa ||
      row.baseHead === null
    )
      return row;
    if (!(await changesOnlyMarkdown(row, checkoutOf(db, row)))) return row;
    opts.logger.info({ workstreamId: id }, 'skipping the QA step: only docs changed');
    return { ...row, steps: row.steps.filter((_, i) => i !== qaIndex) };
  }

  /**
   * The steps once the current one is done and step `to` entered (-1: none). A rejection at the
   * retry limit (`atLimit`) files its findings as a follow-up task in the same write and names it on
   * the step.
   */
  function stepsAdvanced(
    ctx: WriteContext,
    row: WorkstreamRow,
    to: number,
    atLimit: RetryLimitFindings | null,
  ): WorkstreamStep[] {
    const steps = advanceSteps(row.steps, row.stepIndex, to, entryFor(ctx, row.id));
    if (!atLimit) return steps;
    const followUp = insertRetryLimitFollowUp(ctx, row.taskId, atLimit);
    return steps.map((s, i) =>
      i === row.stepIndex
        ? { ...s, shippedAtLimit: { followUpTaskId: followUp.id, followUpTitle: followUp.title } }
        : s,
    );
  }

  /** Done with the current step: step `to` runs next, as it would after an approval. */
  function advanceTo(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    step: WorkstreamStep,
    to: number,
    atLimit: RetryLimitFindings | null,
  ): 'next' | 'stop' {
    const next = row.steps[to];
    if (!next) return 'stop';
    opts.state.write((ctx) => {
      countFinished(ctx, step);
      patchWorkstream(ctx, id, ctl.fence, {
        steps: stepsAdvanced(ctx, row, to, atLimit),
        stepIndex: to,
        nextAction: actionEntering(ctx, row, to),
        model: next.model,
        effort: next.effort,
      });
      ctx.emit({
        type: EventType.StepChanged,
        entityType: 'workstream',
        entityId: id,
        data: { stepIndex: to, role: next.role },
      });
    });
    return 'next';
  }

  /**
   * The last read-only step is over and the work is done: DONE, or waiting for the builder's check
   * when the project has no gate. A rejection at the retry limit (`atLimit`) ships the same way and,
   * in the same write, files its findings as a follow-up task and names it on the step.
   */
  async function completeReadOnlySteps(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    step: WorkstreamStep,
    ending: { readonly reason: string; readonly atLimit: RetryLimitFindings | null },
  ): Promise<'stop'> {
    const gateless = getProject(db, row.projectId).gateCommand === null;
    // Nothing checked a read-only approval either: the builder checks what the steps produced.
    const facts = gateless ? await checkFacts(row, checkoutOf(db, row)) : null;
    if (stopRequested(ctl) === 'cancelled') {
      cancelNow(id, ctl.fence);
      return 'stop';
    }
    opts.state.write((ctx) => {
      countFinished(ctx, step);
      patchWorkstream(ctx, id, ctl.fence, {
        steps: stepsAdvanced(ctx, row, -1, ending.atLimit),
      });
      if (facts) {
        waitForBuilder(ctx, id, ctl.fence, row, facts);
        return;
      }
      // The workflow has no RUNNING -> DONE edge; a read-only step changed no code, so no second gate.
      transitionWorkstream(ctx, id, {
        to: S.Verifying,
        fence: ctl.fence,
        reason: 'steps complete',
      });
      markDone(ctx, id, ctl.fence, row, ending.reason);
    });
    return 'stop';
  }

  /**
   * Whether the review step that is next can be left out because a model judged the change small,
   * clear and covered by its tests. The rules that force a review make no call; so does a judge the
   * builder has switched off. The call is made outside any database write. Any answer but `skip` at
   * or above the floor, and every fallback, runs the review. The reason names the model, so the
   * builder sees who skipped it.
   */
  async function reviewSkippedByJudge(
    id: WorkstreamId,
    row: WorkstreamRow,
    review: WorkstreamStep,
    checkout: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (opts.judge.off) return null;
    const config = getJudgeConfig(db);
    const decision = config.decisions.review_size;
    if (!config.enabled || !decision.enabled || row.baseHead === null) return null;
    const task = getTask(db, row.taskId);
    let changes: Awaited<ReturnType<Git['diffSince']>>;
    try {
      const head = await opts.git.head(checkout);
      changes = await opts.git.diffSince(checkout, row.baseHead, head, REVIEW_SIZE_DIFF_BYTES);
    } catch (error) {
      // An unreadable diff is no reason to skip a review.
      opts.logger.warn({ workstreamId: id, err: error }, 'review size: the diff could not be read');
      return null;
    }
    if (reviewSizeRule(task, changes, review, getProject(db, row.projectId).hazards) === 'review')
      return null;
    const answer = await opts.judge.choose({
      decision: JudgeDecision.ReviewSize,
      state: reviewSizeState(task, changes),
      question: REVIEW_SIZE_QUESTION,
      options: ['review', 'skip'],
      workstreamId: id,
      taskId: task.id,
      signal,
    });
    if (answer.kind === 'fallback') {
      opts.logger.info(
        { workstreamId: id, reason: answer.reason, detail: answer.detail },
        'review size: the judge did not answer; the review runs',
      );
      return null;
    }
    const skips = answer.choice === 'skip' && answer.confidence >= decision.floor;
    const callId = JudgeCallId.parse(answer.callId);
    opts.state.write((ctx) => {
      recordJudgeOutcome(
        ctx,
        callId,
        skips || answer.choice === 'review' ? JudgeOutcome.Acted : JudgeOutcome.BelowFloor,
      );
    });
    if (!skips) return null;
    return `review skipped by ${answer.model} (${String(answer.confidence)}): small, clear and covered by its tests`;
  }

  /** After a read-only step's session: the next step in this lane, DONE, a rework, or a failure. */
  async function finishReadOnlyStep(
    id: WorkstreamId,
    ctl: Control,
    started: WorkstreamRow,
    ending: string,
    wrote: string,
  ): Promise<'next' | 'stop'> {
    const step = currentStep(started);
    const row = await withoutDocsOnlyQa(id, started, step);
    const docsOnly = row.steps.length < started.steps.length;
    // A sent-back step still holds its earlier result; only one a session of this step recorded counts.
    const floorSession = (sessionId: SessionId) =>
      (listSessions(db, id).find((x) => x.id === sessionId)?.sequence ?? 0) > step.sessionFloor;
    const recorded = step.result !== null && floorSession(step.result.sessionId);
    const move = recorded
      ? moveAfter(row.steps, row.stepIndex)
      : moveAfter(
          row.steps.map((s, i) => (i === row.stepIndex ? { ...s, result: null } : s)),
          row.stepIndex,
        );
    switch (move.kind) {
      case 'no_result': {
        // Sessions of this step since it started, or since the builder last retried it, that ended
        // their turn with no verdict: this one included.
        const floor = Math.max(step.sessionFloor, step.retryFloor ?? 0);
        const noVerdict = listSessions(db, id).filter(
          (s) => s.sequence > floor && s.exitReason === 'step_done',
        ).length;
        if (REVIEW_ROLES.includes(step.role) && noVerdict < NO_VERDICT_ENDINGS_ALLOWED) {
          // The first such ending is no judgment of the work: the review runs again, from its handoff when it wrote one.
          opts.logger.warn(
            { workstreamId: id, role: step.role, ending },
            'review ended without a verdict; running it once more',
          );
          opts.state.write((ctx) => {
            patchWorkstream(ctx, id, ctl.fence, { nextAction: freshAction(ctx.tx, id) });
          });
          return 'next';
        }
        // A review that wrote its findings but never recorded them: the card carries what it wrote, so
        // the builder can judge the work on it instead of rerunning the review.
        const gave = REVIEW_ROLES.includes(step.role) && wrote !== '';
        fail(
          id,
          ctl.fence,
          {
            kind: WorkstreamFailure.NoResult,
            reason: `The ${step.role} step ended without calling complete_step: ${ending}${gave ? ' What it wrote is on the card.' : ''}`,
          },
          gave
            ? {
                role: step.role,
                personaName: step.personaName,
                at: opts.clock.now().toISOString(),
                findings: parseFindings(wrote),
                summary: wrote,
              }
            : undefined,
        );
        return 'stop';
      }
      case 'done':
        return completeReadOnlySteps(id, ctl, row, step, {
          reason: `${step.role} approved${docsOnly ? '; QA skipped: only docs changed' : ''}`,
          atLimit: null,
        });
      case 'advance':
        return advanceTo(id, ctl, row, step, move.to, null);
      case 'send_back': {
        const attempt = row.attempt + 1;
        if (attempt > opts.limits.maxFixAttempts) {
          const result = step.result;
          if (
            result &&
            shipsAtRetryLimit({
              role: step.role,
              riskTags: getTask(db, row.taskId).riskTags,
              evidence: listEvidence(db, id),
            })
          ) {
            const atLimit = {
              role: step.role === StepRole.Qa ? 'QA' : step.role,
              notes: findingNotes(result.summary),
            };
            // The move an approval would get: a step that follows (QA after review) still runs. One
            // that rejects there is past the limit too, so it ships the same way with its own follow-up.
            // A change of Markdown files alone skips QA here as it does after an approval.
            const shipped = await withoutDocsOnlyQa(id, row, step, true);
            const skippedQa = shipped.steps.length < row.steps.length;
            const to = shipped.stepIndex + 1;
            if (to < shipped.steps.length) return advanceTo(id, ctl, shipped, step, to, atLimit);
            return completeReadOnlySteps(id, ctl, shipped, step, {
              reason: `${step.role} rejected the work at the retry limit; shipped with its findings filed as a follow-up task${skippedQa ? '; QA skipped: only docs changed' : ''}`,
              atLimit,
            });
          }
          fail(
            id,
            ctl.fence,
            {
              kind: WorkstreamFailure.RejectedAtLimit,
              reason: `The ${step.role} step rejected the work and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up`,
            },
            result
              ? {
                  role: step.role,
                  personaName: step.personaName,
                  at: result.at,
                  findings: parseFindings(result.summary),
                  summary: result.summary,
                }
              : undefined,
          );
          return 'stop';
        }
        const target = row.steps[move.to];
        if (!target) return 'stop';
        const up = escalated(row, target, `the ${step.role} step rejected it`, ctl.accountId);
        opts.state.write((ctx) => {
          if (up.moved && target.profileId)
            recordProfileOutcome(ctx, target.profileId, { firstPass: false, escalated: true });
          patchWorkstream(ctx, id, ctl.fence, {
            attempt,
            steps: countSendBack(
              sendBackSteps(row.steps, row.stepIndex, move.to, up.step, entryFor(ctx, id)),
              row.stepIndex,
            ),
            stepIndex: move.to,
            nextAction: { kind: 'revise', reviewStep: row.stepIndex },
            model: up.step.model,
            effort: up.step.effort,
          });
          ctx.emit({
            type: EventType.StepChanged,
            entityType: 'workstream',
            entityId: id,
            data: { stepIndex: move.to, role: target.role, sentBackBy: step.role },
          });
        });
        return 'next';
      }
    }
  }

  /**
   * Parks on `inboxId`, whatever state the workstream reached meanwhile. An answer that landed while
   * the session was stopping is already on the card, so the workstream re-queues with it right away.
   */
  function park(
    id: WorkstreamId,
    fence: number,
    inboxId: InboxItemId,
    providerSessionId: string | null,
  ): void {
    const nextAction: NextAction = { kind: 'answer', inboxId, providerSessionId };
    const answered = getInboxItem(db, inboxId).answer !== null;
    opts.state.write((ctx) => {
      const current = getWorkstreamRow(ctx.tx, id).state;
      if (current === S.Running || current === S.HandingOff)
        transitionWorkstream(ctx, id, {
          to: S.WaitingHuman,
          fence,
          reason: `parking on ${inboxId}`,
        });
      if (answered)
        transitionWorkstream(ctx, id, {
          to: S.Queued,
          fence,
          patch: { nextAction },
          reason: 'answered while parking',
        });
      else patchWorkstream(ctx, id, fence, { nextAction });
      clearLease(ctx, id);
    });
  }

  /** Back to the queue with the next action as it was, and the lease released. */
  function requeue(id: WorkstreamId, ctl: Control, pausedFor: string, queuedFor: string): void {
    opts.state.write((ctx) => {
      // The state machine has no shorter way back to the queue.
      transitionWorkstream(ctx, id, { to: S.PausedLimit, fence: ctl.fence, reason: pausedFor });
      transitionWorkstream(ctx, id, { to: S.Queued, fence: ctl.fence, reason: queuedFor });
      clearLease(ctx, id);
    });
  }

  function settle(id: WorkstreamId, ctl: Control, outcome: Terminal): void {
    const row = getWorkstreamRow(db, id);
    if (
      row.state === S.WaitingHuman &&
      outcome.kind !== 'parked' &&
      !(outcome.kind === 'stopped' && outcome.reason === 'cancelled')
    ) {
      const open = openItemsForWorkstream(db, id)[0];
      if (open) {
        park(id, ctl.fence, open.id, outcome.providerSessionId);
        return;
      }
    }
    switch (outcome.kind) {
      case 'stopped':
        if (outcome.reason === 'cancelled') cancelNow(id, ctl.fence);
        if (outcome.reason === 'paused')
          settle(id, ctl, {
            kind: 'paused',
            until: null,
            providerSessionId: outcome.providerSessionId,
          });
        return;
      case 'paused': {
        const nextAction = carryingUndelivered(
          db,
          id,
          keepingFeedback(
            row.nextAction,
            outcome.providerSessionId
              ? {
                  kind: 'resume',
                  providerSessionId: outcome.providerSessionId,
                  reason: 'the usage limit reset',
                }
              : freshAction(db, id),
          ),
        );
        opts.state.write((ctx) => {
          transitionWorkstream(ctx, id, {
            to: S.PausedLimit,
            fence: ctl.fence,
            patch: { nextAction, pausedUntil: outcome.until?.toISOString() ?? null },
            reason: 'usage limit',
          });
          clearLease(ctx, id);
        });
        return;
      }
      case 'held':
        opts.state.write((ctx) => {
          transitionWorkstream(ctx, id, {
            to: S.PausedLimit,
            fence: ctl.fence,
            // The next action is kept: the lane resumes exactly where it stopped once the account does.
            patch: {
              pausedUntil: outcome.until?.toISOString() ?? null,
              nextAction: carryingUndelivered(
                ctx.tx,
                id,
                keepingFeedback(
                  getWorkstreamRow(ctx.tx, id).nextAction,
                  outcome.providerSessionId
                    ? {
                        kind: 'resume',
                        providerSessionId: outcome.providerSessionId,
                        reason: 'the account resumed',
                      }
                    : getWorkstreamRow(ctx.tx, id).nextAction,
                ),
              ),
            },
            reason: outcome.refusal
              ? `account refused: ${outcome.refusal.problem}`
              : 'the account is paused',
          });
          clearLease(ctx, id);
        });
        if (outcome.refusal) {
          // The account the session ran on, which a move can make differ from the project's own.
          const lane = getProject(db, getWorkstreamRow(db, id).projectId);
          opts.accounts.refused(getAccountRow(db, ctl.accountId), lane.id, outcome.refusal);
        }
        return;
      case 'awaiting_profiles':
        requeue(id, ctl, 'the model catalogue has not been read yet', 'waiting for model profiles');
        // Without this the scheduler would claim the row again on every tick.
        opts.modelWait?.hold(getAccountRow(db, ctl.accountId), row.projectId);
        return;
      case 'unready': {
        requeue(
          id,
          ctl,
          `account not ready: ${outcome.refusal.problem}`,
          'waiting for the account to be ready',
        );
        // The scheduler holds it there until the preparer makes the account ready.
        const lane = getProject(db, row.projectId);
        opts.accounts.prepare(getAccountRow(db, ctl.accountId), lane.id);
        return;
      }
      case 'parked':
        park(id, ctl.fence, outcome.inboxId, outcome.providerSessionId);
        return;
      case 'closed':
        // Only a pass task's session closes; one that is no longer a page's is retried as after a crash.
        settle(id, ctl, {
          kind: 'crashed',
          message: 'the session closed',
          providerSessionId: outcome.providerSessionId,
        });
        return;
      case 'refused':
      case 'background_hung':
        // A retry would hang the same way, and the work it left is for the builder to see.
        fail(id, ctl.fence, { kind: WorkstreamFailure.SessionFailed, reason: outcome.message });
        return;
      case 'crashed': {
        const attempts = row.recoveryAttempts + 1;
        if (attempts > opts.limits.maxRecoveryAttempts) {
          fail(id, ctl.fence, {
            kind: WorkstreamFailure.SessionFailed,
            reason: `The session failed ${String(attempts)} times; last error: ${outcome.message}`,
          });
          return;
        }
        const nextAction = carryingUndelivered(
          db,
          id,
          nextActionAfterCrash(
            row.nextAction,
            outcome.providerSessionId,
            latestHandoffForStep(db, row),
          ),
        );
        opts.state.write((ctx) => {
          transitionWorkstream(ctx, id, {
            to: S.Recovering,
            fence: ctl.fence,
            reason: outcome.message.slice(0, 200),
          });
          transitionWorkstream(ctx, id, {
            to: S.Queued,
            fence: ctl.fence,
            patch: { nextAction, recoveryAttempts: attempts },
            reason: 'retrying after a crash',
          });
          clearLease(ctx, id);
        });
      }
    }
  }

  /**
   * A pass task's session ended between turns (Workbench spec §6.3): a message no turn took queues the
   * page to start a turn with it, resuming the session that ended, and withdraws its item; otherwise
   * the page waits for the builder as it was, its lane freed.
   */
  function closeBetweenTurns(
    id: WorkstreamId,
    ctl: Control,
    providerSessionId: string | null,
  ): void {
    opts.state.write((ctx) => {
      queueUntaken(ctx, id, ctl.fence, providerSessionId);
      clearLease(ctx, id);
    });
  }

  /**
   * Settles how a pass task's session ended, where that differs from any other lane's; false leaves
   * it to `settle`. A page between turns, Ready or on its failed turn's flag, keeps waiting for the
   * builder whatever ended its session, but a cancel.
   */
  async function settlePage(id: WorkstreamId, ctl: Control, outcome: Terminal): Promise<boolean> {
    if (!passOfWorkstream(db, id)) return false;
    if (outcome.kind === 'stopped' && outcome.reason === 'cancelled') return false;
    if (ctl.builderStop)
      await stopTurn(id, ctl.fence, outcome.providerSessionId ?? lastProviderSession(id));
    const row = getWorkstreamRow(db, id);
    if (ctl.builderStop && row.state === S.Queued) {
      opts.state.write((ctx) => {
        clearLease(ctx, id);
      });
      return true;
    }
    if (row.state === S.WaitingHuman && row.nextAction.kind === 'pass_review') {
      closeBetweenTurns(id, ctl, outcome.providerSessionId);
      return true;
    }
    const attempts = row.recoveryAttempts + 1;
    const failure =
      outcome.kind === 'refused' || outcome.kind === 'background_hung'
        ? outcome.message
        : outcome.kind === 'crashed' && attempts > opts.limits.maxRecoveryAttempts
          ? `The session failed ${String(attempts)} times; last error: ${outcome.message}`
          : null;
    if (failure !== null) {
      await failTurn(id, ctl, failure, outcome.providerSessionId);
      return true;
    }
    // A session the runner closed with its turn still open goes on from that turn.
    if (outcome.kind === 'stopped' && outcome.reason === 'closed')
      settle(id, ctl, {
        kind: 'crashed',
        message: 'the session was closed during its turn',
        providerSessionId: outcome.providerSessionId,
      });
    else return false;
    return true;
  }

  /** Closes the page's open turn as stopped, if one is open: its work kept, and nothing Ready. */
  async function stopTurn(
    id: WorkstreamId,
    fence: number | null,
    providerSessionId: string | null,
  ): Promise<void> {
    await endTurnSteps(passWork, {
      workstreamId: id,
      ending: PassTurnEnding.Stopped,
      reply: null,
      fence,
      providerSessionId,
      reason: '',
    });
  }

  /**
   * A pass task's turn that cannot go on (Workbench spec §6.2): it closes as failed, its work kept
   * and its page still claimed, and the page waits on a flag whose Retry Turn sends the builder's
   * message again. A pass lane never fails.
   */
  async function failTurn(
    id: WorkstreamId,
    ctl: Control,
    reason: string,
    providerSessionId: string | null,
  ): Promise<void> {
    await endTurnSteps(passWork, {
      workstreamId: id,
      ending: PassTurnEnding.Failed,
      reply: null,
      fence: ctl.fence,
      providerSessionId,
      reason,
    });
  }

  /** Settles the lane's ending: a pass task's own way first, else as any lane's. */
  async function settleLane(id: WorkstreamId, ctl: Control, outcome: Terminal): Promise<void> {
    if (!(await settlePage(id, ctl, outcome))) settle(id, ctl, outcome);
  }

  /**
   * The step as it launches on `account`: the planned model if the account still offers it, else the step's
   * setting applied to what the account offers now. A changed step is saved with the workstream's model and
   * effort, so the plan shows what ran.
   */
  function resolvedStep(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    step: WorkstreamStep,
    account: AccountRow,
    accountModels: readonly AccountModelDto[],
  ): WorkstreamStep {
    const resolved = resolveOn(row, step, account, accountModels);
    // With nothing to run the step keeps what was planned, so a later resolve can say why it changed.
    if (resolved === step || isModelTier(resolved.model)) return resolved;
    opts.state.write((ctx) => {
      patchWorkstream(ctx, id, ctl.fence, {
        model: resolved.model,
        effort: resolved.effort,
        ...(row.steps.length > 0
          ? { steps: row.steps.map((s, i) => (i === row.stepIndex ? resolved : s)) }
          : {}),
      });
    });
    return resolved;
  }

  /** The step as it would launch on `account` with the models it lists now, saving nothing. */
  function resolveOn(
    row: WorkstreamRow,
    step: WorkstreamStep,
    account: AccountRow,
    accountModels: readonly AccountModelDto[],
  ): WorkstreamStep {
    const project = getProject(db, row.projectId);
    const inputs = routingInputs(db, { ...project, accountId: account.id });
    // A step whose model the account refused starts over in that model's tier.
    const plannedTier =
      listModelProfiles(db).find((p) => p.model === step.model)?.tier ?? undefined;
    return resolveStep(step, account, inputs.profiles, accountModels, {
      plannedTier,
      persona: step.personaId ? getPersona(db, step.personaId) : undefined,
      task: getTask(db, row.taskId),
      project,
      roleSettings: inputs.roleSettings,
      patterns: inputs.patterns,
      tierOverrides: inputs.tierOverrides,
    });
  }

  /**
   * A session ended because its account cannot run the model. The model is marked unusable on the account
   * until the account's list changes (a mark from an error's wording alone ends sooner: see `ModelMarkBasis`),
   * and a card says so; the lane then starts over, and the step takes the
   * tier's next model. An account with no row for the model (it lists none) records nothing, so the lane
   * would ask for the same model again: it fails instead.
   */
  function refuseModel(
    id: WorkstreamId,
    ctl: Control,
    outcome: Extract<Outcome, { kind: 'model_refused' }>,
  ): 'retry' | 'stop' {
    const row = getWorkstreamRow(db, id);
    const account = getAccountRow(db, ctl.accountId);
    const mark = markModelUnusable(opts, account.id, outcome.model, outcome.basis);
    const marked = mark !== null;
    // Another lane may have marked the model already: this one retries whenever choosing again, with the
    // model now unusable, gives another model, and stops only when it would be asked for the same one.
    const again = resolveOn(row, currentStep(row), account, listAccountModels(db, account.id));
    const retry = again.model !== outcome.model;
    const marking = `10db marked ${outcome.model} unusable on ${account.label}`;
    const lead =
      mark === null
        ? `${account.label} no longer lists ${outcome.model}, so 10db could not mark it unusable`
        : mark.endsAt !== null
          ? // The words alone cannot tell a refusal from a config error, so one later session settles the mark.
            `${marking} until ${mark.endsAt}, because the error’s wording named it; after that one session tries it again, and if it is refused the same way it stays unusable until the account's model list changes`
          : outcome.basis === ModelMarkBasis.Wording
            ? `${account.label} refused ${outcome.model} the same way again, so ${marking} until the account's model list changes`
            : `${marking} until the account's model list changes`;
    // A tier name is no model: the account has none left that 10db may run, and its next session holds it.
    const nothingLeft = isModelTier(again.model);
    opts.inbox.flag({
      projectId: row.projectId,
      workstreamId: id,
      title: `${account.label} cannot run ${outcome.model}`,
      body: !retry
        ? `${outcome.message}. ${marked ? `10db marked ${outcome.model} unusable on ${account.label}, but` : `${account.label} lists no models, so 10db cannot mark ${outcome.model} unusable, and`} it would still choose ${outcome.model} for the step, so it stopped the task instead of asking for it again. Name a model for each tier in the account's settings.`
        : nothingLeft
          ? `${outcome.message}. ${lead}, and ${account.label} has nothing left to run the step on.`
          : `${outcome.message}. ${lead}, and is running the step on ${again.model}.`,
      foldKey: `model-refused:${account.id}:${outcome.model}`,
    });
    if (retry) return 'retry';
    // A pass task's turn fails in its own way, and the lane never does.
    if (passOfWorkstream(db, id)) return 'stop';
    opts.state.write((ctx) => {
      failIn(ctx, id, ctl.fence, row, {
        kind: WorkstreamFailure.SessionFailed,
        reason: outcome.message,
      });
    });
    return 'stop';
  }

  async function runSession(id: WorkstreamId, ctl: Control): Promise<Outcome> {
    const row = getWorkstreamRow(db, id);
    const project = getProject(db, row.projectId);
    const checkout = checkoutOf(db, row);
    const task = getTask(db, row.taskId);
    // A page of a pass (Workbench spec §6.2): its session runs turn after turn, each from a builder message.
    const pass = passOfWorkstream(db, id) ?? null;
    const fresh = actionOnAnotherAccount(id, ctl, row);
    // A pass task's session starts from the oldest message no turn has taken, whatever it was queued for.
    const action = pass
      ? turnMessageFirst(
          db,
          task.id,
          withUndelivered(fresh ?? row.nextAction, untakenMessages(db, task.id)[0] ?? null),
        )
      : (fresh ?? row.nextAction);
    const step = currentStep(row);
    const persona = step.personaId ? getPersona(db, step.personaId) : null;
    const priorResults = row.steps.flatMap((s, i) =>
      i !== row.stepIndex && s.result
        ? [{ role: s.role, personaName: s.personaName, result: s.result }]
        : [],
    );
    const reviser = action.kind === 'revise' ? row.steps[action.reviewStep] : undefined;
    const readOnly = step.tools === ToolAccess.ReadOnly;
    // Work with no batch commits on one branch for its whole life: the one HEAD names as its first
    // session starts. A lane that switches branches later can't move its commits elsewhere.
    if (row.batchId === null && row.branch === null) {
      const branch = await opts.git.currentBranch(checkout);
      if (branch !== null)
        opts.state.write((ctx) => {
          patchWorkstream(ctx, id, ctl.fence, { branch });
        });
    }
    const baseHead = row.baseHead ?? (await opts.git.head(checkout));
    // A stop that landed while the head was read finds no handle to stop, so it is honoured here.
    // A stop before any session launched leaves the saved action as it is, so the provider session it
    // names stays the one the lane resumes.
    const savedResumeId = resumedSessionOf(row.nextAction);
    if (ctl.stopReason)
      return { kind: 'stopped', reason: ctl.stopReason, providerSessionId: savedResumeId };
    // So does a move: the account the lane read before the await may not be the project's now.
    if (getProject(db, row.projectId).accountId !== ctl.accountId) return { kind: 'moved' };
    // An overloaded Mac starts no session: wait for it, unless a stop ends the wait first.
    if (opts.hold) {
      const holding = new AbortController();
      ctl.holdAbort = holding;
      ctl.parked = true;
      try {
        await opts.hold.untilClear(holding.signal);
      } finally {
        ctl.holdAbort = null;
        ctl.parked = false;
      }
      const stoppedWhileHeld = stopRequested(ctl);
      if (stoppedWhileHeld)
        return { kind: 'stopped', reason: stoppedWhileHeld, providerSessionId: savedResumeId };
      if (getProject(db, row.projectId).accountId !== ctl.accountId) return { kind: 'moved' };
    }
    const answeredItem = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;
    const resumeId = resumedSessionOf(action);
    const claims = () => activeClaims(db, id).map((c) => ({ kind: c.kind, name: c.name }));
    const permission =
      answeredItem?.kind === InboxKind.Permission ? permissionAnswer(answeredItem) : null;
    const contextPack = buildContextPack(db, getWorkstream(db, id));
    // A fresh session that takes the builder's answer to a fix still needs the failure it was fixing.
    const evidenceId =
      action.kind === 'fix'
        ? action.evidenceId
        : action.kind === 'answer' && action.providerSessionId === null
          ? outstandingFixEvidence(db, row)
          : null;
    const evidence = evidenceId ? getEvidence(db, evidenceId) : null;
    const denialsToTell = () =>
      denialsForLane(deniedPermissionsForWorkstream(db, id), {
        checkout,
        worktreeRoot: opts.worktreeRoot,
      });
    const batchNotices = row.batchId === null ? [] : getBatch(db, row.batchId).notices;
    const noticeBody = (key: string): string | null =>
      batchNotices.find((n) => n.key === key)?.body ?? null;
    const uncarried = batchNotices.find((n) => n.key === MIGRATIONS_UNCARRIED_NOTICE_KEY);
    // Read before the briefing: the briefing follows the account this session runs on, which can
    // differ from the last session's when the project moved. Reading has no side effects.
    const account = getAccountRow(db, ctl.accountId);
    const provider = providerOf(account.kind);
    const skills = persona?.skills ?? [];
    // A builder message to act on (Workbench spec §6.3): a resumed session is handed it, and a fresh
    // one starts from the handoff, then the thread's digest, then the message. Its pictures go as
    // blocks while they fit the account's limits and what the thread's budget has left.
    const limits = pictureLimitsFor(account.kind);
    const feedback = action.kind === 'feedback' ? getTaskMessageRow(db, action.messageId) : null;
    // The builder writes to the task's implementer: only an implement step's sessions are handed what
    // an earlier session was handed and no turn took (§12).
    // A pass task's are read once its session is there to take them (below).
    const untaken =
      step.role === StepRole.Implement && !pass
        ? listUndeliveredTaskMessages(db, task.id).filter((m) => m.id !== feedback?.id)
        : [];
    // Codex stamps no client uuid on a turn, so nothing would show it took a message, and a message
    // held until a turn takes it would hold the lane for ever: a builder message goes to Claude only,
    // as a pass does (Workbench spec W19).
    if (provider === Provider.Codex && (feedback !== null || untaken.length > 0))
      return {
        kind: 'refused',
        message: `The builder's message in this task's thread needs a Claude session, and the project's account "${account.label}" runs Codex, which cannot show that a turn took the message. Move the project to a Claude account and retry.`,
        providerSessionId: savedResumeId,
      };
    const { token, hash } = mintSessionToken();
    const notReady = unready(account);
    if (notReady) return { kind: 'unready', refusal: notReady, providerSessionId: null };
    // The model this session runs on, worked out again on this account: the project may have moved since the
    // step was planned or last ran, or the account may have stopped offering the planned model.
    const accountModels = listAccountModels(db, account.id);
    const launchStep = resolvedStep(id, ctl, row, step, account, accountModels);
    if (isModelTier(launchStep.model)) {
      // Before the catalogue is first read no profile of this provider exists, which says nothing about the account.
      if (!listModelProfiles(db).some((p) => p.provider === provider))
        return { kind: 'awaiting_profiles', providerSessionId: null };
      return {
        kind: 'held',
        until: null,
        refusal: {
          problem: AccountProblem.NoUsableModel,
          message: `${account.label} offers no model 10db may run for the ${launchStep.model} tier`,
          seenIdentity: null,
        },
        providerSessionId: null,
      };
    }
    // Built first, so a missing or changed secret refuses the session before any session row exists.
    let launch: SessionLaunch;
    try {
      launch = opts.launcher.session(account, launchStep.model, accountModels);
    } catch (error) {
      if (!(error instanceof AccountLaunchError || error instanceof KeychainError)) throw error;
      // A locked or unreachable Keychain is the account's problem, not the lane's: it pauses the account
      // like a refusal, and the card's Resume tries again.
      const problem =
        error instanceof KeychainError ? AccountProblem.KeychainUnavailable : error.problem;
      return {
        kind: 'held',
        until: null,
        refusal: { problem, message: error.message, seenIdentity: null },
        providerSessionId: null,
      };
    }
    // The repo's MCP servers expand from the project env: an account's credential never reaches them.
    // A file 10db can't parse fails here too.
    const projectMcp = await projectMcpReader.read({
      project,
      checkout,
      workstreamId: id,
      env: opts.launcher.projectEnv(),
    });
    const mcpServers = splitProjectMcp(projectMcp.servers);
    // A resumed session continues its conversation, so it keeps whether that conversation began from
    // a briefing and the briefing's baseline. A fresh session is briefed only when its prompt carries
    // the handoff.
    const resumed = resumeId ? getSessionByProviderId(db, id, resumeId) : undefined;
    const briefed = resumeId
      ? (resumed?.briefed ?? false)
      : briefedFromHandoff(action, contextPack.handoff, evidence);
    const inheritedBaselinePct = resumed?.briefingBaselinePct ?? null;
    // A subscription's sessions start one at a time until the OAuth refresh race is ruled out.
    const releaseStart =
      account.kind === AccountKind.ClaudeSubscription
        ? await opts.startGate.acquire(account.id)
        : () => undefined;
    // Where Claude Code keeps this account's sessions, and with them each one's saved tool results.
    const configDir = sessionConfigDir(account.kind, launch.env, homedir());
    let laneSession: LaneSession | null = null;
    if (opts.laneSandbox) {
      try {
        laneSession = await opts.laneSandbox.forSession({
          project: projectAtCheckout(project, checkout),
          env: launch.env,
          rules: listPermissionRules(db, project.id, id),
          resumeProviderSessionId: resumeId,
          configDir,
          checkouts: allCheckouts(db),
          mcpServers: mcpServers.stdio,
          provider,
          taskFiles: taskFilesDir(opts.dataDir, task.id),
          ...(account.kind === AccountKind.CodexSignin ? { tempRoot: opts.codexLaneTempRoot } : {}),
        });
      } catch (error) {
        releaseStart();
        // A profile or temp dir the sandbox refuses would be refused the same way on a retry.
        if (error instanceof SandboxProfileError || error instanceof SandboxTempDirError) {
          return {
            kind: 'refused',
            message: `The lane sandbox could not start: ${error.message}`,
            providerSessionId: savedResumeId,
          };
        }
        throw error;
      }
    }
    // A stdio server runs only under the lane sandbox; with none, or with a sandbox it can't have,
    // it is left out and named.
    const sandboxFailures = laneSession?.mcpFailures ?? [];
    for (const failure of sandboxFailures) flagMcpFailure(opts.inbox, project.id, id, failure);
    const mcpNote = skippedServersNote(
      { ...projectMcp, failures: [...projectMcp.failures, ...sandboxFailures] },
      opts.laneSandbox ? [] : Object.keys(mcpServers.stdio),
    );
    if (laneSession) opts.laneTempDirs?.set(id, laneSession.tmpDir);
    const dispose = (): void => {
      opts.laneTempDirs?.delete(id);
      try {
        laneSession?.dispose();
      } catch (error) {
        opts.logger.warn(
          { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
          'the lane temp directory could not be removed',
        );
      }
    };
    const stopping = stopRequested(ctl);
    if (stopping) {
      dispose();
      releaseStart();
      return { kind: 'stopped', reason: stopping, providerSessionId: savedResumeId };
    }
    // The project moved while this lane waited for its start: give the slot back and start over there.
    // So does a hold that came on meanwhile: starting over is what waits for it, with the slot free.
    if (getProject(db, row.projectId).accountId !== ctl.accountId || opts.hold?.holding()) {
      dispose();
      releaseStart();
      return { kind: 'moved' };
    }
    // A turn this session opens folds the builder's hand edits first, as a message into a warm
    // session does; a turn already open folds nothing, since an edit then is kept with the turn.
    // It runs after every refusal of the launch, so the fold's note goes with the session it was
    // made for: a later launch would find nothing left to fold.
    const handNote = pass && !openPassTurn(db, task.id) ? await foldForTurn(id) : null;
    const stoppedFolding = stopRequested(ctl);
    if (stoppedFolding) {
      dispose();
      releaseStart();
      return { kind: 'stopped', reason: stoppedFolding, providerSessionId: savedResumeId };
    }
    const fed =
      feedback === null
        ? null
        : resumeId === null
          ? // A fresh session holds no picture: its start clears every mark an earlier one left.
            outgoingMessage(
              {
                ...feedback,
                files: feedback.files.map((file) => ({ ...file, inlineSent: false })),
              },
              0,
              limits,
            )
          : outgoingMessage(
              feedback,
              threadInlineBytes(listTaskFileRows(db, task.id), limits),
              limits,
            );
    const digest =
      feedback === null || resumeId !== null
        ? null
        : buildThreadDigest(db, task, {
            after:
              contextPack.handoff && briefedFromHandoff(action, contextPack.handoff, evidence)
                ? contextPack.handoff.createdAt
                : null,
            before: feedback.id,
          });
    const prompt = buildSessionPrompt({
      provider,
      inPass: pass !== null,
      sandboxed: Boolean(opts.laneSandbox),
      denials: denialsToTell(),
      answeredCards: answeredCardsForTask(db, row.taskId),
      renumbered: noticeBody(MIGRATIONS_RENUMBERED_NOTICE_KEY),
      uncarried: uncarried === undefined ? null : uncarriedSaid(uncarried),
      task,
      claims: claims(),
      action,
      handoff: contextPack.handoff,
      answer: permission?.prompt ?? contextPack.pendingAnswer,
      contextPack,
      step: {
        index: row.stepIndex,
        count: Math.max(row.steps.length, 1),
        role: step.role,
        personaName: step.personaName,
        instructions: persona?.instructions ?? null,
        skills,
        // A Codex session has no plugin to load a skill from.
        ...(provider === Provider.Codex
          ? {
              skillBodies: skills.flatMap((name) => {
                const body = opts.skillBody(name);
                if (body === null) {
                  opts.logger.warn(
                    { workstreamId: id, skill: name },
                    'a skill has no text to brief a Codex session with',
                  );
                  return [];
                }
                return [body];
              }),
            }
          : {}),
        tools: step.tools,
      },
      priorResults,
      previousResult: readOnly ? step.result : null,
      earlierResults: step.earlier,
      revisedBy: reviser ? { role: reviser.role, personaName: reviser.personaName } : null,
      evidence,
      recovery:
        action.kind === 'resume'
          ? { reason: action.reason, lastOp: latestToolOp(db, id)?.opId ?? null }
          : null,
      ...(fed === null
        ? {}
        : {
            feedback: {
              message: handNote === null ? fed.text : `${handNote}\n\n${fed.text}`,
              digest,
            },
          }),
    });
    let session: ReturnType<typeof insertSession>;
    try {
      session = opts.state.write((ctx) => {
        const s = insertSession(ctx, {
          workstreamId: id,
          provider: providerOf(account.kind),
          model: launchStep.model,
          effort: launchStep.effort,
          mode: 'managed',
          accountId: ctl.accountId,
          mcpTokenHash: hash,
          briefed,
          briefingBaselinePct: inheritedBaselinePct,
        });
        patchWorkstream(ctx, id, ctl.fence, {
          currentSessionId: s.id,
          baseHead,
          ...(action !== row.nextAction ? { nextAction: action } : {}),
        });
        // The message the session starts from starts the page's turn, unless one is open.
        if (pass)
          startTurn(ctx, {
            workstreamId: id,
            sessionId: s.id,
            messageId: feedback?.id ?? null,
            fence: ctl.fence,
          });
        // A fresh session holds no picture an earlier one was sent.
        if (resumeId === null) markTaskFilesInline(ctx, task.id, [], true);
        // Every session's prompt carries the pack (spec §9); a resumed conversation gets it again.
        ctx.emit(
          contextPackedEvent(
            s.id,
            id,
            contextPack,
            resumeId ? PackReason.Resume : PackReason.Start,
          ),
        );
        return s;
      });
      if (fresh) {
        opts.logger.info(
          { workstreamId: id, to: ctl.accountId },
          'the project moved accounts; the lane starts a fresh session',
        );
      }
    } catch (error) {
      dispose();
      releaseStart();
      throw error;
    }

    const abort = new AbortController();
    const st: SessionState = {
      providerSessionId: resumeId,
      handoffRequested: false,
      handoffAskedByTool: false,
      handoffCause: 'context',
      briefingBaselinePct: inheritedBaselinePct,
      awaitingBriefingBaseline: briefed && inheritedBaselinePct === null,
      firmSent: false,
      resultNudged: false,
      lastTurn: null,
      modelProven: false,
      wrote: '',
      contextPct: null,
      parkedFor: null,
      waitingOn: new Map(),
      waitTimer: null,
      backgroundTasks: [],
      heldForBackground: false,
      backgroundTimer: null,
      started: false,
      unaskedRunEnded: null,
      outcome: null,
    };
    const log = opts.logger.child({ workstreamId: id, sessionId: session.id });
    let handle: SessionHandle | null = null;
    let sawEnded = false;
    /** The oldest card still open: a stop or the wait timer parks on it, never on one already answered. */
    const firstOpen = (): InboxItemId | null => [...st.waitingOn.keys()][0] ?? null;
    const openWaits = (): number => [...st.waitingOn.values()].reduce((sum, n) => sum + n, 0);
    // Aborting the waits before the process stops means an answer that lands while a slow session
    // exits goes through onParkedAnswer and the card, never to a waiter that is about to disappear.
    // A session that was waiting parks on its card.
    const endWaits = (): void => {
      st.parkedFor ??= firstOpen();
      st.waitTimer?.cancel();
      st.waitTimer = null;
      abort.abort();
    };
    ctl.endWaits = endWaits;
    const stopWaitingOnBackground = (): void => {
      st.heldForBackground = false;
      st.backgroundTimer?.cancel();
      st.backgroundTimer = null;
    };

    const observer: WaitObserver = {
      onWaitStart(item) {
        st.waitingOn.set(item.id, (st.waitingOn.get(item.id) ?? 0) + 1);
        if (openWaits() > 1) return;
        opts.state.write((ctx) => {
          // A session can ask before its `started` event is processed; STARTING has no edge to WAITING_HUMAN.
          if (getWorkstreamRow(ctx.tx, id).state === S.Starting)
            transitionWorkstream(ctx, id, { to: S.Running, fence: ctl.fence });
          transitionWorkstream(ctx, id, {
            to: S.WaitingHuman,
            fence: ctl.fence,
            reason: `waiting on ${item.id}`,
          });
        });
        st.waitTimer = opts.clock.setTimeout(() => {
          st.parkedFor = firstOpen() ?? item.id;
          // Abort the waits first: an answer that arrives while the session is still stopping then goes
          // through onParkedAnswer and the card, instead of to a waiter that is about to disappear.
          abort.abort();
          void handle?.stop();
        }, project.humanWaitMinutes * 60_000);
      },
      onWaitEnd(item) {
        const left = (st.waitingOn.get(item.id) ?? 0) - 1;
        if (left > 0) st.waitingOn.set(item.id, left);
        else st.waitingOn.delete(item.id);
        // WAITING_HUMAN holds until every wait has ended, including a second wait on the same folded card.
        if (st.waitingOn.size > 0) return;
        st.waitTimer?.cancel();
        st.waitTimer = null;
        opts.state.write((ctx) => {
          transitionWorkstream(ctx, id, {
            to: st.handoffRequested ? S.HandingOff : S.Running,
            fence: ctl.fence,
            reason: 'answered',
          });
        });
      },
    };

    opts.live.register(session.id, {
      signal: abort.signal,
      observer,
      askedToHandOff: () => {
        st.handoffAskedByTool = true;
      },
    });
    const fileAccess = laneSession ? fileAccessJudge(laneSession.fileAccess) : null;
    try {
      handle = opts.adapter.start({
        sessionId: session.id,
        workstreamId: id,
        sequence: session.sequence,
        cwd: checkout,
        prompt: mcpNote ? `${prompt}\n\n${mcpNote}` : prompt,
        ...(fed === null ? {} : { promptUuid: fed.uuid, images: fed.images }),
        model: launch.model,
        effort: launchStep.effort,
        resumeProviderSessionId: resumeId,
        env: launch.env,
        account: launch.expect,
        projectMcpServers: { ...mcpServers.remote, ...laneSession?.mcpServers },
        sandbox: laneSession?.spec ?? null,
        ...(laneSession
          ? {
              lanePermissionMode: laneAutoMode(db, (stored) => {
                opts.logger.warn(
                  { stored },
                  'the lane auto mode setting is not a boolean; using default mode',
                );
              })
                ? 'auto'
                : 'default',
            }
          : {}),
        allowedTools: allowedToolsFor(
          project,
          step.tools,
          laneSession ? { sandboxed: { checkout } } : {},
        ),
        mcp: { url: opts.mcpUrl(), token, toolTimeoutMs: (project.humanWaitMinutes + 5) * 60_000 },
        preToolUse: (req) =>
          judgePreToolUse({
            toolName: req.toolName,
            toolInput: req.input,
            repoPath: checkout,
            ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
            areas: project.areas,
            hazards: project.hazards,
            claims: claims(),
            readOnly,
            delivery: project.delivery,
            protectedPaths: opts.protectedPaths,
            // Every page of the pass is a page here: another task's is never written.
            ...(pass ? { inPass: { pages: passPageAreas(db, pass.id) } } : {}),
            ownSession: {
              configDir,
              providerSessionId: st.providerSessionId ?? resumeId,
              filesDir: taskFilesDir(opts.dataDir, task.id),
            },
            ...(fileAccess ? { fileAccess } : {}),
          }),
        canUseTool: createPermissionBroker(
          { state: opts.state, inbox: opts.inbox, git: opts.git, logger: opts.logger },
          {
            projectId: project.id,
            workstreamId: id,
            sessionId: session.id,
            observer,
            signal: abort.signal,
            allowOnce: permission?.allowOnce ?? null,
            mcpApproved: projectMcp.configHashes,
            ...(laneSession
              ? { sandbox: { fileAccess: laneSession.fileAccess, hazards: project.hazards } }
              : {}),
          },
        ),
      });
    } catch (error) {
      dispose();
      releaseStart();
      throw error;
    }
    ctl.handle = handle;
    const messages = createLaneMessages({
      state: opts.state,
      taskId: task.id,
      handle,
      limits,
      ...(feedback !== null && fed !== null
        ? { prompt: { uuid: fed.uuid, messageId: feedback.id } }
        : {}),
    });
    if (feedback !== null && fed !== null)
      opts.state.write((ctx) => {
        markTaskMessagesPushed(ctx, [feedback.id]);
        markTaskFilesInline(ctx, task.id, fed.blocks, false);
      });
    // A message an earlier session was handed and no turn took goes to this one too (§12). A pass
    // task's session takes every message no turn has taken, read now: from here on one the builder
    // writes is handed to it at once.
    for (const message of untaken) messages.push(message);
    if (pass) {
      messages.pushUntaken(fed === null ? handNote : null);
      ctl.messages = messages;
    }
    /**
     * A pass task's turn end with a handoff (Workbench spec §6.2): one that stands continues the same
     * turn in a fresh session. A run of handoffs nobody asked for is keyed by the task's kept work,
     * since a pass turn never moves the branch, so a long turn that keeps work between them goes on.
     * One asked for and not written gets the firm nudge. True when the turn goes on.
     */
    const passHandoff = async (): Promise<boolean> => {
      const turn = openPassTurn(db, task.id);
      const recorded = handoffForSession(db, session.id);
      const asked = st.handoffRequested || st.handoffAskedByTool;
      if (recorded && turn && recorded.createdAt >= turn.startedAt) {
        const stands = handoffStands({
          asked,
          readOnly: false,
          resultRecorded: false,
          leftNamed: workLeftIn(recorded).length > 0,
          uncommitted: false,
        });
        if (!stands) return false;
        if (!asked) {
          const kept = await keepTurnWork(passWork, { workstreamId: id, turnId: null });
          const unasked = nextUnaskedRun(ctl.unaskedHandoffs, kept.keptSha ?? kept.keptBaseSha);
          if (unasked.atLimit) {
            log.warn({ handoffs: unasked.run.count }, 'turn ended after handoffs nobody asked for');
            return false;
          }
          ctl.unaskedHandoffs = unasked.run;
        }
        st.outcome = { kind: 'handoff', handoffId: recorded.id };
        await handle.stop();
        return true;
      }
      if (st.handoffRequested && !st.firmSent && turn) {
        st.firmSent = true;
        handle.send(NUDGES[st.handoffCause].firm);
        return true;
      }
      return false;
    };
    /**
     * A pass task's turn ended (Workbench spec §6.2). A builder message no turn took means it is
     * not over: the agent is about to see it, and the next completion decides. Otherwise the turn
     * ends Ready, and the session stays open for the builder's next message.
     */
    const passTurnComplete = async (text: string | null): Promise<void> => {
      armIdleClose(id, ctl);
      try {
        const ended = await endTurnSteps(passWork, {
          workstreamId: id,
          ending: PassTurnEnding.Ready,
          reply: text,
          fence: ctl.fence,
          providerSessionId: st.providerSessionId,
          reason: '',
        });
        // A handoff asked of the turn ends with it: the next ask, for the session between turns
        // or for a later turn, is a new one.
        if (ended) {
          st.handoffRequested = false;
          st.firmSent = false;
        }
      } catch (error) {
        if (error instanceof StaleFenceError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ err: message }, "the turn's work could not be kept");
        st.outcome = {
          kind: 'crashed',
          message: `The turn's work could not be kept: ${message}`,
          providerSessionId: st.providerSessionId,
        };
        await handle.stop();
      }
    };
    /** Whether the thread has been told this fresh session began. */
    let noticed = false;
    /** Asks the session to hand off, once: its context filled, or its account neared its usage limit. */
    const requestHandoff = (cause: HandoffCause, reason: string): void => {
      if (st.handoffRequested || st.outcome) return;
      // A pass task's session between turns is closed, not nudged: a nudge would be a turn nobody
      // wrote. Its next message starts a session where the project is then (Workbench spec §6.2).
      if (pass && !openPassTurn(db, task.id)) {
        if (ctl.stopReason !== null) return;
        ctl.stopReason = 'closed';
        log.info({ reason }, 'warm session closed for a handoff');
        void handle.stop();
        return;
      }
      st.handoffRequested = true;
      st.handoffCause = cause;
      opts.state.write((ctx) => {
        if (getWorkstreamRow(ctx.tx, id).state === S.Running)
          transitionWorkstream(ctx, id, { to: S.HandingOff, fence: ctl.fence, reason });
      });
      handle.send(readOnly ? NUDGES[cause].readOnly : NUDGES[cause].edit);
    };
    ctl.requestHandoff = requestHandoff;

    let outcome: Outcome;
    try {
      for await (const event of handle.events) {
        switch (event.type) {
          case 'started': {
            st.providerSessionId = event.providerSessionId;
            laneSession?.setProviderSession(event.providerSessionId);
            st.started = true;
            releaseStart();
            const pidStart = await identify(event.pid);
            // From here on, what the session's commands start is watched, so it can be stopped when
            // the session ends, or after a daemon that died: see `LaneSession.trackProcesses`.
            if (laneSession !== null) watchLaneProcesses(laneSession, event.pid, pidStart, log);
            opts.state.write((ctx) => {
              markSessionStarted(ctx, session.id, event.providerSessionId, event.pid, pidStart);
              // The thread says a fresh session began for the builder's message, once it has.
              if (feedback !== null && resumeId === null && !noticed) {
                noticed = true;
                insertSystemNotice(ctx, task.id, FRESH_SESSION_NOTICE);
              }
              // The session has the answer now. Kept as `answer`, a restart would send it again and
              // re-grant a one-time permission; a fresh action resumes this session after a crash.
              if (action.kind === 'answer')
                patchWorkstream(ctx, id, ctl.fence, { nextAction: freshAction(ctx.tx, id) });
              const current = getWorkstreamRow(ctx.tx, id).state;
              if (current === S.Starting) {
                transitionWorkstream(ctx, id, { to: S.Running, fence: ctl.fence });
                // Asked to hand off before it reported starting: the board shows it handing off, not running.
                if (st.handoffRequested)
                  transitionWorkstream(ctx, id, {
                    to: S.HandingOff,
                    fence: ctl.fence,
                    reason: 'asked to hand off while starting',
                  });
              } else if (current === S.HandingOff && !st.handoffRequested) {
                transitionWorkstream(ctx, id, { to: S.Running, fence: ctl.fence });
              }
            });
            break;
          }
          case 'background_tasks': {
            if (pass) {
              // A command a turn left running never holds the page or wakes the session: its
              // finishing is a notice on the thread, read once the builder looks.
              const finished = st.backgroundTasks.filter(
                (t) => !event.tasks.some((n) => n.id === t.id),
              );
              st.backgroundTasks = event.tasks;
              if (finished.length > 0 && !openPassTurn(db, task.id))
                opts.state.write((ctx) => {
                  insertSystemNotice(
                    ctx,
                    task.id,
                    `A command the agent left running finished: ${finished.map((t) => `"${t.description}"`).join(', ')}`,
                  );
                });
              break;
            }
            st.backgroundTasks = event.tasks;
            if (event.tasks.length > 0 || !st.heldForBackground) break;
            // The commands the turn ended on have finished. A session that ended its turn is not woken
            // by that on its own, so it is told, and goes on to commit (or, read-only, to record its result).
            stopWaitingOnBackground();
            handle.send(readOnly ? BACKGROUND_DONE_NUDGE_READ_ONLY : BACKGROUND_DONE_NUDGE);
            break;
          }
          case 'activity':
            // The session is working again (Claude Code woke it, or an answer did): it is not idle.
            stopWaitingOnBackground();
            disarmIdleClose(ctl);
            opts.state.write((ctx) => {
              patchWorkstream(ctx, id, ctl.fence, { lastActivityAt: ctx.now });
              ctx.emit({
                type: EventType.SessionActivity,
                entityType: 'session',
                entityId: session.id,
                data: { workstreamId: id, kind: event.kind, summary: event.summary.slice(0, 500) },
              });
            });
            break;
          case 'context': {
            st.contextPct = event.percentage;
            if (st.awaitingBriefingBaseline) {
              st.awaitingBriefingBaseline = false;
              st.briefingBaselinePct = event.percentage;
            }
            opts.state.write((ctx) => {
              updateSessionUsage(ctx, session.id, {
                contextPct: event.percentage,
                briefingBaselinePct: st.briefingBaselinePct,
              });
              patchWorkstream(ctx, id, ctl.fence, { contextPct: event.percentage });
              ctx.emit({
                type: EventType.SessionContext,
                entityType: 'session',
                entityId: session.id,
                data: { workstreamId: id, percentage: event.percentage },
              });
            });
            // Only a briefing can start past the line, so only a conversation that began from one
            // gets the margin; a resumed session hands off where the conversation it continues would.
            const handoffAt =
              st.briefingBaselinePct === null
                ? project.handoffPct
                : Math.max(
                    project.handoffPct,
                    st.briefingBaselinePct + HANDOFF_BASELINE_MARGIN_PCT,
                  );
            if (!st.handoffRequested && event.percentage >= handoffAt) {
              requestHandoff('context', `context at ${String(event.percentage)}%`);
            } else if (
              st.handoffRequested &&
              !st.firmSent &&
              event.percentage >= project.nudgePct
            ) {
              st.firmSent = true;
              handle.send(NUDGES[st.handoffCause].firm);
            }
            break;
          }
          case 'consumed': {
            const taken = messages.consumed(event.uuids);
            if (taken.length === 0) break;
            // The message this session was started for is taken: a crash from here resumes the
            // session without handing it the message again.
            opts.state.write((ctx) => {
              const next = getWorkstreamRow(ctx.tx, id).nextAction;
              if (next.kind === 'feedback' && taken.includes(next.messageId))
                patchWorkstream(ctx, id, ctl.fence, { nextAction: freshAction(ctx.tx, id) });
            });
            break;
          }
          case 'compacted': {
            const pack = buildContextPack(db, getWorkstream(db, id));
            opts.state.write((ctx) => {
              const sourceId = insertSource(ctx, 'daemon', { sessionId: session.id });
              insertDeviation(ctx, {
                projectId: project.id,
                workstreamId: id,
                cause: `emergency compaction (${event.trigger})`,
                severity: 'warn',
                signedReason: 'Context ran out before a handoff (10db)',
                sourceId,
              });
              ctx.emit(contextPackedEvent(session.id, id, pack, PackReason.Compaction));
            });
            handle.send(
              compactionReinjection(pack, denialsToTell(), {
                role: step.role,
                answeredCards: answeredCardsForTask(db, row.taskId),
              }),
            );
            break;
          }
          case 'rate_limit':
            // Logged without any identity: what a Max plan reports here is not yet verified.
            log.info(
              { status: event.status, utilization: event.utilization, limitType: event.limitType },
              'usage reported',
            );
            // First, so a project that moves to its fallback is off the account before the pause raises cards.
            opts.accounts.usageReported(ctl.accountId, {
              status: event.status,
              utilization: event.utilization,
              limitType: event.limitType,
              resetsAt: event.resetsAt,
            });
            if (event.status === 'rejected' && !st.outcome) {
              st.outcome = {
                kind: 'paused',
                until: event.resetsAt,
                providerSessionId: st.providerSessionId,
              };
              opts.accounts.rateLimited(ctl.accountId, event.resetsAt, project.id);
            }
            break;
          case 'turn_complete': {
            st.lastTurn = event.result ?? 'success';
            // The model ran a turn: a mark from an error's wording alone on it was wrong.
            if (st.lastTurn === 'success' && !st.modelProven) {
              st.modelProven = true;
              clearModelMark(opts, ctl.accountId, launchStep.model);
            }
            if (event.text && event.text.length > st.wrote.length) st.wrote = event.text;
            opts.state.write((ctx) => {
              updateSessionUsage(ctx, session.id, {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cachedTokens: event.cachedTokens,
                costUsd: event.costUsd,
              });
            });
            // A parked or limited session may still finish its interrupted turn before it exits.
            if (st.outcome || st.parkedFor) break;
            if (pass) {
              if (await passHandoff()) break;
              await passTurnComplete(event.text ?? null);
              break;
            }
            const recorded = handoffForSession(db, session.id);
            const resultRecorded = () =>
              currentStep(getWorkstreamRow(db, id)).result?.sessionId === session.id;
            // When a handoff starts a fresh session is `handoffStands`; the changes in the claims are
            // read only when they decide. A run of handoffs nobody asked for, with no commit between,
            // ends the step at its limit as ending the turn would: the gate and review judge the work.
            const asked = st.handoffRequested || st.handoffAskedByTool;
            const left = recorded ? workLeftIn(recorded) : [];
            const stands =
              recorded !== null &&
              handoffStands({
                asked,
                readOnly,
                resultRecorded: readOnly && resultRecorded(),
                leftNamed: left.length > 0,
                uncommitted:
                  !asked &&
                  !readOnly &&
                  left.length === 0 &&
                  (await claimedChanges(getWorkstreamRow(db, id))).length > 0,
              });
            const unasked =
              recorded && stands && !asked
                ? nextUnaskedRun(ctl.unaskedHandoffs, recorded.gitHead)
                : null;
            // Set at each turn end, so a later turn that reaches no limit clears it.
            st.unaskedRunEnded = unasked?.atLimit ? unasked.run.count : null;
            if (recorded && stands && !unasked?.atLimit) {
              ctl.unaskedHandoffs = unasked?.run ?? null;
              st.outcome = { kind: 'handoff', handoffId: recorded.id };
              await handle.stop();
            } else if (st.handoffRequested && !st.firmSent) {
              st.firmSent = true;
              handle.send(NUDGES[st.handoffCause].firm);
            } else if (
              st.backgroundTasks.length > 0 &&
              !(readOnly
                ? resultRecorded()
                : (await claimedChanges(getWorkstreamRow(db, id))).length === 0)
            ) {
              // Ending the turn is not finishing the step while a command it started still runs and the
              // step's work is still outstanding: the command's result is what the session meant to act
              // on. The session stays open and is told when the command finishes; one that never does
              // fails the step, naming the command. A step that has recorded its result, or has nothing
              // left uncommitted, is done whatever it left running (a dev server, a watcher).
              st.heldForBackground = true;
              st.backgroundTimer?.cancel();
              const commands = st.backgroundTasks.map((t) => t.description);
              log.info({ workstreamId: id, commands }, 'step held open for background commands');
              st.backgroundTimer = opts.clock.setTimeout(() => {
                st.backgroundTimer = null;
                if (st.outcome) return;
                st.outcome = {
                  kind: 'background_hung',
                  message: `The ${step.role} step ended its turn with a command it started in the background still running, and it was still running ${String(Math.round(opts.limits.backgroundMs / 60_000))} minutes later, so the step was stopped. A test or command that never finishes is the likely cause: ${commands.map((c) => `"${c}"`).join(', ')}`,
                  providerSessionId: st.providerSessionId,
                };
                void handle.stop();
              }, opts.limits.backgroundMs);
            } else if (readOnly && !resultRecorded() && !st.resultNudged) {
              st.resultNudged = true;
              handle.send(RESULT_NUDGE);
            } else {
              if (st.unaskedRunEnded !== null)
                log.warn(
                  { workstreamId: id, handoffs: st.unaskedRunEnded },
                  'step ended after a run of handoffs nobody asked for',
                );
              st.outcome = {
                kind: 'step_done',
                withoutHandoff: st.handoffRequested,
                unaskedRun: st.unaskedRunEnded,
                ending: describeEnding(st),
                wrote: st.wrote,
              };
              await handle.stop();
            }
            break;
          }
          case 'ended': {
            sawEnded = true;
            releaseStart();
            const stoppedBy = stopRequested(ctl);
            if (st.outcome) break;
            if (stoppedBy)
              st.outcome = {
                kind: 'stopped',
                reason: stoppedBy,
                providerSessionId: st.providerSessionId,
              };
            else if (st.parkedFor)
              st.outcome = {
                kind: 'parked',
                inboxId: st.parkedFor,
                providerSessionId: st.providerSessionId,
              };
            else {
              switch (event.reason) {
                case SessionEndReason.RateLimited:
                  st.outcome = {
                    kind: 'paused',
                    until: null,
                    providerSessionId: st.providerSessionId,
                  };
                  opts.accounts.usageReported(ctl.accountId, {
                    status: 'rejected',
                    utilization: null,
                    limitType: null,
                    resetsAt: null,
                  });
                  opts.accounts.rateLimited(ctl.accountId, null, project.id);
                  break;
                case SessionEndReason.AccountRefused:
                  st.outcome = {
                    kind: 'held',
                    until: null,
                    refusal: event.refusal ?? {
                      problem: AccountProblem.WrongCredentials,
                      message: event.message ?? 'Claude Code refused the account',
                      seenIdentity: null,
                    },
                    // A session that never started has no conversation to resume; its next action stands.
                    providerSessionId: st.started ? st.providerSessionId : null,
                  };
                  break;
                case SessionEndReason.ModelRefused:
                  st.outcome = {
                    kind: 'model_refused',
                    model: launchStep.model,
                    message: event.message ?? `${account.label} cannot run ${launchStep.model}`,
                    basis: event.refusalBasis ?? ModelMarkBasis.Error,
                  };
                  break;
                case SessionEndReason.BillingRefused:
                  st.outcome = {
                    kind: 'refused',
                    message: event.message ?? 'a billing check refused the session',
                    providerSessionId: st.providerSessionId,
                  };
                  break;
                case SessionEndReason.SandboxRefused:
                  st.outcome = {
                    kind: 'refused',
                    message: event.message ?? 'The lane sandbox could not start',
                    providerSessionId: st.providerSessionId,
                  };
                  break;
                case SessionEndReason.Error:
                case SessionEndReason.Stopped:
                  st.outcome = {
                    kind: 'crashed',
                    message: event.message ?? 'the session stopped unexpectedly',
                    providerSessionId: st.providerSessionId,
                  };
                  break;
                case SessionEndReason.Completed:
                  st.outcome = {
                    kind: 'step_done',
                    withoutHandoff: st.handoffRequested,
                    unaskedRun: st.unaskedRunEnded,
                    ending: describeEnding(st),
                    wrote: st.wrote,
                  };
                  break;
              }
              // A pass task's session that ends between turns has closed; one that ends mid-turn
              // is resumed, whatever ended it.
              if (pass && (st.outcome.kind === 'step_done' || st.outcome.kind === 'crashed'))
                st.outcome = openPassTurn(db, task.id)
                  ? {
                      kind: 'crashed',
                      message:
                        st.outcome.kind === 'crashed'
                          ? st.outcome.message
                          : 'the session ended in the middle of a turn',
                      providerSessionId: st.providerSessionId,
                    }
                  : { kind: 'closed', providerSessionId: st.providerSessionId };
            }
            break;
          }
        }
      }
    } finally {
      // Ending the waits on every exit, before any stop, leaves no inbox waiter on a dead session.
      endWaits();
      stopWaitingOnBackground();
      releaseStart();
      // Leaving the loop without `ended` (a stale fence, a failed write) must not leave the process running.
      if (!sawEnded) await handle.stop().catch(() => undefined);
      opts.live.unregister(session.id);
      // However the session ended (finished, cancelled, handed off, the daemon stopping), nothing
      // its commands started keeps running: a background loop would otherwise outlive the session
      // and hold the Mac busy.
      await stopLaneProcesses(laneSession, id, opts.logger);
      // Only once the lane process is gone: a command still running could swap a part of the tree.
      dispose();
      ctl.handle = null;
      ctl.requestHandoff = null;
      ctl.endWaits = null;
      ctl.messages = null;
      disarmIdleClose(ctl);
      // Every exit ends the session row and frees the workstream's session slot, so a parked answer
      // is delivered, the lane is freed and the session's MCP token stops working.
      outcome = finishSession(id, ctl, session.id, st);
    }
    log.info({ outcome: outcome.kind }, 'session ended');
    opts.accounts.sessionEnded(getAccountRow(db, ctl.accountId), project.id);
    if (opts.afterSession) {
      try {
        await opts.afterSession(id);
      } catch (error) {
        log.warn({ err: String(error) }, 'after-session check failed');
      }
    }
    return outcome;
  }

  /** Works out how a session ended and records it; returns the outcome for the caller to settle. */
  function finishSession(
    id: WorkstreamId,
    ctl: Control,
    sessionId: SessionId,
    st: SessionState,
  ): Outcome {
    const reported: Outcome = st.outcome ?? {
      kind: 'crashed',
      message: 'the session ended without an outcome',
      providerSessionId: st.providerSessionId,
    };
    // A step that ends with a builder message no turn took has not done what the builder asked: it
    // runs again with the message, as after a crash, and counts toward the same limit (Workbench spec
    // §6.3), so a message that is never taken cannot keep a lane running sessions.
    const untaken = reported.kind === 'step_done' ? untakenMessage(db, id) : null;
    const ended: Outcome =
      untaken === null
        ? reported
        : {
            kind: 'crashed',
            message: `the session ended its step without taking the builder's message ${untaken}`,
            providerSessionId: st.providerSessionId,
          };
    // A session whose wait timer fired parks even if it was also limited or stopped meanwhile, so the
    // card (open or already answered) is never orphaned.
    const parkedAfterWait =
      st.parkedFor !== null &&
      (ended.kind === 'paused' ||
        ended.kind === 'held' ||
        ended.kind === 'crashed' ||
        ended.kind === 'refused' ||
        ended.kind === 'background_hung' ||
        (ended.kind === 'stopped' && ended.reason !== 'cancelled'));
    const outcome: Outcome =
      parkedAfterWait && st.parkedFor
        ? { kind: 'parked', inboxId: st.parkedFor, providerSessionId: st.providerSessionId }
        : ended;
    const progressed = outcome.kind === 'handoff' || outcome.kind === 'step_done';
    opts.state.write((ctx) => {
      endSession(
        ctx,
        sessionId,
        outcome.kind === 'stopped' && outcome.reason === 'shutdown' ? 'shutdown' : outcome.kind,
      );
      patchWorkstream(ctx, id, ctl.fence, {
        currentSessionId: null,
        // Progress resets the crash count, so the limit counts consecutive failures (spec §5.4).
        ...(progressed ? { recoveryAttempts: 0 } : {}),
        ...(outcome.kind === 'handoff'
          ? {
              nextAction: carryingUndelivered(ctx.tx, id, {
                kind: 'continue_from_handoff',
                handoffId: outcome.handoffId,
              }),
            }
          : {}),
      });
    });
    return outcome;
  }

  /** The paths in the claims the workstream holds right now that git reports as changed. */
  async function claimedChanges(row: WorkstreamRow): Promise<string[]> {
    const project = getProject(db, row.projectId);
    const changed = await opts.git.changedPaths(checkoutOf(db, row));
    const claims = activeClaims(db, row.id).map((c) => ({ kind: c.kind, name: c.name }));
    return findClaimed(changed, project, claims).sort();
  }

  /**
   * A write step that ends with changes in its claims uncommitted goes back to the same step, which
   * commits them. The gate tests what is committed, so it does not run on this attempt.
   */
  function sendBackUncommitted(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    paths: readonly string[],
  ): void {
    const attempt = row.attempt + 1;
    if (attempt > opts.limits.maxFixAttempts) {
      fail(id, ctl.fence, {
        kind: WorkstreamFailure.RetryLimit,
        reason: `The ${currentStep(row).role} step ended with uncommitted changes in its claims after ${String(row.attempt)} fix attempts and merge sessions, and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up`,
      });
      return;
    }
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, {
        to: S.Queued,
        fence: ctl.fence,
        patch: { nextAction: { kind: 'uncommitted', paths: [...paths] }, attempt },
        reason: `uncommitted changes in ${String(paths.length)} file(s)`,
      });
      clearLease(ctx, id);
    });
  }

  /**
   * The base was merged into the branch and git left conflict markers in `update.paths`: the same
   * step runs again as a session that resolves them, and the gate runs once they are gone. The
   * session asks the builder (ask_human) only for a resolution that would change what a side does,
   * so no card is raised here. A session that leaves them again counts against the retry limit.
   * A step that has used all its fix attempts still gets one session for a new base merge, since
   * the merge is 10db's doing and not a failed attempt of the step's: the limit for these sends is
   * one past the fix limit.
   */
  function sendToMerge(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    update: Extract<BaseUpdate, { readonly kind: 'conflicted' }>,
  ): void {
    const attempt = row.attempt + 1;
    const batch = row.batchId === null ? null : getBatch(db, row.batchId);
    if (attempt > opts.limits.maxFixAttempts + 1) {
      const base = batch?.baseBranch ?? 'the base';
      const sessions = `${String(row.attempt)} fix and merge sessions of this step`;
      const limit = `its retry limit (${String(opts.limits.maxFixAttempts)}, and one more session for a merge) is used up`;
      fail(id, ctl.fence, {
        kind: WorkstreamFailure.RetryLimit,
        // A merge this gate made just now left markers no session has seen: they are not "still" there.
        reason:
          update.fresh === true
            ? `A new merge of ${base} left conflict markers in ${update.paths.join(', ')} that no session has seen yet, but the step has no session left to resolve them: it ran ${sessions}, and ${limit}`
            : `The conflict markers of the merge of ${base} are still in ${update.paths.join(', ')} after ${sessions}, and ${limit}`,
      });
      return;
    }
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, {
        to: S.Queued,
        fence: ctl.fence,
        patch: {
          nextAction: {
            kind: 'merge',
            base: `origin/${batch?.baseBranch ?? 'main'}`,
            paths: [...update.paths],
          },
          attempt,
        },
        reason: `conflict markers in ${String(update.paths.length)} file(s) from the merge of the base`,
      });
      clearLease(ctx, id);
    });
  }

  /** The facts the builder checks: where the task began, where it is now, and what it committed. */
  async function checkFacts(row: WorkstreamRow, checkout: string) {
    const head = await opts.git.head(checkout);
    const baseHead = row.baseHead ?? head;
    return { baseHead, head, commits: await opts.git.commitsSince(checkout, baseHead) };
  }

  /**
   * The last step of a task whose project has no gate is done, but nothing has checked it: the
   * workstream waits for the builder on a `check` card, still holding its claims, with no session and
   * no lease. Only the builder's answer completes it.
   */
  function waitForBuilder(
    ctx: WriteContext,
    id: WorkstreamId,
    fence: number,
    row: WorkstreamRow,
    facts: { baseHead: string; head: string; commits: readonly string[] },
  ): void {
    const card = raiseBuilderCheck(ctx, {
      workstreamId: id,
      projectId: row.projectId,
      taskTitle: getTask(ctx.tx, row.taskId).title,
      ...facts,
    });
    if (getWorkstreamRow(ctx.tx, id).state !== S.Verifying)
      transitionWorkstream(ctx, id, { to: S.Verifying, fence, reason: 'steps complete' });
    transitionWorkstream(ctx, id, {
      to: S.WaitingHuman,
      fence,
      patch: { nextAction: { kind: 'builder_review', inboxId: card.id }, currentSessionId: null },
      reason: 'no gate command: waiting for the builder to check the work',
    });
    clearLease(ctx, id);
  }

  /** The end of a step in a project with no gate command (spec §9.4). */
  async function finishWithoutGate(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    checkout: string,
  ): Promise<void> {
    const facts = await checkFacts(row, checkout);
    // A cancel that landed while git was read must not be overwritten by the verdict.
    if (stopRequested(ctl) === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    const step = currentStep(row);
    const move = moveAfter(row.steps, row.stepIndex);
    const next = move.kind === 'advance' ? row.steps[move.to] : undefined;
    opts.state.write((ctx) => {
      countFinished(ctx, step);
      if (move.kind === 'advance' && next) {
        transitionWorkstream(ctx, id, {
          to: S.Queued,
          fence: ctl.fence,
          patch: {
            nextAction: { kind: 'start' },
            steps: advanceSteps(row.steps, row.stepIndex, move.to, entryFor(ctx, id)),
            stepIndex: move.to,
            model: next.model,
            effort: next.effort,
          },
          reason: `no gate command; next: ${next.role}`,
        });
        clearLease(ctx, id);
        return;
      }
      if (row.steps.length > 0)
        patchWorkstream(ctx, id, ctl.fence, {
          steps: advanceSteps(row.steps, row.stepIndex, -1, entryFor(ctx, id)),
        });
      waitForBuilder(ctx, id, ctl.fence, row, facts);
    });
  }

  async function verify(id: WorkstreamId, ctl: Control): Promise<void> {
    if (getWorkstreamRow(db, id).state !== S.Verifying) {
      opts.state.write((ctx) =>
        transitionWorkstream(ctx, id, {
          to: S.Verifying,
          fence: ctl.fence,
          patch: { nextAction: { kind: 'verify' } },
        }),
      );
    }
    const row = getWorkstreamRow(db, id);
    const project = getProject(db, row.projectId);
    const checkout = checkoutOf(db, row);
    const uncommitted = await claimedChanges(row);
    // A cancel that landed while git was read must not be overwritten by a send-back.
    if (stopRequested(ctl) === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    if (uncommitted.length > 0) {
      sendBackUncommitted(id, ctl, row, uncommitted);
      return;
    }
    // A project with a pre-check (pull request delivery) has each step checked by it, and the ship
    // runs it in place of the gate. Otherwise a project with a changed-packages check has each step
    // checked by it, and the ship gate runs the full gate command before the push. Without a gate
    // command the builder checks, as ever.
    const gateCommand = stepCheck(project)?.command ?? null;
    if (gateCommand === null) {
      await finishWithoutGate(id, ctl, row, checkout);
      return;
    }
    const run = listEvidence(db, id).filter((e) => e.kind === 'gate').length + 1;
    const gateAbort = new AbortController();
    ctl.gateAbort = gateAbort;
    if (ctl.stopReason === 'cancelled' || ctl.stopReason === 'shutdown') gateAbort.abort();
    // A batch's branch takes its base as origin has it now, so the gate tests what would merge
    // rather than the base it was cut from. It runs once the gate holds its slot, so no other gate's
    // merge changes the tree under a running gate. Work outside a batch has no base to take.
    const before: { update: BaseUpdate | null } = { update: null };
    const batchId = row.batchId;
    let recording: Promise<void> = Promise.resolve();
    // Set once the gate holds its slot and starts; only a started gate records gate.finished.
    let gateStarted = false;
    // Set when the hold came on while the gate waited for its batch's turn or a slot.
    let heldAgain = false;
    // A function, so the check after the gate is not narrowed to the value it had before it.
    const wasHeldAgain = (): boolean => heldAgain;
    const clearToStart = (): boolean => {
      heldAgain = opts.hold?.holding() ?? false;
      return !heldAgain;
    };
    const logPath = join(opts.dataDir, 'logs', 'gate', `${id}-${String(run)}.log`);
    opts.logger.info({ workstreamId: id, command: gateCommand, logPath }, 'gate started');
    const request: GateRequest = {
      beforeStart: async () => {
        if (!clearToStart()) return false;
        if (batchId === null) return true;
        // A task's gate has a session to send when the base's conflicts need one.
        const update = await opts.baseUpdates.beforeGate(batchId, gateAbort.signal, {
          inSession: true,
        });
        before.update = update;
        // Markers left in the branch fail any gate; a session resolves them first.
        // A broken install fails any gate before it starts: its tools are not there.
        // A lost migration fails none of its tools, so it stops the gate here.
        if (
          update.kind === 'aborted' ||
          update.kind === 'conflicted' ||
          update.kind === 'install_broken' ||
          update.kind === 'uncarried'
        )
          return false;
        return clearToStart();
      },
      project: projectAtCheckout(project, checkout),
      command: gateCommand,
      logPath,
      timeoutMs: opts.limits.gateTimeoutMs,
      // The project env: the login shell without billing switches, and never the account's credentials.
      env: opts.launcher.projectEnv(),
      // The hosts and read paths the lane's own sandbox opens.
      rules: listPermissionRules(db, project.id, id),
      checkouts: allCheckouts(db),
      signal: gateAbort.signal,
      onWaiting: (ahead) => {
        opts.logger.info(
          { workstreamId: id, ahead },
          'verify gate is waiting for another gate to finish',
        );
      },
      onStarted: () => {
        gateStarted = true;
        opts.state.write((ctx) => {
          ctx.emit({
            type: EventType.GateStarted,
            entityType: 'workstream',
            entityId: id,
            data: { run },
          });
        });
      },
      onSpawn: (pid) => {
        recording = identify(pid).then((gatePidStart) => {
          if (gatePidStart !== null)
            opts.state.write((ctx) => {
              patchWorkstream(ctx, id, ctl.fence, { gatePid: pid, gatePidStart });
            });
        });
      },
    };
    let result: GateResult;
    do {
      heldAgain = false;
      // Before the batch's turn and a slot, and it comes back here if the hold returns before the
      // gate starts: a held gate keeps neither, since sibling gates, a running session's install or
      // migrations claim, and a ship all wait behind the turn, and an update waits for them.
      ctl.parked = opts.hold !== undefined;
      try {
        await opts.hold?.untilClear(gateAbort.signal);
      } finally {
        ctl.parked = false;
      }
      // One gate of a batch at a time: its gates share the batch's checkout.
      result =
        batchId === null
          ? await opts.gate.run(request)
          : ((await opts.baseUpdates.gate(batchId, gateAbort.signal, () =>
              opts.gate.run(request),
            )) ?? stoppedWaiting(logPath));
    } while (wasHeldAgain());
    // A check that failed only in tests is run once more, on just the failing files, before it counts
    // as a failure: a loaded Mac makes tests time out, and a fix session cannot repair that. A rerun
    // that passes lets the step go on with no attempt used; one that fails is the failure it was.
    let flaky: readonly FlakyTest[] = [];
    if (result.exitCode !== 0 && !result.timedOut && !result.aborted && !gateAbort.signal.aborted) {
      const outcome = await rerunFlaky({
        checkout,
        output: result.tail,
        run: async (command) => {
          await opts.hold?.untilClear(gateAbort.signal);
          const again: GateRequest = {
            ...request,
            command,
            logPath: join(opts.dataDir, 'logs', 'gate', `${id}-${String(run)}-rerun.log`),
            // The tree is the one the first run tested: no base update, no second gate-started event.
            beforeStart: () => Promise.resolve(!gateAbort.signal.aborted),
            onStarted: () => undefined,
          };
          opts.logger.info(
            { workstreamId: id, command },
            'check failed only in tests; rerunning them',
          );
          return batchId === null
            ? opts.gate.run(again)
            : opts.baseUpdates.gate(batchId, gateAbort.signal, () => opts.gate.run(again));
        },
      });
      if (outcome.kind === 'stopped') result = { ...result, aborted: true };
      else if (outcome.kind === 'flaky') {
        flaky = outcome.tests;
        result = outcome.rerun;
      }
    }
    ctl.gateAbort = null;
    opts.logger.info(
      {
        workstreamId: id,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
        timedOut: result.timedOut,
        aborted: result.aborted,
        base: before.update?.kind ?? null,
      },
      'gate finished',
    );
    await recording.catch(() => undefined);
    opts.state.write((ctx) => {
      patchWorkstream(ctx, id, ctl.fence, { gatePid: null, gatePidStart: null });
      if (gateStarted)
        ctx.emit({
          type: EventType.GateFinished,
          entityType: 'workstream',
          entityId: id,
          data: {
            run,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            aborted: result.aborted,
          },
        });
    });
    if (ctl.stopReason === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    // The base merge left conflict markers: no gate ran, and a session resolves them.
    if (before.update?.kind === 'conflicted' && ctl.stopReason !== 'shutdown') {
      sendToMerge(id, ctl, row, before.update);
      return;
    }
    // The copy's packages do not resolve what its lockfile names: no gate ran, and the task's code did
    // not fail. The task stops with a card that says the install is broken, and no attempt is counted
    // (a fix session could not repair it: 10db installs, and already did). With no trustworthy pnpm
    // no install ran and a Retry meets the same refusal, so that has its own kind for the failure line.
    if (before.update?.kind === 'install_broken' && ctl.stopReason !== 'shutdown') {
      fail(id, ctl.fence, {
        kind:
          before.update.noPnpm === true
            ? WorkstreamFailure.NoPnpm
            : WorkstreamFailure.InstallBroken,
        reason: before.update.note,
      });
      return;
    }
    // A merge of the base lost a migration and the merge stands: no gate ran, and this counts as one
    // that failed, so a fix session re-creates it, told how by the note and the batch's notice. With a
    // notice whose list can't be read there is nothing to re-create, and the note says that instead.
    if (before.update?.kind === 'uncarried' && ctl.stopReason !== 'shutdown')
      result = { ...result, exitCode: 1, aborted: false };
    // Shutdown killed the gate: record nothing. The workstream stays VERIFYING and recovery re-runs it.
    if (result.aborted) return;
    // A host the sandbox blocked is the builder's to allow; the card names it and the gate's evidence says so.
    if (result.blockedHosts.length > 0) await takeFoundHostsReading(opts, project.id);
    raiseGateHostCards(opts, {
      projectId: project.id,
      run: BlockedRun.Gate,
      command: gateCommand,
      hosts: result.blockedHosts,
    });
    const head = await opts.git.head(checkout);
    const commitShas = await opts.git.commitsSince(checkout, row.baseHead ?? head);
    // A cancel that landed while git was read must not be overwritten by the verdict.
    if (stopRequested(ctl) === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    const output = gateSummary(
      before.update === null ? null : gateNote(before.update),
      result.tail,
    );
    const evidence = {
      workstreamId: id,
      kind: 'gate' as const,
      command: gateCommand,
      exitCode: result.exitCode,
      // The step's record names every test that failed once and passed on rerun, so the note on them
      // stays outside what a gate summary caps.
      summary: flaky.length > 0 ? `${flakeNote(flaky)}\n\n${output}` : output,
      logPath: result.logPath,
      commitShas,
    };
    if (flaky.length > 0)
      opts.state.write((ctx) => {
        fileFlakyTests(ctx, row.taskId, flaky);
      });
    if (result.exitCode === 0) {
      const step = currentStep(row);
      const move = moveAfter(row.steps, row.stepIndex);
      const planned = move.kind === 'advance' ? row.steps[move.to] : undefined;
      // A review the judge skips leaves the plan, as a QA step of docs alone does. A cancel or a
      // shutdown cuts the call short through the same handle that stops a gate.
      let skipped: string | null = null;
      if (move.kind === 'advance' && planned?.role === StepRole.Review) {
        const judgeAbort = new AbortController();
        ctl.gateAbort = judgeAbort;
        const already = stopRequested(ctl);
        if (already === 'cancelled' || already === 'shutdown') judgeAbort.abort();
        try {
          skipped = await reviewSkippedByJudge(id, row, planned, checkout, judgeAbort.signal);
        } finally {
          ctl.gateAbort = null;
        }
      }
      // With the review gone, the step that follows it is QA, which a change of Markdown alone skips.
      const afterReview =
        skipped !== null && move.kind === 'advance' ? row.steps[move.to + 1] : undefined;
      const skipsQa =
        afterReview?.role === StepRole.Qa && (await changesOnlyMarkdown(row, checkout));
      // The judge's call took time; a cancel that landed meanwhile must not be overwritten.
      if (stopRequested(ctl) === 'cancelled') {
        cancelNow(id, ctl.fence);
        return;
      }
      // Shutdown cut the call short: record nothing, and recovery runs the gate again.
      if (stopRequested(ctl) === 'shutdown') return;
      const dropped = new Set<number>();
      if (skipped !== null && move.kind === 'advance') {
        dropped.add(move.to);
        if (skipsQa) {
          dropped.add(move.to + 1);
          opts.logger.info({ workstreamId: id }, 'skipping the QA step: only docs changed');
        }
      }
      const steps = row.steps.filter((_, i) => !dropped.has(i));
      const next = move.kind === 'advance' ? steps[move.to] : undefined;
      if (move.kind === 'advance' && next) {
        opts.state.write((ctx) => {
          insertEvidence(ctx, evidence);
          countFinished(ctx, step);
          transitionWorkstream(ctx, id, {
            to: S.Queued,
            fence: ctl.fence,
            patch: {
              nextAction: { kind: 'start' },
              steps: advanceSteps(steps, row.stepIndex, move.to, entryFor(ctx, id)),
              stepIndex: move.to,
              model: next.model,
              effort: next.effort,
            },
            reason:
              skipped === null
                ? `gate passed; next: ${next.role}`
                : `gate passed; ${skipped}; next: ${next.role}`,
          });
          clearLease(ctx, id);
        });
        return;
      }
      opts.state.write((ctx) => {
        insertEvidence(ctx, evidence);
        countFinished(ctx, step);
        if (steps.length > 0)
          patchWorkstream(ctx, id, ctl.fence, {
            steps: advanceSteps(steps, row.stepIndex, -1, entryFor(ctx, id)),
          });
        markDone(
          ctx,
          id,
          ctl.fence,
          row,
          skipped === null ? 'gate passed' : `gate passed; ${skipped}`,
        );
      });
      return;
    }
    const attempt = row.attempt + 1;
    const evidenceId = opts.state.write((ctx) => insertEvidence(ctx, evidence).id);
    if (attempt > opts.limits.maxFixAttempts) {
      fail(id, ctl.fence, {
        kind: WorkstreamFailure.GateFailed,
        reason: `The gate failed ${String(attempt)} times (last exit ${String(result.exitCode)})`,
      });
      return;
    }
    const failedStep = currentStep(row);
    const up =
      row.steps.length > 0 ? escalated(row, failedStep, 'the gate failed', ctl.accountId) : null;
    opts.state.write((ctx) => {
      if (up?.moved && failedStep.profileId)
        recordProfileOutcome(ctx, failedStep.profileId, { firstPass: false, escalated: true });
      transitionWorkstream(ctx, id, {
        to: S.Queued,
        fence: ctl.fence,
        patch: {
          nextAction: { kind: 'fix', evidenceId },
          attempt,
          ...(up
            ? {
                steps: row.steps.map((s, i) =>
                  i === row.stepIndex ? { ...up.step, attempts: s.attempts + 1 } : s,
                ),
                model: up.step.model,
                effort: up.step.effort,
              }
            : {}),
        },
        reason: `gate exit ${String(result.exitCode)}`,
      });
      clearLease(ctx, id);
    });
  }

  /**
   * A lane's first launch brings its batch's copy up to the base as it is now, so the lane sees what
   * merged while its task waited in the queue (a copy cut at an older base would send it to redo
   * work that is already there). A copy with no work of its own is fast-forwarded and one with
   * commits takes the base by 10db's base merge. A lane that already ran a session keeps its copy:
   * its changes are in it. What kept the base out is a notice on the batch, never a stop to the lane.
   * Stopped like a gate is.
   */
  async function baseFirst(id: WorkstreamId, ctl: Control): Promise<void> {
    const row = getWorkstreamRow(db, id);
    if (row.batchId === null || row.baseHead !== null) return;
    if (row.nextAction.kind === 'verify' || row.state === S.Verifying) return;
    const abort = new AbortController();
    ctl.gateAbort = abort;
    if (ctl.stopReason === 'cancelled' || ctl.stopReason === 'shutdown') abort.abort();
    try {
      await opts.baseUpdates.atLaunch(row.batchId, abort.signal);
    } catch (error) {
      opts.logger.warn(
        { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
        'base not brought into the copy at launch',
      );
    } finally {
      ctl.gateAbort = null;
    }
  }

  /**
   * A run that holds the migrations hazard from its start (the task names it among its areas) takes
   * its base first, as request_claim does, so a migration it generates is numbered after the base's
   * latest. A branch that can't take its base gives the hazard back: the session runs without it, and
   * asking for it again says why. Stopped like a gate is.
   */
  async function migrationsBaseFirst(id: WorkstreamId, ctl: Control): Promise<void> {
    if (!opts.migrationsBase) return;
    const row = getWorkstreamRow(db, id);
    if (row.nextAction.kind === 'verify' || row.state === S.Verifying) return;
    const claim = activeClaims(db, id).find(
      (c) => c.kind === ClaimKind.Hazard && c.name === MIGRATIONS_HAZARD,
    );
    if (!claim) return;
    const abort = new AbortController();
    ctl.gateAbort = abort;
    if (ctl.stopReason === 'cancelled' || ctl.stopReason === 'shutdown') abort.abort();
    try {
      const taken = await opts.migrationsBase.take(id, abort.signal);
      if (taken.kind !== 'held') return;
      opts.state.write((ctx) => releaseClaim(ctx, claim.id));
      opts.logger.info(
        { workstreamId: id },
        "migrations hazard held back: the branch can't take its base",
      );
    } finally {
      ctl.gateAbort = null;
    }
  }

  async function run(id: WorkstreamId, ctl: Control): Promise<void> {
    try {
      const pass = passOfWorkstream(db, id);
      if (pass) {
        // A turn that ended and was not carried through (its work not kept, a restart between) is
        // finished first, and nothing is resumed (Workbench spec §12).
        const latest = latestPassTurn(db, getWorkstreamRow(db, id).taskId);
        if (latest && latest.endedAt !== null && latest.settledAt === null) {
          const providerSessionId = lastProviderSession(id);
          await finishEndedTurn(passWork, latest, {
            fence: ctl.fence,
            providerSessionId,
            reason: 'The turn ended while 10db was stopping, and its session is gone',
          });
          opts.state.write((ctx) => {
            queueUntaken(ctx, id, ctl.fence, providerSessionId);
            clearLease(ctx, id);
          });
          return;
        }
      } else {
        // A pass's branch takes no base and runs no migrations step: its work lands at its close.
        await baseFirst(id, ctl);
        await migrationsBaseFirst(id, ctl);
      }
      for (;;) {
        const row = getWorkstreamRow(db, id);
        const verifying = row.nextAction.kind === 'verify' || row.state === S.Verifying;
        // A pause only stops sessions; verification doesn't use the provider, so it carries on.
        if (ctl.stopReason && !(ctl.stopReason === 'paused' && verifying)) {
          await settleLane(id, ctl, {
            kind: 'stopped',
            reason: ctl.stopReason,
            providerSessionId: null,
          });
          return;
        }
        if (verifying) {
          await verify(id, ctl);
          return;
        }
        const lane = getProject(db, getWorkstreamRow(db, id).projectId);
        // A running session finished on the account it started on; the next one runs where the project is now.
        ctl.accountId = lane.accountId;
        // The scheduler checked before the launch; a lane checks again before each further session (accounts spec §6).
        const block = opts.accounts.blocked(getAccountRow(db, ctl.accountId), lane.id);
        if (block) {
          settle(id, ctl, {
            kind: 'held',
            until: block.until,
            refusal: null,
            providerSessionId: null,
          });
          return;
        }
        const outcome = await runSession(id, ctl);
        // A move starts no session, and a refused model is retried at once: neither ends the run.
        if (
          outcome.kind !== 'handoff' &&
          outcome.kind !== 'moved' &&
          outcome.kind !== 'model_refused'
        )
          ctl.unaskedHandoffs = null;
        if (outcome.kind === 'handoff' || outcome.kind === 'moved') continue;
        if (outcome.kind === 'model_refused') {
          if (refuseModel(id, ctl, outcome) === 'retry') continue;
          if (pass) await failTurn(id, ctl, outcome.message, null);
          return;
        }
        if (outcome.kind === 'step_done') {
          const finished = getWorkstreamRow(db, id);
          const readOnly = currentStep(finished).role !== StepRole.Implement;
          // A read-only step has no changes to make. One it leaves in its claims is flagged, and it still finishes.
          const changed = readOnly ? await claimedChanges(finished) : [];
          if (stopRequested(ctl) === 'cancelled') {
            settle(id, ctl, { kind: 'stopped', reason: 'cancelled', providerSessionId: null });
            return;
          }
          if (changed.length > 0) {
            opts.inbox.flag({
              projectId: finished.projectId,
              workstreamId: id,
              title: `The ${currentStep(finished).role} step left changes in its claims`,
              body: changed.join('\n'),
            });
          }
          if (readOnly) {
            if (
              (await finishReadOnlyStep(id, ctl, finished, outcome.ending, outcome.wrote)) ===
              'next'
            )
              continue;
            return;
          }
          if (outcome.withoutHandoff) {
            const row = finished;
            opts.inbox.flag({
              projectId: row.projectId,
              workstreamId: id,
              title: 'Session ended without the requested handoff',
              body: 'The agent ended its turn twice after being asked for a handoff; 10db is verifying the work as it stands.',
            });
          }
          opts.state.write((ctx) =>
            transitionWorkstream(ctx, id, {
              to: S.Verifying,
              fence: ctl.fence,
              patch: { nextAction: { kind: 'verify' } },
              reason: outcome.withoutHandoff
                ? 'turn ended without the requested handoff'
                : outcome.unaskedRun !== null
                  ? `step complete after ${String(outcome.unaskedRun)} handoffs in a row that nobody asked for`
                  : 'step complete',
            }),
          );
          continue;
        }
        await settleLane(id, ctl, outcome);
        return;
      }
    } catch (error) {
      if (error instanceof StaleFenceError) {
        opts.logger.warn({ workstreamId: id }, 'runner fenced off by a newer lease; stopping');
        await ctl.handle?.stop();
        return;
      }
      opts.logger.error(
        { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
        'runner failed',
      );
      try {
        await settleLane(id, ctl, {
          kind: 'crashed',
          message: error instanceof Error ? error.message : String(error),
          providerSessionId: null,
        });
      } catch (inner) {
        opts.logger.error(
          { workstreamId: id, err: String(inner) },
          'could not record the runner failure',
        );
      }
    }
  }

  const runner: Runner = {
    launch(id, fence) {
      if (active.has(id)) return;
      const workstream = getWorkstreamRow(db, id);
      const ctl: Control = {
        fence,
        projectId: workstream.projectId,
        accountId: getProject(db, workstream.projectId).accountId,
        stopReason: null,
        handle: null,
        requestHandoff: null,
        gateAbort: null,
        holdAbort: null,
        parked: false,
        endWaits: null,
        unaskedHandoffs: null,
        messages: null,
        builderStop: false,
        idleTimer: null,
        done: Promise.resolve(),
      };
      active.set(id, ctl);
      ctl.done = run(id, ctl).finally(() => {
        active.delete(id);
        opts.onLaneFreed();
        if (active.size === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const w of waiters) w();
        }
      });
    },
    async stop(id, reason) {
      const ctl = active.get(id);
      if (!ctl) return;
      ctl.stopReason = reason;
      // A pause only stops sessions; a running gate doesn't use the provider, so let it finish.
      if (reason !== 'paused') ctl.gateAbort?.abort();
      ctl.holdAbort?.abort();
      // Waits end before the process does, so an answer during a slow exit reaches the card.
      ctl.endWaits?.();
      await ctl.handle?.stop();
      await ctl.done;
    },
    async cancel(id) {
      if (active.has(id)) await runner.stop(id, 'cancelled');
      else cancelNow(id, null);
    },
    async stopAccount(accountId, reason) {
      const matching = [...active.entries()].filter(([, c]) => c.accountId === accountId);
      await Promise.all(matching.map(([id]) => runner.stop(id, reason)));
    },
    async stopAll(reason) {
      await Promise.all([...active.keys()].map((id) => runner.stop(id, reason)));
    },
    isRunning: (id) => active.has(id),
    isParked: (id) => active.get(id)?.parked === true,
    handOff(projectId, accountId, reason) {
      for (const c of active.values())
        if (c.projectId === projectId && c.accountId === accountId)
          c.requestHandoff?.('account', reason);
    },
    idle: () => (active.size === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    deliverParkedAnswer(target, item) {
      const row = getWorkstreamRow(db, target.workstreamId);
      if (row.state !== S.WaitingHuman || row.currentSessionId !== null) return;
      // The workstream waits for the builder's check, not for this card; only the check card's own
      // answer moves it. A Ready pass page waits for the builder's next message.
      if (row.nextAction.kind === 'builder_review' || row.nextAction.kind === 'pass_review') return;
      const providerSessionId =
        row.nextAction.kind === 'answer' ? row.nextAction.providerSessionId : null;
      opts.state.write((ctx) =>
        transitionWorkstream(ctx, row.id, {
          to: S.Queued,
          fence: null,
          patch: { nextAction: { kind: 'answer', inboxId: item.id, providerSessionId } },
          reason: 'answer arrived',
        }),
      );
      opts.onLaneFreed();
    },
    async deliverMessage(taskId, messageId, { redo }) {
      const id = getTask(db, taskId).workstreamId;
      if (id === null) throw new ConflictError(`Task ${taskId} has no run to hand the message to`);
      /** A page its pass no longer holds takes no message, whatever was kept for it. */
      const stillAPage = (): void => {
        if (!passOfWorkstream(db, id))
          throw new ConflictError(`${getTask(db, taskId).title} is no longer in a Workbench pass`);
      };
      stillAPage();
      const ctl = active.get(id);
      const lane = ctl?.messages ?? null;
      if (ctl && lane && ctl.stopReason === null) {
        disarmIdleClose(ctl);
        // A turn starts only while Your folder is on the pass's branch: off it, the page's warm
        // session closes and the message waits untaken, queued with the pass's folder card, so the
        // page goes on by itself once the folder is back (Workbench spec §5.1, §12).
        const pass = passOfWorkstream(db, id);
        // A folder that cannot be read is left to the turn's own keep, which refuses off the branch.
        const folderOn = (passId: PassId): Promise<boolean> =>
          passFolderOn(passWork, passId).catch((error: unknown) => {
            opts.logger.warn(
              { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
              "Your folder's branch could not be read; the message goes on",
            );
            return true;
          });
        if (pass && !openPassTurn(db, taskId) && !(await folderOn(pass.id))) {
          // A stop that landed while the branch was read closes the session already.
          if (stopRequested(ctl) === null) {
            ctl.stopReason = 'closed';
            opts.logger.info(
              { workstreamId: id },
              'warm session closed: Your folder is off the pass',
            );
            await ctl.handle?.stop();
          }
          await ctl.done;
          return;
        }
        // Stop and Redo: the interrupted turn goes on with the message. Its end is not Ready, as
        // no turn's is while the message waits untaken.
        if (redo && openPassTurn(db, taskId)) await lane.interrupt();
        const note = await foldForTurn(id);
        stillAPage();
        // A stop that landed meanwhile (the builder's, a take-out's, an idle close) ends this
        // session: the message stays untaken for the next one.
        if (ctl.messages === lane && stopRequested(ctl) === null) {
          opts.state.write((ctx) => {
            // A Ready page's new turn resumes this session with the message if it ends untaken.
            if (getWorkstreamRow(ctx.tx, id).nextAction.kind === 'pass_review')
              patchWorkstream(ctx, id, ctl.fence, {
                nextAction: {
                  kind: 'feedback',
                  messageId,
                  providerSessionId: lastProviderSession(id),
                },
              });
            startTurn(ctx, {
              workstreamId: id,
              sessionId: getWorkstreamRow(ctx.tx, id).currentSessionId,
              messageId,
              fence: ctl.fence,
            });
          });
          // Every message no turn took goes with it, so none is left behind for the lane to wait on.
          lane.pushUntaken(note);
          return;
        }
      }
      // A lane starting its session hands it every message no turn has taken once it is there.
      if (active.has(id)) return;
      // A page with no session starts its next turn from the oldest message no turn took.
      opts.state.write((ctx) => queueUntaken(ctx, id, null, lastProviderSession(id)));
      opts.onLaneFreed();
    },
    async closeWarm(id) {
      const ctl = active.get(id);
      if (!ctl?.handle || ctl.stopReason !== null) return;
      const closes = opts.state.write((ctx) => {
        const row = getWorkstreamRow(ctx.tx, id);
        const still =
          row.state === S.WaitingHuman &&
          row.nextAction.kind === 'pass_review' &&
          untakenMessages(ctx.tx, row.taskId).length === 0 &&
          !openPassTurn(ctx.tx, row.taskId);
        if (still) ctl.stopReason = 'closed';
        return still;
      });
      if (!closes) return;
      opts.logger.info({ workstreamId: id }, 'warm session closed');
      await ctl.handle.stop();
      await ctl.done;
    },
    async stopPassLane(id) {
      const ctl = active.get(id);
      if (!ctl) {
        if (openPassTurn(db, getWorkstreamRow(db, id).taskId))
          await stopTurn(id, null, lastProviderSession(id));
        return;
      }
      ctl.builderStop = true;
      ctl.stopReason = 'closed';
      ctl.holdAbort?.abort();
      ctl.endWaits?.();
      await ctl.handle?.stop();
      await ctl.done;
    },
    retryTurn(item, answer) {
      const turnId = PassTurnId.safeParse(item.detail?.[PASS_TURN_DETAIL]);
      const target = item.targets[0];
      // Another flag is another handler's.
      if (!turnId.success || !target) return;
      // A failed turn's flag is answered by Retry Turn alone; any other answer leaves it open.
      if (answer.choice !== PASS_RETRY_TURN_CHOICE)
        throw new InvalidError(`A failed turn is answered with ${PASS_RETRY_TURN_CHOICE}`);
      const id = target.workstreamId;
      const providerSessionId = lastProviderSession(id);
      opts.state.write((ctx) => {
        const pass = passOfWorkstream(ctx.tx, id);
        if (!pass)
          throw new ConflictError(
            'The task is no longer in a Workbench pass, so its turn is not retried',
          );
        // A turn opened now would leave with the task, and run in its next pass unasked.
        if (pass.state !== PassState.Open)
          throw new ConflictError(
            `Workbench pass "${pass.name}" is ${pass.state.toLowerCase()}; its turns are not retried`,
          );
        const row = getWorkstreamRow(ctx.tx, id);
        const takeOut = lastTakeOut(ctx.tx, row.taskId);
        if (takeOut?.passId === pass.id && takeOut.step < TakeOutStep.Done)
          throw new ConflictError(
            'The page is being taken out of its pass, so its turn is not retried',
          );
        if (
          row.state !== S.WaitingHuman ||
          row.nextAction.kind !== 'pass_review' ||
          row.nextAction.inboxId !== item.id
        )
          throw new ConflictError('The page is no longer waiting on this failed turn');
        const failed = getPassTurn(ctx.tx, turnId.data);
        insertPassTurn(ctx, {
          taskId: row.taskId,
          workstreamId: id,
          sessionId: null,
          messageId: failed.messageId,
        });
        // The message goes to the session the turn failed in when it can be resumed, else to a
        // fresh one that starts from the thread's digest.
        transitionWorkstream(ctx, id, {
          to: S.Queued,
          fence: null,
          patch: {
            nextAction:
              failed.messageId === null
                ? providerSessionId === null
                  ? { kind: 'start' }
                  : { kind: 'resume', providerSessionId, reason: 'the builder retried the turn' }
                : { kind: 'feedback', messageId: failed.messageId, providerSessionId },
            failureKind: null,
            failureReason: null,
          },
          reason: 'the builder retried the turn',
        });
      });
      opts.onLaneFreed();
    },
    approveCheck(ctx, id) {
      const row = getWorkstreamRow(ctx.tx, id);
      if (!waitsForCheck(row))
        throw new ConflictError(`Workstream ${id} is not waiting for the builder's check`);
      // The builder just reviewed the work, so there is no review card to raise. No session, no gate.
      transitionWorkstream(ctx, id, {
        to: S.Verifying,
        fence: null,
        reason: 'the builder approved the work',
      });
      markDone(ctx, id, null, row, 'the builder approved the work');
      return () => {
        opts.onLaneFreed();
      };
    },
    sendBack(ctx, id, note) {
      const row = getWorkstreamRow(ctx.tx, id);
      if (!waitsForCheck(row))
        throw new ConflictError(`Workstream ${id} is not waiting for the builder's check`);
      const attempt = row.attempt + 1;
      const evidence = insertEvidence(ctx, {
        workstreamId: id,
        kind: 'builder',
        command: null,
        exitCode: null,
        summary: note,
        logPath: null,
        commitShas: checkedCommits(ctx.tx, id),
      });
      // The step that did the work fixes it, as when a reviewer rejects: the check is raised from the
      // last step, which may be a read-only review.
      const targetIndex = row.steps.length > 0 ? sendBackTarget(row.steps, row.stepIndex) : null;
      if (attempt > opts.limits.maxFixAttempts) {
        const reason = `The builder sent the work back ${String(attempt)} times, and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up. The last note: ${note}`;
        // The failure sits on the step the work was sent back to, so a retry restarts it with the note
        // on that step's own model and effort.
        const failedTarget = targetIndex === null ? undefined : row.steps[targetIndex];
        failIn(
          ctx,
          id,
          null,
          row,
          { kind: WorkstreamFailure.RetryLimit, reason },
          {
            nextAction: { kind: 'fix', evidenceId: evidence.id },
            ...(targetIndex === null || !failedTarget
              ? {}
              : {
                  stepIndex: targetIndex,
                  model: failedTarget.model,
                  effort: failedTarget.effort,
                  steps: row.steps.map((s, i) =>
                    i === targetIndex
                      ? { ...s, status: StepStatus.Failed }
                      : i === row.stepIndex
                        ? { ...s, status: StepStatus.Pending }
                        : s,
                  ),
                }),
          },
        );
        return () => {
          flagFailed(row, reason);
          opts.onLaneFreed();
        };
      }
      const target = targetIndex === null ? undefined : row.steps[targetIndex];
      const up = target
        ? escalated(
            row,
            target,
            'the builder sent the work back',
            getProject(db, row.projectId).accountId,
          )
        : null;
      if (up?.moved && target?.profileId)
        recordProfileOutcome(ctx, target.profileId, { firstPass: false, escalated: true });
      transitionWorkstream(ctx, id, {
        to: S.Queued,
        fence: null,
        patch: {
          nextAction: { kind: 'fix', evidenceId: evidence.id },
          attempt,
          ...(up && target && targetIndex !== null
            ? {
                steps: sendBackSteps(
                  row.steps,
                  row.stepIndex,
                  targetIndex,
                  up.step,
                  entryFor(ctx, id),
                ),
                stepIndex: targetIndex,
                model: up.step.model,
                effort: up.step.effort,
              }
            : {}),
        },
        reason: 'the builder sent the work back',
      });
      if (target && targetIndex !== null)
        ctx.emit({
          type: EventType.StepChanged,
          entityType: 'workstream',
          entityId: id,
          data: { stepIndex: targetIndex, role: target.role, sentBackBy: 'builder' },
        });
      clearLease(ctx, id);
      return () => {
        opts.onLaneFreed();
      };
    },
  };
  return runner;
}
