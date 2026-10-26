import { join } from 'node:path';
import {
  currentStep,
  EventType,
  InboxKind,
  PermissionChoice,
  StepRole,
  ToolAccess,
  WorkstreamState as S,
  type HandoffId,
  type InboxItemDto,
  type InboxItemId,
  type InboxTarget,
  type NextAction,
  type ProjectDto,
  type ProjectId,
  type Provider,
  type SessionId,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  activeClaims,
  clearLease,
  endSession,
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
  insertInboxItem,
  insertSession,
  insertSource,
  latestHandoffForStep,
  latestToolOp,
  listModelProfiles,
  listSessions,
  listEvidence,
  markSessionStarted,
  openItemsForWorkstream,
  patchWorkstream,
  recordProfileOutcome,
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
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  HANDOFF_FIRM_NUDGE,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_READ_ONLY,
  RESULT_NUDGE,
} from '../briefing';
import type { Clock, Timer } from '../clock';
import { batchCardFields } from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { judgeToolUse } from '../guard';
import {
  createPermissionBroker,
  requestMcpApproval,
  type InboxService,
  type WaitObserver,
} from '../inbox';
import type { Logger } from '../log';
import { mintSessionToken } from '../mcp';
import { allowedToolsFor, commandPrefix } from '../permissions';
import { escalateStep } from '../routing';
import {
  ProjectMcpError,
  readRepoMcp,
  resolveProjectMcp,
  SessionEndReason,
  skippedServersNote,
  type ProjectMcp,
  type RepoMcp,
  type SessionAdapter,
  type SessionHandle,
} from '../sessions';
import { advanceSteps, failStep, moveAfter, sendBackSteps, type StepEntry } from '../team';
import type { GateRunner } from '../verify';
import { findClaimed } from '../watcher';
import type { LiveSessions } from './live-sessions';
import { nextActionAfterCrash } from './next-action';

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
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  maxRecoveryAttempts: 3,
  maxFixAttempts: 3,
  gateTimeoutMs: 30 * 60_000,
};

export interface RunnerOptions {
  readonly state: StateStore;
  readonly adapter: SessionAdapter;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly gate: GateRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly live: LiveSessions;
  readonly limits: RunnerLimits;
  mcpUrl(): string;
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  onRateLimited(provider: Provider, resetsAt: Date | null, projectId: ProjectId): void;
  onLaneFreed(): void;
  /** Runs after every session ends (the watcher's step-end diff). Errors are logged, never thrown. */
  readonly afterSession?: (workstreamId: WorkstreamId) => Promise<void>;
  /** The OS start time of a pid, stored beside it so recovery can tell a reused PID apart. */
  identifyProcess?(pid: number): Promise<string | null>;
}

export interface Runner {
  launch(id: WorkstreamId, fence: number): void;
  stop(id: WorkstreamId, reason: StopReason): Promise<void>;
  cancel(id: WorkstreamId): Promise<void>;
  stopProvider(provider: Provider, reason: StopReason): Promise<void>;
  stopAll(reason: StopReason): Promise<void>;
  isRunning(id: WorkstreamId): boolean;
  idle(): Promise<void>;
  deliverParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
}

type Outcome =
  | { readonly kind: 'handoff'; readonly handoffId: HandoffId }
  | { readonly kind: 'step_done'; readonly withoutHandoff: boolean }
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

type Terminal = Exclude<Outcome, { kind: 'handoff' } | { kind: 'step_done' }>;

const PERMISSION_ANSWER_TEXT: Readonly<Record<string, string>> = {
  [PermissionChoice.AllowOnce]:
    'allowed once. Retry the call now; 10db lets this exact call through once.',
  [PermissionChoice.AllowWorkstream]: 'allowed for the rest of this workstream. Retry the call.',
  [PermissionChoice.AllowProject]: 'always allowed in this project. Retry the call.',
  [PermissionChoice.Deny]: 'denied. Do not retry it; find another way or ask with ask_human.',
};

