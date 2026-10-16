import { join } from 'node:path';
import {
  EventType,
  InboxKind,
  PermissionChoice,
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
} from '@10db/contracts';
import {
  activeClaims,
  clearLease,
  endSession,
  getEvidence,
  getInboxItem,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  handoffForSession,
  insertDeviation,
  insertEvidence,
  insertInboxItem,
  insertSession,
  insertSource,
  latestHandoff,
  latestToolOp,
  listEvidence,
  markSessionStarted,
  openItemsForWorkstream,
  patchWorkstream,
  releaseClaims,
  setTaskStatus,
  StaleFenceError,
  transitionWorkstream,
  updateSessionUsage,
} from '@10db/db';
import {
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  HANDOFF_FIRM_NUDGE,
  HANDOFF_NUDGE,
} from '../briefing';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { judgeToolUse } from '../guard';
import { createPermissionBroker, type InboxService, type WaitObserver } from '../inbox';
import type { Logger } from '../log';
import { mintSessionToken } from '../mcp';
import { baseAllowedTools, commandPrefix } from '../permissions';
import type { SessionAdapter, SessionHandle } from '../sessions';
import type { GateRunner } from '../verify';
import type { LiveSessions } from './live-sessions';
import { nextActionAfterCrash } from './next-action';

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
  firmSent: boolean;
  parkedFor: InboxItemId | null;
  /** The card the session is waiting on, while it waits. */
  waitingOn: InboxItemId | null;
  waits: number;
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

  function freshAction(id: WorkstreamId): NextAction {
    const latest = latestHandoff(db, id);
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
        patch: { failureReason: reason, currentSessionId: null },
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
    });
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
          : freshAction(id);
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
          latestHandoff(db, id),
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
      evidence: action.kind === 'fix' ? getEvidence(db, action.evidenceId) : null,
      recovery:
        action.kind === 'resume'
          ? { reason: action.reason, lastOp: latestToolOp(db, id)?.opId ?? null }
          : null,
    });
    const { token, hash } = mintSessionToken();
    const session = opts.state.write((ctx) => {
      const s = insertSession(ctx, {
        workstreamId: id,
        provider: project.provider,
        model: row.model,
        effort: row.effort,
        mode: 'managed',
        mcpTokenHash: hash,
      });
      patchWorkstream(ctx, id, ctl.fence, { currentSessionId: s.id, baseHead });
      return s;
    });

    const abort = new AbortController();
    const st: SessionState = {
      providerSessionId: resumeId,
      handoffRequested: false,
      firmSent: false,
      parkedFor: null,
      waitingOn: null,
      waits: 0,
      waitTimer: null,
      outcome: null,
    };
    const log = opts.logger.child({ workstreamId: id, sessionId: session.id });
    let handle: SessionHandle | null = null;
    let sawEnded = false;
    // Aborting the waits before the process stops means an answer that lands while a slow session
    // exits goes through onParkedAnswer and the card, never to a waiter that is about to disappear.
    // A session that was waiting parks on its card.
    const endWaits = (): void => {
      if (st.waits > 0 && st.waitingOn) st.parkedFor ??= st.waitingOn;
      st.waitTimer?.cancel();
      st.waitTimer = null;
      abort.abort();
    };
    ctl.endWaits = endWaits;

    const observer: WaitObserver = {
      onWaitStart(item) {
        st.waits += 1;
        if (st.waits > 1) return;
        st.waitingOn = item.id;
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
          st.parkedFor = item.id;
          // Abort the waits first: an answer that arrives while the session is still stopping then goes
          // through onParkedAnswer and the card, instead of to a waiter that is about to disappear.
          abort.abort();
          void handle?.stop();
        }, project.humanWaitMinutes * 60_000);
      },
      onWaitEnd() {
        st.waits = Math.max(0, st.waits - 1);
        if (st.waits > 0) return;
        st.waitingOn = null;
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
      prompt,
      model: row.model,
      effort: row.effort,
      resumeProviderSessionId: resumeId,
      env: opts.sessionEnv(project),
      allowedTools: baseAllowedTools(project),
      mcp: { url: opts.mcpUrl(), token, toolTimeoutMs: (project.humanWaitMinutes + 5) * 60_000 },
      preToolUse: (req) =>
        judgeToolUse({
          toolName: req.toolName,
          toolInput: req.input,
          repoPath: project.repoPath,
          areas: project.areas,
          hazards: project.hazards,
          claims: claims(),
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
          case 'context':
            opts.state.write((ctx) => {
              updateSessionUsage(ctx, session.id, { contextPct: event.percentage });
              patchWorkstream(ctx, id, ctl.fence, { contextPct: event.percentage });
              ctx.emit({
                type: EventType.SessionContext,
                entityType: 'session',
                entityId: session.id,
                data: { workstreamId: id, percentage: event.percentage },
              });
            });
            if (!st.handoffRequested && event.percentage >= project.handoffPct) {
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
              handle.send(HANDOFF_NUDGE);
            } else if (
              st.handoffRequested &&
              !st.firmSent &&
              event.percentage >= project.nudgePct
            ) {
              st.firmSent = true;
              handle.send(HANDOFF_FIRM_NUDGE);
            }
            break;
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
            else if (event.reason === 'rate_limited') {
              st.outcome = { kind: 'paused', until: null, providerSessionId: st.providerSessionId };
              opts.onRateLimited(project.provider, null, project.id);
            } else if (event.reason === 'error' || event.reason === 'stopped') {
              st.outcome = {
                kind: 'crashed',
                message: event.message ?? 'the session stopped unexpectedly',
                providerSessionId: st.providerSessionId,
              };
            } else st.outcome = { kind: 'step_done', withoutHandoff: st.handoffRequested };
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
    const run = listEvidence(db, id).filter((e) => e.kind === 'gate').length + 1;
    const gateAbort = new AbortController();
    ctl.gateAbort = gateAbort;
    if (ctl.stopReason === 'cancelled' || ctl.stopReason === 'shutdown') gateAbort.abort();
    let recording: Promise<void> = Promise.resolve();
    const result = await opts.gate.run({
      repo: project.repoPath,
      command: project.gateCommand,
      logPath: join(opts.dataDir, 'logs', 'gate', `${id}-${String(run)}.log`),
      timeoutMs: opts.limits.gateTimeoutMs,
      env: { ...process.env, ...opts.sessionEnv(project) },
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
      opts.state.write((ctx) => {
        insertEvidence(ctx, evidence);
        transitionWorkstream(ctx, id, { to: S.Done, fence: ctl.fence, reason: 'gate passed' });
        setTaskStatus(ctx, row.taskId, 'done');
        releaseClaims(ctx, id);
        clearLease(ctx, id);
        // Spec §7: a Review card tells the builder verified work is ready to look at.
        insertInboxItem(ctx, {
          projectId: project.id,
          kind: 'review',
          title: `Review: ${getTask(ctx.tx, row.taskId).title}`,
          body: `Gate passed with ${String(commitShas.length)} commit(s).`,
          options: [{ label: 'accept', description: 'Looks good' }],
          recommendation: null,
          category: 'product',
          urgency: 'low',
          detail: { workstreamId: id, commits: commitShas },
          foldKey: null,
          targets: [],
        });
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
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, {
        to: S.Queued,
        fence: ctl.fence,
        patch: { nextAction: { kind: 'fix', evidenceId }, attempt },
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
          if (stopRequested(ctl) === 'cancelled') {
            settle(id, ctl, { kind: 'stopped', reason: 'cancelled', providerSessionId: null });
            return;
          }
          if (outcome.withoutHandoff) {
            const row = getWorkstreamRow(db, id);
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
