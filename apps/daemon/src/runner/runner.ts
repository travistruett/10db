import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ClaimKind,
  ConflictError,
  currentStep,
  EventType,
  FIX_ATTEMPT_LIMIT,
  InboxKind,
  parseFindings,
  PermissionChoice,
  REVIEW_CARD_DETAIL,
  REVIEW_ROLES,
  StepRole,
  StepStatus,
  ToolAccess,
  WorkstreamState as S,
  AccountKind,
  AccountProblem,
  type AccountId,
  type AccountRefusal,
  type HandoffId,
  type InboxItemDto,
  type InboxItemId,
  type InboxTarget,
  type NextAction,
  type ProjectDto,
  type ProjectId,
  type ReviewCardDetail,
  type SessionId,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  activeClaims,
  clearLease,
  endSession,
  getAccount,
  getAccountRow,
  getEvidence,
  getInboxItem,
  getMcpApproval,
  getPersona,
  getProject,
  getSessionByProviderId,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  handoffForSession,
  insertDeviation,
  insertEvidence,
  insertSession,
  insertSource,
  latestHandoffForStep,
  latestToolOp,
  listModelProfiles,
  listPermissionRules,
  listSessions,
  listEvidence,
  markSessionStarted,
  openItemsForWorkstream,
  patchWorkstream,
  recordProfileOutcome,
  releaseClaim,
  releaseClaims,
  setTaskStatus,
  StaleFenceError,
  type DbReader,
  transitionWorkstream,
  updateSessionUsage,
  type WorkstreamRow,
  type WriteContext,
} from '@10db/db';
import {
  briefedFromHandoff,
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  HANDOFF_FIRM_NUDGE,
  HANDOFF_FIRM_NUDGE_ACCOUNT,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_ACCOUNT,
  HANDOFF_NUDGE_ACCOUNT_READ_ONLY,
  HANDOFF_NUDGE_READ_ONLY,
  RESULT_NUDGE,
} from '../briefing';
import {
  unready,
  type AccountLimits,
  type AccountPreparer,
  type AccountRuntime,
  type StartGate,
} from '../accounts';
import type { Clock, Timer } from '../clock';
import {
  allCheckouts,
  batchCardFields,
  checkoutOf,
  gateNote,
  MIGRATIONS_HAZARD,
  projectAtCheckout,
  type BaseUpdate,
  type BaseUpdates,
  type MigrationsBase,
} from '../delivery';
import type { StateStore } from '../events';
import {
  AccountLaunchError,
  KeychainError,
  type Launcher,
  type SessionLaunch,
} from '../environment';
import type { Git } from '../git';
import { judgeToolUse, type ProtectedPath } from '../guard';
import {
  createPermissionBroker,
  raiseGateHostCards,
  requestMcpApproval,
  type InboxService,
  type WaitObserver,
} from '../inbox';
import type { Logger } from '../log';
import { mintSessionToken } from '../mcp';
import { allowedToolsFor, storableRule } from '../permissions';
import { escalateStep, offeredProfiles } from '../routing';
import {
  fileAccessJudge,
  SandboxProfileError,
  SandboxTempDirError,
  type LaneSandbox,
  type LaneSession,
} from '../sandbox';
import {
  ProjectMcpError,
  readRepoMcp,
  resolveProjectMcp,
  SessionEndReason,
  skippedServersNote,
  splitProjectMcp,
  type ProjectMcp,
  type RepoMcp,
  type SessionAdapter,
  type SessionHandle,
  type TurnResult,
} from '../sessions';
import {
  advanceSteps,
  countSendBack,
  failStep,
  moveAfter,
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
import { findClaimed } from '../watcher';
import type { LiveSessions } from './live-sessions';
import { checkedCommits, raiseBuilderCheck, waitsForCheck } from './builder-check';
import { outstandingFixEvidence } from './fix-evidence';
import { nextActionAfterCrash, nextActionOnAnotherAccount } from './next-action';

/**
 * A continuation session starts with the briefing already in context. If that baseline is near or over
 * `handoffPct`, it may hand off only after growing this many points past its first reading. A session
 * that resumes such a conversation keeps the same line.
 */
const HANDOFF_BASELINE_MARGIN_PCT = 5;

export type StopReason = 'cancelled' | 'paused' | 'shutdown';

export interface RunnerLimits {
  readonly maxRecoveryAttempts: number;
  readonly maxFixAttempts: number;
  readonly gateTimeoutMs: number;
  /** Gates running at once across the whole daemon. */
  readonly gateSlots: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  maxRecoveryAttempts: 3,
  maxFixAttempts: FIX_ATTEMPT_LIMIT,
  gateTimeoutMs: 30 * 60_000,
  // One at a time: a gate runs a whole test suite, and several at once overload the machine.
  gateSlots: 1,
};

export interface RunnerOptions {
  /** Paths no session tool or command may touch. */
  readonly protectedPaths: readonly ProtectedPath[];
  readonly state: StateStore;
  readonly adapter: SessionAdapter;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly gate: GateRunner;
  /** Brings a batch's base as origin has it now into its branch before each of its gates. */
  readonly baseUpdates: BaseUpdates;
  /**
   * Brings a task's base into its branch before a run that holds the migrations hazard from its
   * start; absent, it isn't.
   */
  readonly migrationsBase?: MigrationsBase;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly live: LiveSessions;
  readonly limits: RunnerLimits;
  mcpUrl(): string;
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
   * While the Mac is overloaded no session starts: each one waits here, before anything is built or
   * launched, and a stop or cancel ends the wait.
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
}

type Outcome =
  | { readonly kind: 'handoff'; readonly handoffId: HandoffId }
  | {
      /** The project moved while the lane waited for its start slot. */
      readonly kind: 'moved';
    }
  | {
      readonly kind: 'step_done';
      readonly withoutHandoff: boolean;
      /** How the session ended, in a plain clause: what a step that records no result is failed with. */
      readonly ending: string;
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
      readonly kind: 'stopped';
      readonly reason: StopReason;
      readonly providerSessionId: string | null;
    };

type Terminal = Exclude<Outcome, { kind: 'handoff' } | { kind: 'moved' } | { kind: 'step_done' }>;

const PERMISSION_ANSWER_TEXT: Readonly<Record<string, string>> = {
  [PermissionChoice.AllowOnce]:
    'allowed once. Retry the call now; 10db lets this exact call through once.',
  [PermissionChoice.AllowWorkstream]: 'allowed for the rest of this workstream. Retry the call.',
  [PermissionChoice.AllowProject]: 'always allowed in this project. Retry the call.',
  [PermissionChoice.Deny]: 'denied. Do not retry it; find another way or ask with ask_human.',
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
  allowOnce: { toolName: string; summary: string } | null;
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
      ? { toolName, summary }
      : null,
  };
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
  /** Set while a session runs; ends its inbox waits so later answers go to the card. */
  endWaits: (() => void) | null;
  done: Promise<void>;
}