/** An allow choice with no stored rule behind it (a one-time allow, or a Bash command with no safe prefix) lets the first identical call through. */
function needsOneTimeAllowance(choice: string, toolName: string, summary: string): boolean {
  if (choice === PermissionChoice.AllowOnce) return true;
  const stored =
    choice === PermissionChoice.AllowWorkstream || choice === PermissionChoice.AllowProject;
  return stored && toolName === 'Bash' && commandPrefix(summary) === null;
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

interface Control {
  readonly fence: number;
  readonly provider: Provider;
  stopReason: StopReason | null;
  handle: SessionHandle | null;
  /** Set while the gate runs; aborting it kills the gate's process group. */
  gateAbort: AbortController | null;
  /** Set while a session runs; ends its inbox waits so later answers go to the card. */
  endWaits: (() => void) | null;
  done: Promise<void>;
}

/** Per-session mutable state, kept in one object so callbacks and the event loop share it. */
interface SessionState {
  providerSessionId: string | null;
  handoffRequested: boolean;
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
  parkedFor: InboxItemId | null;
  /**
   * The cards the session is waiting on, oldest first, with how many waits each has: a folded card can
   * be asked twice. A card leaves the map when its last wait ends.
   */
  waitingOn: Map<InboxItemId, number>;
  waitTimer: Timer | null;
  outcome: Outcome | null;
}

/** Reads the stop reason afresh: a stop can land at any await, which narrowing cannot see. */
function stopRequested(ctl: { readonly stopReason: StopReason | null }): StopReason | null {
  return ctl.stopReason;
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

  function fail(id: WorkstreamId, fence: number, reason: string): void {
    const row = getWorkstreamRow(db, id);
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, {
        to: S.Failed,
        fence,
        patch: {
          failureReason: reason,
          currentSessionId: null,
          ...(row.steps.length > 0 ? { steps: failStep(row.steps, row.stepIndex) } : {}),
        },
        reason,
      });
      releaseClaims(ctx, id);
      clearLease(ctx, id);
    });
    opts.inbox.flag({
      projectId: row.projectId,
      workstreamId: id,
      title: `Workstream failed: ${getTask(db, row.taskId).title}`,
      body: reason,
      ...batchCardFields(row),
    });
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
      profiles: listModelProfiles(db),
      why,
    });
    return { step: result.step, moved: result.escalated };
  }

  /** DONE: the task is done, claims are released and the builder gets a review card (spec §7). */
  function completeInTx(
    ctx: WriteContext,
    id: WorkstreamId,
    fence: number,
    row: WorkstreamRow,
    commitShas: readonly string[],
    reason: string,
  ): void {
    transitionWorkstream(ctx, id, { to: S.Done, fence, reason });
    setTaskStatus(ctx, row.taskId, 'done');
    releaseClaims(ctx, id);
    clearLease(ctx, id);
    insertInboxItem(ctx, {
      projectId: row.projectId,
      kind: 'review',
      title: `Review: ${getTask(ctx.tx, row.taskId).title}`,
      body: `Gate passed with ${String(commitShas.length)} commit(s).`,
      options: [{ label: 'accept', description: 'Looks good' }],
      recommendation: null,
      category: 'product',
      urgency: 'low',
      detail: { workstreamId: id, commits: [...commitShas] },
      foldKey: null,
      targets: [],
    });
  }

  /** After a read-only step's session: the next step in this lane, DONE, a rework, or a failure. */
  function finishReadOnlyStep(id: WorkstreamId, ctl: Control, row: WorkstreamRow): 'next' | 'stop' {
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
      case 'no_result':
        fail(id, ctl.fence, `The ${step.role} step ended without calling complete_step`);
        return 'stop';
      case 'done': {
        const lastGate = listEvidence(db, id)
          .filter((e) => e.kind === 'gate' && e.exitCode === 0)
          .at(-1);
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
          completeInTx(
            ctx,
            id,
            ctl.fence,
            row,
            lastGate?.commitShas ?? [],
            `${step.role} approved`,
          );
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
          fail(
            id,
            ctl.fence,
            `The ${step.role} step rejected the work and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up`,
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
            steps: sendBackSteps(row.steps, row.stepIndex, move.to, up.step, entryFor(ctx, id)),
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
   * The repo's MCP servers for one session. Only servers the builder approved for
   * their exact config are passed; the session starts either way. A server with no verdict gets an approval
   * card, one 10db can't run as written gets a flag naming the variable, and a reserved name gets a warning
   * flag. Every card folds, so a retried session adds none. A file 10db can't parse raises a flag that says
   * why, then throws, so the session fails before its row is written.
   */
  function readProjectMcp(
    project: ProjectDto,
    id: WorkstreamId,
    env: Readonly<Record<string, string>>,
  ): ProjectMcp {
    let repo: RepoMcp;
    try {
      repo = readRepoMcp(project.repoPath);
    } catch (error) {
      if (error instanceof ProjectMcpError) {
        opts.inbox.flag({
          projectId: project.id,
          workstreamId: id,
          title: "The repo's .mcp.json stops sessions from starting",
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
        title: "Check the repo's .mcp.json",
        body: warning,
        foldKey: `project-mcp-warning:${project.id}`,
      });
    }
    for (const review of mcp.pending) requestMcpApproval(opts.inbox, project.id, review);
    for (const failure of mcp.failures) {
      opts.inbox.flag({
        projectId: project.id,
        workstreamId: id,
        title: `The repo's MCP server "${failure.name}" can't run as written`,
        body: failure.message,
        foldKey: `project-mcp-failure:${project.id}:${failure.name}`,
      });
    }
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
    const task = getTask(db, row.taskId);
    const action = row.nextAction;
    const step = currentStep(row);
    const persona = step.personaId ? getPersona(db, step.personaId) : null;
    const priorResults = row.steps.flatMap((s, i) =>
      i !== row.stepIndex && s.result
        ? [{ role: s.role, personaName: s.personaName, result: s.result }]
        : [],
    );
    const reviser = action.kind === 'revise' ? row.steps[action.reviewStep] : undefined;
    const readOnly = step.tools === ToolAccess.ReadOnly;
    const baseHead = row.baseHead ?? (await opts.git.head(project.repoPath));
    // A stop that landed while the head was read finds no handle to stop, so it is honoured here.
    if (ctl.stopReason) return { kind: 'stopped', reason: ctl.stopReason, providerSessionId: null };
    const answeredItem = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;
    const resumeId =
      action.kind === 'resume' || action.kind === 'answer' ? action.providerSessionId : null;
    const claims = () => activeClaims(db, id).map((c) => ({ kind: c.kind, name: c.name }));
    const permission =
      answeredItem?.kind === InboxKind.Permission ? permissionAnswer(answeredItem) : null;
    const contextPack = buildContextPack(db, getWorkstream(db, id));
    const prompt = buildSessionPrompt({
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
      evidence: action.kind === 'fix' ? getEvidence(db, action.evidenceId) : null,
      recovery:
        action.kind === 'resume'
          ? { reason: action.reason, lastOp: latestToolOp(db, id)?.opId ?? null }
          : null,
    });
    const { token, hash } = mintSessionToken();
    // Built first, so a missing key or region fails before any session row exists.
    const env = opts.sessionEnv(project);
    // The repo's approved MCP servers, expanded from that environment. A file 10db can't parse fails here too.
    const projectMcp = readProjectMcp(project, id, env);
    const mcpNote = skippedServersNote(projectMcp);
    // A resumed session continues its conversation, so it keeps whether that conversation began from
    // a briefing and the briefing's baseline. A fresh session is briefed only when its prompt carries
    // the handoff, which only a continuation's does.
    const resumed = resumeId ? getSessionByProviderId(db, id, resumeId) : undefined;
    const briefed = resumeId
      ? (resumed?.briefed ?? false)
      : action.kind === 'continue_from_handoff' && contextPack.handoff !== null;
    const inheritedBaselinePct = resumed?.briefingBaselinePct ?? null;
    const session = opts.state.write((ctx) => {
      const s = insertSession(ctx, {
        workstreamId: id,
        provider: project.provider,
        model: row.model,
        effort: row.effort,
        mode: 'managed',
        mcpTokenHash: hash,
        briefed,
        briefingBaselinePct: inheritedBaselinePct,
      });
      patchWorkstream(ctx, id, ctl.fence, { currentSessionId: s.id, baseHead });
      return s;
    });

    const abort = new AbortController();
    const st: SessionState = {
      providerSessionId: resumeId,
      handoffRequested: false,
      briefingBaselinePct: inheritedBaselinePct,
      awaitingBriefingBaseline: briefed && inheritedBaselinePct === null,
      firmSent: false,
      resultNudged: false,
      parkedFor: null,
      waitingOn: new Map(),
      waitTimer: null,
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
    handle = opts.adapter.start({
      sessionId: session.id,
      workstreamId: id,
      sequence: session.sequence,
      cwd: project.repoPath,
      prompt: mcpNote ? `${prompt}\n\n${mcpNote}` : prompt,
      model: row.model,
      effort: row.effort,
      resumeProviderSessionId: resumeId,
      env,
      billingMode: project.billingMode,
      projectMcpServers: projectMcp.servers,
      allowedTools: allowedToolsFor(project, step.tools),
      mcp: { url: opts.mcpUrl(), token, toolTimeoutMs: (project.humanWaitMinutes + 5) * 60_000 },
      preToolUse: (req) =>
        judgeToolUse({
          toolName: req.toolName,
          toolInput: req.input,
          repoPath: project.repoPath,
          areas: project.areas,
          hazards: project.hazards,
          claims: claims(),
          readOnly,
          delivery: project.delivery,
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
        },
      ),
    });
    ctl.handle = handle;

    let outcome: Outcome;
    try {
      for await (const event of handle.events) {
        switch (event.type) {
          case 'started': {
            st.providerSessionId = event.providerSessionId;
            const pidStart = await identify(event.pid);
            opts.state.write((ctx) => {
              markSessionStarted(ctx, session.id, event.providerSessionId, event.pid, pidStart);
              // The session has the answer now. Kept as `answer`, a restart would send it again and
              // re-grant a one-time permission; a fresh action resumes this session after a crash.
              if (action.kind === 'answer')
                patchWorkstream(ctx, id, ctl.fence, { nextAction: freshAction(ctx.tx, id) });
              const current = getWorkstreamRow(ctx.tx, id).state;
              if (current === S.Starting || current === S.HandingOff)
                transitionWorkstream(ctx, id, { to: S.Running, fence: ctl.fence });
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
              st.handoffRequested = true;
              opts.state.write((ctx) => {
                if (getWorkstreamRow(ctx.tx, id).state === S.Running) {
                  transitionWorkstream(ctx, id, {
                    to: S.HandingOff,
                    fence: ctl.fence,
                    reason: `context at ${String(event.percentage)}%`,
                  });
                }
              });
              handle.send(readOnly ? HANDOFF_NUDGE_READ_ONLY : HANDOFF_NUDGE);
            } else if (
              st.handoffRequested &&
              !st.firmSent &&
              event.percentage >= project.nudgePct
            ) {
              st.firmSent = true;
              handle.send(HANDOFF_FIRM_NUDGE);
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
            if (event.status === 'rejected' && !st.outcome) {
              st.outcome = {
                kind: 'paused',
                until: event.resetsAt,
                providerSessionId: st.providerSessionId,
              };
              opts.onRateLimited(project.provider, event.resetsAt, project.id);
            }
            break;
          case 'turn_complete': {
            opts.state.write((ctx) => {
              updateSessionUsage(ctx, session.id, {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
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
              handle.send(HANDOFF_FIRM_NUDGE);
            } else if (
              readOnly &&
              currentStep(getWorkstreamRow(db, id)).result?.sessionId !== session.id &&
              !st.resultNudged
            ) {
              st.resultNudged = true;
              handle.send(RESULT_NUDGE);
            } else {
              st.outcome = { kind: 'step_done', withoutHandoff: st.handoffRequested };
              await handle.stop();
            }
            break;
          }
          case 'ended': {
            sawEnded = true;
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
                  opts.onRateLimited(project.provider, null, project.id);
                  break;
                case SessionEndReason.BillingRefused:
                  st.outcome = {
                    kind: 'refused',
                    message: event.message ?? 'a billing check refused the session',
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
                  st.outcome = { kind: 'step_done', withoutHandoff: st.handoffRequested };
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
      // Leaving the loop without `ended` (a stale fence, a failed write) must not leave the process running.
      if (!sawEnded) await handle.stop().catch(() => undefined);
      opts.live.unregister(session.id);
      ctl.handle = null;
      ctl.endWaits = null;
      // Every exit ends the session row and frees the workstream's session slot, so a parked answer
      // is delivered, the lane is freed and the session's MCP token stops working.
      outcome = finishSession(id, ctl, session.id, st);
    }
    log.info({ outcome: outcome.kind }, 'session ended');
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
    const changed = (await opts.git.status(project.repoPath)).map((s) => s.path);
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
    const run = listEvidence(db, id).filter((e) => e.kind === 'gate').length + 1;
    const gateAbort = new AbortController();
    ctl.gateAbort = gateAbort;
    if (ctl.stopReason === 'cancelled' || ctl.stopReason === 'shutdown') gateAbort.abort();
    let recording: Promise<void> = Promise.resolve();
    const logPath = join(opts.dataDir, 'logs', 'gate', `${id}-${String(run)}.log`);
    opts.logger.info({ workstreamId: id, command: project.gateCommand, logPath }, 'gate started');
    const result = await opts.gate.run({
      repo: project.repoPath,
      command: project.gateCommand,
      logPath,
      timeoutMs: opts.limits.gateTimeoutMs,
      // The session environment is complete (login shell plus billing mode); the daemon's own
      // process.env never reaches a project's gate.
      env: opts.sessionEnv(project),
      signal: gateAbort.signal,
      onSpawn: (pid) => {
        recording = identify(pid).then((gatePidStart) => {
          if (gatePidStart !== null)
            opts.state.write((ctx) => {
              patchWorkstream(ctx, id, ctl.fence, { gatePid: pid, gatePidStart });
            });
        });
      },
    });
    ctl.gateAbort = null;
    opts.logger.info(
      {
        workstreamId: id,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
        timedOut: result.timedOut,
        aborted: result.aborted,
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
    const head = await opts.git.head(project.repoPath);
    const commitShas = await opts.git.commitsSince(project.repoPath, row.baseHead ?? head);
    // A cancel that landed while git was read must not be overwritten by the verdict.
    if (stopRequested(ctl) === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    const evidence = {
      workstreamId: id,
      kind: 'gate' as const,
      command: project.gateCommand,
      exitCode: result.exitCode,
      summary: result.tail.slice(-2000),
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
        completeInTx(ctx, id, ctl.fence, row, commitShas, 'gate passed');
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

  async function run(id: WorkstreamId, ctl: Control): Promise<void> {
    try {
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
        const outcome = await runSession(id, ctl);
        if (outcome.kind === 'handoff') continue;
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
            if (finishReadOnlyStep(id, ctl, finished) === 'next') continue;
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
      const ctl: Control = {
        fence,
        provider: getProject(db, getWorkstreamRow(db, id).projectId).provider,
        stopReason: null,
        handle: null,
        gateAbort: null,
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
      // Waits end before the process does, so an answer during a slow exit reaches the card.
      ctl.endWaits?.();
      await ctl.handle?.stop();
      await ctl.done;
    },
    async cancel(id) {
      if (active.has(id)) await runner.stop(id, 'cancelled');
      else cancelNow(id, null);
    },
    async stopProvider(provider, reason) {
      // Provider has a single member for now, so the comparison is constant until a second provider exists.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const matching = [...active.entries()].filter(([, c]) => c.provider === provider);
      await Promise.all(matching.map(([id]) => runner.stop(id, reason)));
    },
    async stopAll(reason) {
      await Promise.all([...active.keys()].map((id) => runner.stop(id, reason)));
    },
    isRunning: (id) => active.has(id),
    idle: () => (active.size === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    deliverParkedAnswer(target, item) {
      const row = getWorkstreamRow(db, target.workstreamId);
      if (row.state !== S.WaitingHuman || row.currentSessionId !== null) return;
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
  };
  return runner;
}