/** Per-session mutable state, kept in one object so callbacks and the event loop share it. */
interface SessionState {
  providerSessionId: string | null;
  handoffRequested: boolean;
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
  /** The share of its context window the session last reported using. */
  contextPct: number | null;
  parkedFor: InboxItemId | null;
  /**
   * The cards the session is waiting on, oldest first, with how many waits each has: a folded card can
   * be asked twice. A card leaves the map when its last wait ends.
   */
  waitingOn: Map<InboxItemId, number>;
  waitTimer: Timer | null;
  /** Set by the `started` event; a session that never started has no conversation to resume. */
  started: boolean;
  outcome: Outcome | null;
}

/**
 * How a session ended, as one plain clause: its last turn (normal, at the turn limit, or an error) and
 * the share of its context it had used. A session that gave no verdict is failed with this, so the card
 * says whether a retry can help.
 */
function describeEnding(st: Pick<SessionState, 'lastTurn' | 'contextPct'>): string {
  const how =
    st.lastTurn === null
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
  const active = new Map<WorkstreamId, Control>();
  let idleWaiters: (() => void)[] = [];
  const identify = (pid: number | null): Promise<string | null> =>
    pid === null || !opts.identifyProcess ? Promise.resolve(null) : opts.identifyProcess(pid);

  function freshAction(reader: DbReader, id: WorkstreamId): NextAction {
    const latest = latestHandoffForStep(reader, getWorkstreamRow(reader, id));
    return latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' };
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
    const resumeId =
      action.kind === 'resume' || action.kind === 'answer' ? action.providerSessionId : null;
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
    reason: string,
    patch: {
      readonly nextAction?: NextAction;
      readonly stepIndex?: number;
      readonly steps?: WorkstreamStep[];
    } = {},
  ): void {
    // A workstream waiting for the builder reaches FAILED through VERIFYING, as it reaches DONE.
    if (row.state === S.WaitingHuman)
      transitionWorkstream(ctx, id, { to: S.Verifying, fence, reason });
    transitionWorkstream(ctx, id, {
      to: S.Failed,
      fence,
      patch: {
        failureReason: reason,
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
      title: `Workstream failed: ${getTask(db, row.taskId).title}`,
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
    reason: string,
    review?: ReviewCardDetail,
  ): void {
    const row = getWorkstreamRow(db, id);
    opts.state.write((ctx) => {
      failIn(ctx, id, fence, row, reason);
    });
    flagFailed(row, reason, review);
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
  ): { step: WorkstreamStep; moved: boolean } {
    const project = getProject(db, row.projectId);
    const result = escalateStep(step, {
      provider: project.provider,
      budgetCeiling: project.budgetCeiling,
      profiles: offeredProfiles(
        listModelProfiles(db),
        getAccount(db, project.accountId).settings.aliases,
      ),
      why,
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

  /** After a read-only step's session: the next step in this lane, DONE, a rework, or a failure. */
  async function finishReadOnlyStep(
    id: WorkstreamId,
    ctl: Control,
    row: WorkstreamRow,
    ending: string,
  ): Promise<'next' | 'stop'> {
    const step = currentStep(row);
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
        fail(id, ctl.fence, `The ${step.role} step ended without calling complete_step: ${ending}`);
        return 'stop';
      }
      case 'done': {
        if (getProject(db, row.projectId).gateCommand === null) {
          // Nothing checked a read-only approval either: the builder checks what the steps produced.
          const facts = await checkFacts(row, checkoutOf(db, row));
          if (stopRequested(ctl) === 'cancelled') {
            cancelNow(id, ctl.fence);
            return 'stop';
          }
          opts.state.write((ctx) => {
            countFinished(ctx, step);
            patchWorkstream(ctx, id, ctl.fence, {
              steps: advanceSteps(row.steps, row.stepIndex, -1, entryFor(ctx, id)),
            });
            waitForBuilder(ctx, id, ctl.fence, row, facts);
          });
          return 'stop';
        }
        opts.state.write((ctx) => {
          countFinished(ctx, step);
          patchWorkstream(ctx, id, ctl.fence, {
            steps: advanceSteps(row.steps, row.stepIndex, -1, entryFor(ctx, id)),
          });
          // The workflow has no RUNNING -> DONE edge; a read-only step changed no code, so no second gate.
          transitionWorkstream(ctx, id, {
            to: S.Verifying,
            fence: ctl.fence,
            reason: 'steps complete',
          });
          markDone(ctx, id, ctl.fence, row, `${step.role} approved`);
        });
        return 'stop';
      }
      case 'advance': {
        const next = row.steps[move.to];
        if (!next) return 'stop';
        opts.state.write((ctx) => {
          countFinished(ctx, step);
          patchWorkstream(ctx, id, ctl.fence, {
            steps: advanceSteps(row.steps, row.stepIndex, move.to, entryFor(ctx, id)),
            stepIndex: move.to,
            nextAction: { kind: 'start' },
            model: next.model,
            effort: next.effort,
          });
          ctx.emit({
            type: EventType.StepChanged,
            entityType: 'workstream',
            entityId: id,
            data: { stepIndex: move.to, role: next.role },
          });
        });
        return 'next';
      }
      case 'send_back': {
        const attempt = row.attempt + 1;
        if (attempt > opts.limits.maxFixAttempts) {
          const result = step.result;
          fail(
            id,
            ctl.fence,
            `The ${step.role} step rejected the work and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up`,
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
        const up = escalated(row, target, `the ${step.role} step rejected it`);
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

  /** A flag for an approved server 10db can't run as written; it folds per server. */
  function flagMcpFailure(
    projectId: ProjectId,
    id: WorkstreamId,
    failure: { readonly name: string; readonly message: string },
  ): void {
    opts.inbox.flag({
      projectId,
      workstreamId: id,
      title: `The repo's MCP server "${failure.name}" can't run as written`,
      body: failure.message,
      foldKey: `project-mcp-failure:${projectId}:${failure.name}`,
    });
  }

  /**
   * The repo's MCP servers for one session. Only servers the builder approved for
   * their exact config are passed; the session starts either way. A server with no verdict gets an approval
   * card, one 10db can't run as written gets a flag naming the variable, and a reserved name gets a warning
   * flag. Every card folds, so a retried session adds none. A file 10db can't parse raises a flag that says
   * why, then throws, so the session fails before its row is written.
   */
  function readProjectMcp(
    project: ProjectDto,
    checkout: string,
    id: WorkstreamId,
    env: Readonly<Record<string, string>>,
  ): ProjectMcp {
    let repo: RepoMcp;
    try {
      repo = readRepoMcp(checkout);
    } catch (error) {
      if (error instanceof ProjectMcpError) {
        opts.inbox.flag({
          projectId: project.id,
          workstreamId: id,
          title: "The repo's MCP config stops sessions from starting",
          body: error.message,
          foldKey: `project-mcp-error:${project.id}`,
        });
      }
      throw error;
    }
    const mcp = resolveProjectMcp({
      repo,
      env,
      approvalFor: (review) => getMcpApproval(db, project.id, review.name, review.configHash),
    });
    for (const warning of mcp.warnings) {
      opts.inbox.flag({
        projectId: project.id,
        workstreamId: id,
        title: "Check the repo's MCP config",
        body: warning,
        foldKey: `project-mcp-warning:${project.id}`,
      });
    }
    for (const review of mcp.pending) requestMcpApproval(opts.inbox, project.id, review);
    for (const failure of mcp.failures) flagMcpFailure(project.id, id, failure);
    // Names only, never values. The live acceptance check reads this line by its message and field names.
    opts.logger.info(
      {
        workstreamId: id,
        passed: Object.entries(mcp.servers).map(([name, server]) => ({
          name,
          transport: server.type,
          envKeys: server.type === 'stdio' ? Object.keys(server.env).sort() : [],
        })),
        pending: mcp.pending.map((r) => r.name),
        denied: mcp.denied,
        failed: mcp.failures.map((f) => f.name),
      },
      'project mcp servers',
    );
    return mcp;
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
        const nextAction: NextAction = outcome.providerSessionId
          ? {
              kind: 'resume',
              providerSessionId: outcome.providerSessionId,
              reason: 'the usage limit reset',
            }
          : freshAction(db, id);
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
              ...(outcome.providerSessionId
                ? {
                    nextAction: {
                      kind: 'resume',
                      providerSessionId: outcome.providerSessionId,
                      reason: 'the account resumed',
                    },
                  }
                : {}),
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
      case 'unready': {
        opts.state.write((ctx) => {
          // The state machine has no shorter way back to the queue; the next action is kept as it was.
          transitionWorkstream(ctx, id, {
            to: S.PausedLimit,
            fence: ctl.fence,
            reason: `account not ready: ${outcome.refusal.problem}`,
          });
          transitionWorkstream(ctx, id, {
            to: S.Queued,
            fence: ctl.fence,
            reason: 'waiting for the account to be ready',
          });
          clearLease(ctx, id);
        });
        // The scheduler holds it there until the preparer makes the account ready.
        const lane = getProject(db, row.projectId);
        opts.accounts.prepare(getAccountRow(db, ctl.accountId), lane.id);
        return;
      }
      case 'parked':
        park(id, ctl.fence, outcome.inboxId, outcome.providerSessionId);
        return;
      case 'refused':
        fail(id, ctl.fence, outcome.message);
        return;
      case 'crashed': {
        const attempts = row.recoveryAttempts + 1;
        if (attempts > opts.limits.maxRecoveryAttempts) {
          fail(
            id,
            ctl.fence,
            `The session failed ${String(attempts)} times; last error: ${outcome.message}`,
          );
          return;
        }
        const nextAction = nextActionAfterCrash(
          row.nextAction,
          outcome.providerSessionId,
          latestHandoffForStep(db, row),
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

  async function runSession(id: WorkstreamId, ctl: Control): Promise<Outcome> {
    const row = getWorkstreamRow(db, id);
    const project = getProject(db, row.projectId);
    const checkout = checkoutOf(db, row);
    const task = getTask(db, row.taskId);
    const fresh = actionOnAnotherAccount(id, ctl, row);
    const action = fresh ?? row.nextAction;
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
    const savedResumeId =
      row.nextAction.kind === 'resume' || row.nextAction.kind === 'answer'
        ? row.nextAction.providerSessionId
        : null;
    if (ctl.stopReason)
      return { kind: 'stopped', reason: ctl.stopReason, providerSessionId: savedResumeId };
    // So does a move: the account the lane read before the await may not be the project's now.
    if (getProject(db, row.projectId).accountId !== ctl.accountId) return { kind: 'moved' };
    // An overloaded Mac starts no session: wait for it, unless a stop ends the wait first.
    if (opts.hold) {
      const holding = new AbortController();
      ctl.holdAbort = holding;
      try {
        await opts.hold.untilClear(holding.signal);
      } finally {
        ctl.holdAbort = null;
      }
      const stoppedWhileHeld = stopRequested(ctl);
      if (stoppedWhileHeld)
        return { kind: 'stopped', reason: stoppedWhileHeld, providerSessionId: savedResumeId };
      if (getProject(db, row.projectId).accountId !== ctl.accountId) return { kind: 'moved' };
    }
    const answeredItem = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;
    const resumeId =
      action.kind === 'resume' || action.kind === 'answer' ? action.providerSessionId : null;
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
    const prompt = buildSessionPrompt({
      sandboxed: Boolean(opts.laneSandbox),
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
        skills: persona?.skills ?? [],
        tools: step.tools,
      },
      priorResults,
      previousResult: readOnly ? step.result : null,
      revisedBy: reviser ? { role: reviser.role, personaName: reviser.personaName } : null,
      evidence,
      recovery:
        action.kind === 'resume'
          ? { reason: action.reason, lastOp: latestToolOp(db, id)?.opId ?? null }
          : null,
    });
    const { token, hash } = mintSessionToken();
    const account = getAccountRow(db, ctl.accountId);
    const notReady = unready(account);
    if (notReady) return { kind: 'unready', refusal: notReady, providerSessionId: null };
    // Built first, so a missing or changed secret refuses the session before any session row exists.
    let launch: SessionLaunch;
    try {
      launch = opts.launcher.session(account, row.model);
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
    const projectMcp = readProjectMcp(project, checkout, id, opts.launcher.projectEnv());
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
    const configDir = launch.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
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
    for (const failure of sandboxFailures) flagMcpFailure(project.id, id, failure);
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
    if (getProject(db, row.projectId).accountId !== ctl.accountId) {
      dispose();
      releaseStart();
      return { kind: 'moved' };
    }
    let session: ReturnType<typeof insertSession>;
    try {
      session = opts.state.write((ctx) => {
        const s = insertSession(ctx, {
          workstreamId: id,
          provider: project.provider,
          model: row.model,
          effort: row.effort,
          mode: 'managed',
          accountId: ctl.accountId,
          mcpTokenHash: hash,
          briefed,
          briefingBaselinePct: inheritedBaselinePct,
        });
        patchWorkstream(ctx, id, ctl.fence, {
          currentSessionId: s.id,
          baseHead,
          ...(fresh ? { nextAction: fresh } : {}),
        });
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
      handoffCause: 'context',
      briefingBaselinePct: inheritedBaselinePct,
      awaitingBriefingBaseline: briefed && inheritedBaselinePct === null,
      firmSent: false,
      resultNudged: false,
      lastTurn: null,
      contextPct: null,
      parkedFor: null,
      waitingOn: new Map(),
      waitTimer: null,
      started: false,
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

    opts.live.register(session.id, { signal: abort.signal, observer });
    const fileAccess = laneSession ? fileAccessJudge(laneSession.fileAccess) : null;
    try {
      handle = opts.adapter.start({
        sessionId: session.id,
        workstreamId: id,
        sequence: session.sequence,
        cwd: checkout,
        prompt: mcpNote ? `${prompt}\n\n${mcpNote}` : prompt,
        model: launch.model,
        effort: row.effort,
        resumeProviderSessionId: resumeId,
        env: launch.env,
        account: launch.expect,
        projectMcpServers: { ...mcpServers.remote, ...laneSession?.mcpServers },
        sandbox: laneSession?.spec ?? null,
        allowedTools: allowedToolsFor(
          project,
          step.tools,
          laneSession ? { sandboxed: { checkout } } : {},
        ),
        mcp: { url: opts.mcpUrl(), token, toolTimeoutMs: (project.humanWaitMinutes + 5) * 60_000 },
        preToolUse: (req) =>
          judgeToolUse({
            toolName: req.toolName,
            toolInput: req.input,
            repoPath: checkout,
            areas: project.areas,
            hazards: project.hazards,
            claims: claims(),
            readOnly,
            delivery: project.delivery,
            protectedPaths: opts.protectedPaths,
            ownSession: {
              configDir,
              providerSessionId: st.providerSessionId ?? resumeId,
            },
            ...(fileAccess ? { fileAccess } : {}),
          }),
        canUseTool: createPermissionBroker(
          { state: opts.state, inbox: opts.inbox },
          {
            projectId: project.id,
            workstreamId: id,
            sessionId: session.id,
            observer,
            signal: abort.signal,
            allowOnce: permission?.allowOnce ?? null,
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
    /** Asks the session to hand off, once: its context filled, or its account neared its usage limit. */
    const requestHandoff = (cause: HandoffCause, reason: string): void => {
      if (st.handoffRequested || st.outcome) return;
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
            opts.state.write((ctx) => {
              markSessionStarted(ctx, session.id, event.providerSessionId, event.pid, pidStart);
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
          case 'activity':
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
          case 'compacted':
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
            });
            handle.send(compactionReinjection(buildContextPack(db, getWorkstream(db, id))));
            break;
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
            const recorded = handoffForSession(db, session.id);
            if (recorded) {
              st.outcome = { kind: 'handoff', handoffId: recorded.id };
              await handle.stop();
            } else if (st.handoffRequested && !st.firmSent) {
              st.firmSent = true;
              handle.send(NUDGES[st.handoffCause].firm);
            } else if (
              readOnly &&
              currentStep(getWorkstreamRow(db, id)).result?.sessionId !== session.id &&
              !st.resultNudged
            ) {
              st.resultNudged = true;
              handle.send(RESULT_NUDGE);
            } else {
              st.outcome = {
                kind: 'step_done',
                withoutHandoff: st.handoffRequested,
                ending: describeEnding(st),
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
                    ending: describeEnding(st),
                  };
                  break;
              }
            }
            break;
          }
        }
      }
    } finally {
      // Ending the waits on every exit, before any stop, leaves no inbox waiter on a dead session.
      endWaits();
      releaseStart();
      // Leaving the loop without `ended` (a stale fence, a failed write) must not leave the process running.
      if (!sawEnded) await handle.stop().catch(() => undefined);
      opts.live.unregister(session.id);
      // Only once the lane process is gone: a command still running could swap a part of the tree.
      dispose();
      ctl.handle = null;
      ctl.requestHandoff = null;
      ctl.endWaits = null;
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
    const ended: Outcome = st.outcome ?? {
      kind: 'crashed',
      message: 'the session ended without an outcome',
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
          ? { nextAction: { kind: 'continue_from_handoff', handoffId: outcome.handoffId } }
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
      fail(
        id,
        ctl.fence,
        `The ${currentStep(row).role} step ended with uncommitted changes in its claims ${String(attempt)} times, and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up`,
      );
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
    // A project with a changed-packages check has each step checked by it; the ship gate runs the
    // full gate command before the push. Without a gate command the builder checks, as ever.
    const gateCommand =
      project.gateCommand === null ? null : (project.changedCheckCommand ?? project.gateCommand);
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
    const logPath = join(opts.dataDir, 'logs', 'gate', `${id}-${String(run)}.log`);
    opts.logger.info({ workstreamId: id, command: gateCommand, logPath }, 'gate started');
    const request: GateRequest = {
      ...(batchId === null
        ? {}
        : {
            beforeStart: async () => {
              const update = await opts.baseUpdates.beforeGate(batchId, gateAbort.signal);
              before.update = update;
              return update.kind !== 'aborted';
            },
          }),
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
      onSpawn: (pid) => {
        recording = identify(pid).then((gatePidStart) => {
          if (gatePidStart !== null)
            opts.state.write((ctx) => {
              patchWorkstream(ctx, id, ctl.fence, { gatePid: pid, gatePidStart });
            });
        });
      },
    };
    // One gate of a batch at a time: its gates share the batch's checkout.
    const result =
      batchId === null
        ? await opts.gate.run(request)
        : ((await opts.baseUpdates.gate(batchId, gateAbort.signal, () => opts.gate.run(request))) ??
          stoppedWaiting(logPath));
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
    });
    if (ctl.stopReason === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    // Shutdown killed the gate: record nothing. The workstream stays VERIFYING and recovery re-runs it.
    if (result.aborted) return;
    // A host the sandbox blocked is the builder's to allow; the card names it and the gate's evidence says so.
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
    const evidence = {
      workstreamId: id,
      kind: 'gate' as const,
      command: gateCommand,
      exitCode: result.exitCode,
      summary: gateSummary(before.update === null ? null : gateNote(before.update), result.tail),
      logPath: result.logPath,
      commitShas,
    };
    if (result.exitCode === 0) {
      const step = currentStep(row);
      const move = moveAfter(row.steps, row.stepIndex);
      const next = move.kind === 'advance' ? row.steps[move.to] : undefined;
      if (move.kind === 'advance' && next) {
        opts.state.write((ctx) => {
          insertEvidence(ctx, evidence);
          countFinished(ctx, step);
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
            reason: `gate passed; next: ${next.role}`,
          });
          clearLease(ctx, id);
        });
        return;
      }
      opts.state.write((ctx) => {
        insertEvidence(ctx, evidence);
        countFinished(ctx, step);
        if (row.steps.length > 0)
          patchWorkstream(ctx, id, ctl.fence, {
            steps: advanceSteps(row.steps, row.stepIndex, -1, entryFor(ctx, id)),
          });
        markDone(ctx, id, ctl.fence, row, 'gate passed');
      });
      return;
    }
    const attempt = row.attempt + 1;
    const evidenceId = opts.state.write((ctx) => insertEvidence(ctx, evidence).id);
    if (attempt > opts.limits.maxFixAttempts) {
      fail(
        id,
        ctl.fence,
        `The gate failed ${String(attempt)} times (last exit ${String(result.exitCode)})`,
      );
      return;
    }
    const failedStep = currentStep(row);
    const up = row.steps.length > 0 ? escalated(row, failedStep, 'the gate failed') : null;
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
        { workstreamId: id, inboxId: taken.inboxId },
        "migrations hazard held back: the branch can't take its base",
      );
    } finally {
      ctl.gateAbort = null;
    }
  }

  async function run(id: WorkstreamId, ctl: Control): Promise<void> {
    try {
      await migrationsBaseFirst(id, ctl);
      for (;;) {
        const row = getWorkstreamRow(db, id);
        const verifying = row.nextAction.kind === 'verify' || row.state === S.Verifying;
        // A pause only stops sessions; verification doesn't use the provider, so it carries on.
        if (ctl.stopReason && !(ctl.stopReason === 'paused' && verifying)) {
          settle(id, ctl, { kind: 'stopped', reason: ctl.stopReason, providerSessionId: null });
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
        if (outcome.kind === 'handoff' || outcome.kind === 'moved') continue;
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
            if ((await finishReadOnlyStep(id, ctl, finished, outcome.ending)) === 'next') continue;
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
                : 'step complete',
            }),
          );
          continue;
        }
        settle(id, ctl, outcome);
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
        settle(id, ctl, {
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
        endWaits: null,
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
      // answer moves it.
      if (row.nextAction.kind === 'builder_review') return;
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
        failIn(ctx, id, null, row, reason, {
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
        });
        return () => {
          flagFailed(row, reason);
          opts.onLaneFreed();
        };
      }
      const target = targetIndex === null ? undefined : row.steps[targetIndex];
      const up = target ? escalated(row, target, 'the builder sent the work back') : null;
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
