import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mintId,
  type NextAction,
  type WorkstreamState,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  acquireLease,
  insertToolOp,
  createTestStore,
  getWorkstream,
  getWorkstreamRow,
  insertHandoff,
  insertSession,
  listEventsAfter,
  listInbox,
  listSessions,
  markSessionStarted,
  patchWorkstream,
  transitionWorkstream,
  updateInboxItem,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  isolatedGitEnv,
  seedWorkstream,
  tempDir,
  waitFor,
} from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { recoverOnStartup, systemProcesses } from './index';

let base: Store;
let close: () => void;
let state: StateStore;
let inbox: InboxService;
let repo: { path: string; cleanup(): void };
let parked: string[];

beforeEach(() => {
  ({ store: base, close } = createTestStore());
  state = createStateStore(base, createEventBus());
  parked = [];
  inbox = createInboxService({ state, onParkedAnswer: (t) => parked.push(t.workstreamId) });
  repo = createTempRepo();
});
afterEach(() => {
  close();
  repo.cleanup();
});

/** Moves a fresh workstream through `states` and leaves a live session and a stale lease behind. */
function inState(
  states: readonly WorkstreamState[],
  opts: { title?: string; pid?: number | null; pidStart?: string | null } = {},
) {
  const seeded = seedWorkstream(base, { title: opts.title ?? 'Alpha', repoPath: repo.path });
  const session = state.write((ctx) => {
    for (const to of states) transitionWorkstream(ctx, seeded.workstream.id, { to, fence: null });
    const s = insertSession(ctx, {
      workstreamId: seeded.workstream.id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: mintId('Session'),
    });
    markSessionStarted(ctx, s.id, 'provider-1', opts.pid ?? null, opts.pidStart ?? null);
    patchWorkstream(ctx, seeded.workstream.id, null, { currentSessionId: s.id });
    // A lease held by a daemon that no longer exists; recovery must clear it.
    acquireLease(ctx, seeded.workstream.id, 'dead-daemon', ctx.now);
    return s;
  });
  return { ...seeded, session };
}

const recover = (extra: { cleanShutdown?: boolean } = {}) =>
  recoverOnStartup({
    state,
    inbox,
    git: createGit(),
    processes: systemProcesses,
    maxRecoveryAttempts: 3,
    logger: silentLogger,
    ...extra,
  });

const flowStep = (role: 'implement' | 'review', sessionFloor: number): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor,
  result: null,
});

/**
 * A standard-flow workstream on its review step. The implement step's session wrote a handoff and
 * never reported a provider session; the review has run no session yet.
 */
function onReviewStep() {
  const seeded = seedWorkstream(base, { repoPath: repo.path });
  const id = seeded.workstream.id;
  state.write((ctx) => {
    for (const to of ['STARTING', 'RUNNING'] as const)
      transitionWorkstream(ctx, id, { to, fence: null });
    const implementer = insertSession(ctx, {
      workstreamId: id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: mintId('Session'),
    });
    insertHandoff(ctx, {
      workstreamId: id,
      sessionId: implementer.id,
      content: {
        objective: { task: 'scripted', acceptanceCriteria: [], nonGoals: [] },
        progress: { done: [], notDone: [], nextAction: 'Commit the file' },
        codeState: { uncommittedSummary: '' },
        reasoning: { decisions: [], tradeOffs: [], rejected: [] },
        validation: { checks: [], environmentProblems: [] },
        continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
      },
      gitHead: 'abc',
      gitChangedFiles: [],
      gitCommits: [],
    });
    patchWorkstream(ctx, id, null, {
      steps: [{ ...flowStep('implement', 0), status: 'done' }, flowStep('review', 1)],
      stepIndex: 1,
    });
  });
  return id;
}

/** A real process to stand in for an orphan, with the identity recovery checks before signalling it. */
async function orphanProcess(detached = false) {
  const child = detached
    ? spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
    : spawn('sleep', ['60']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn failed');
  const startedAt = await systemProcesses.identify(pid);
  if (startedAt === null) throw new Error('ps could not see the child');
  const exited = new Promise((r) => child.once('exit', r));
  return { child, pid, startedAt, exited };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A gate group: a detached leader plus a grandchild in the same group, whose pid it records. */
async function orphanGateGroup() {
  const dir = tempDir('gate');
  const pidFile = join(dir.path, 'grandchild.pid');
  const leader = spawn('sh', ['-c', `sleep 60 & echo $! > '${pidFile}'; wait`], {
    detached: true,
    stdio: 'ignore',
  });
  const pid = leader.pid;
  if (pid === undefined) throw new Error('spawn failed');
  const exited = new Promise((r) => leader.once('exit', r));
  const grandchildPid = await waitFor(() => {
    try {
      const n = Number(readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  });
  const startedAt = await systemProcesses.identify(pid);
  if (startedAt === null) throw new Error('ps could not see the leader');
  return {
    leader,
    pid,
    startedAt,
    exited,
    grandchildPid,
    cleanup: () => {
      dir.cleanup();
    },
  };
}

function ask(ws: ReturnType<typeof inState>, title: string, signal: AbortSignal) {
  return inbox.ask({
    projectId: ws.project.id,
    workstreamId: ws.workstream.id,
    sessionId: ws.session.id,
    kind: 'question',
    title,
    body: '',
    options: [
      { label: 'A', description: '' },
      { label: 'B', description: '' },
    ],
    recommendation: null,
    category: 'other',
    urgency: 'normal',
    detail: null,
    signal,
  });
}

describe('recoverOnStartup', () => {
  it('fences a running workstream, kills its orphaned process, and re-queues it to resume', async () => {
    const orphan = await orphanProcess();
    const ws = inState(['STARTING', 'RUNNING'], { pid: orphan.pid, pidStart: orphan.startedAt });
    const { exited } = orphan;
    const report = await recover();
    await exited;

    expect(report.requeued).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
      state: 'QUEUED',
      currentSessionId: null,
      recoveryAttempts: 1,
      nextAction: { kind: 'resume', providerSessionId: 'provider-1' },
    });
    expect(getWorkstreamRow(state.db, ws.workstream.id).leaseOwner).toBeNull();
    expect(listSessions(state.db, ws.workstream.id)[0]?.exitReason).toBe('daemon_restart');
    const steps = listEventsAfter(state.db, 0, 1000).filter((e) => e.type === 'recovery.step');
    expect(steps[0]?.data).toMatchObject({ step: 'reconciled', sessionsEnded: 1 });
  });

  it('leaves a live process alone when its pid now belongs to something else', async () => {
    const stranger = await orphanProcess();
    try {
      inState(['STARTING', 'RUNNING'], {
        pid: stranger.pid,
        pidStart: 'Thu Jan  1 00:00:00 1970',
      });
      await recover();
      expect(await systemProcesses.identify(stranger.pid)).toBe(stranger.startedAt);
    } finally {
      stranger.child.kill('SIGKILL');
    }
  });

  it('re-runs verification when the daemon died while verifying, killing the whole orphaned gate group', async () => {
    const gate = await orphanGateGroup();
    try {
      const ws = inState(['STARTING', 'RUNNING', 'VERIFYING']);
      state.write((ctx) => {
        patchWorkstream(ctx, ws.workstream.id, null, {
          gatePid: gate.pid,
          gatePidStart: gate.startedAt,
        });
      });
      await recover();
      await gate.exited;
      await waitFor(() => !alive(gate.grandchildPid));
      expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'verify' },
      });
      expect(getWorkstreamRow(state.db, ws.workstream.id).gatePid).toBeNull();
    } finally {
      if (alive(gate.grandchildPid)) process.kill(gate.grandchildPid, 'SIGKILL');
      gate.cleanup();
    }
  });

  it('records HEAD, the dirty files and the last acknowledged operation in the recovery event', async () => {
    const ws = inState(['STARTING', 'RUNNING']);
    writeFileSync(join(repo.path, 'scratch.txt'), 'uncommitted\n');
    state.write((ctx) => {
      insertToolOp(ctx, {
        workstreamId: ws.workstream.id,
        sessionId: ws.session.id,
        opId: 'op-last',
        tool: 'commit',
        result: {},
      });
    });
    await recover();
    const head = execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], {
      env: isolatedGitEnv(),
    })
      .toString()
      .trim();
    const step = listEventsAfter(state.db, 0, 1000).find((e) => e.type === 'recovery.step');
    expect(step?.data).toMatchObject({
      head,
      dirtyFiles: ['scratch.txt'],
      lastOpId: 'op-last',
    });
  });

  it('leaves a gate group alone when its pid now belongs to something else', async () => {
    const stranger = await orphanProcess(true);
    try {
      const ws = inState(['STARTING', 'RUNNING', 'VERIFYING']);
      state.write((ctx) => {
        patchWorkstream(ctx, ws.workstream.id, null, {
          gatePid: stranger.pid,
          gatePidStart: 'Thu Jan  1 00:00:00 1970',
        });
      });
      await recover();
      expect(await systemProcesses.identify(stranger.pid)).toBe(stranger.startedAt);
      expect(getWorkstreamRow(state.db, ws.workstream.id).gatePid).toBeNull();
    } finally {
      stranger.child.kill('SIGKILL');
    }
  });

  it('kills the orphaned process of a paused workstream and keeps it paused', async () => {
    const orphan = await orphanProcess();
    const ws = inState(['STARTING', 'RUNNING', 'PAUSED_LIMIT'], {
      pid: orphan.pid,
      pidStart: orphan.startedAt,
    });
    await recover();
    await orphan.exited;
    expect(getWorkstream(state.db, ws.workstream.id).state).toBe('PAUSED_LIMIT');
  });

  it('does not count a clean shutdown as a failed recovery attempt', async () => {
    const ws = inState(['STARTING', 'RUNNING']);
    const report = await recover({ cleanShutdown: true });
    expect(report.requeued).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
      state: 'QUEUED',
      recoveryAttempts: 0,
      nextAction: { kind: 'resume' },
    });
  });

  it('does not fail a workstream on a clean shutdown even when its attempts are used up', async () => {
    const ws = inState(['STARTING', 'RUNNING']);
    state.write((ctx) => {
      patchWorkstream(ctx, ws.workstream.id, null, { recoveryAttempts: 3 });
    });
    const report = await recover({ cleanShutdown: true });
    expect(report.requeued).toEqual([ws.workstream.id]);
    expect(report.failed).toEqual([]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
      state: 'QUEUED',
      recoveryAttempts: 3,
    });
  });

  it('parks a workstream that was waiting on an open card', async () => {
    const ws = inState(['STARTING', 'RUNNING', 'WAITING_HUMAN']);
    const { item } = ask(ws, 'Q?', new AbortController().signal);
    const report = await recover();
    expect(report.parked).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'answer', inboxId: item.id },
    });
    expect(listSessions(state.db, ws.workstream.id)[0]?.exitReason).toBe('daemon_restart');
  });

  it('re-queues a waiting workstream whose card is gone', async () => {
    const ws = inState(['STARTING', 'RUNNING', 'WAITING_HUMAN']);
    const report = await recover();
    expect(report.requeued).toEqual([ws.workstream.id]);
    expect(report.parked).toEqual([]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
      state: 'QUEUED',
      currentSessionId: null,
      nextAction: { kind: 'resume', providerSessionId: 'provider-1' },
    });
  });

  it('fails a workstream that has used its recovery attempts, with a flag', async () => {
    const ws = inState(['STARTING', 'RUNNING']);
    state.write((ctx) => {
      patchWorkstream(ctx, ws.workstream.id, null, { recoveryAttempts: 3 });
    });
    const report = await recover();
    expect(report.failed).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id).state).toBe('FAILED');
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('starts a review step that was running when the daemon died fresh, never from the implementer’s handoff', async () => {
    const id = onReviewStep();
    await recover();
    expect(getWorkstreamRow(state.db, id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 1,
      nextAction: { kind: 'start' },
    });
  });

  it('marks the step it was on failed when a flow workstream uses its recovery attempts', async () => {
    const id = onReviewStep();
    state.write((ctx) => {
      patchWorkstream(ctx, id, null, { recoveryAttempts: 3 });
    });
    await recover();
    const row = getWorkstreamRow(state.db, id);
    expect(row.state).toBe('FAILED');
    expect(row.steps.map((s) => s.status)).toEqual(['done', 'failed']);
  });

  it('redelivers answers that were mid-delivery', async () => {
    const ws = inState(['STARTING', 'RUNNING', 'WAITING_HUMAN']);
    // The asking session died with the old daemon, so no waiter is live; abort models that.
    const asked = new AbortController();
    const { item } = ask(ws, 'Q2?', asked.signal);
    asked.abort();
    state.write((ctx) =>
      updateInboxItem(ctx, item.id, { state: 'DELIVERING', answer: { choice: 'A' } }),
    );
    const report = await recover();
    expect(report.redelivered).toEqual([item.id]);
    await waitFor(() => parked.length > 0);
  });

  describe('a next action that carries builder input', () => {
    const inboxId = mintId('InboxItem');
    const evidenceId = mintId('Evidence');
    it.each<[string, NextAction, NextAction]>([
      [
        'keeps an answer, resuming the latest provider session',
        { kind: 'answer', inboxId, providerSessionId: null },
        { kind: 'answer', inboxId, providerSessionId: 'provider-1' },
      ],
      [
        'keeps a fix with its gate evidence',
        { kind: 'fix', evidenceId },
        { kind: 'fix', evidenceId },
      ],
    ])('%s', async (_name, before, expected) => {
      const ws = inState(['STARTING', 'RUNNING']);
      state.write((ctx) => {
        patchWorkstream(ctx, ws.workstream.id, null, { nextAction: before });
      });
      const report = await recover();
      expect(report.requeued).toEqual([ws.workstream.id]);
      expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
        state: 'QUEUED',
        recoveryAttempts: 1,
        nextAction: expected,
      });
    });
  });

  describe('each pre-crash state', () => {
    const cases: {
      name: string;
      path: readonly WorkstreamState[];
      state: WorkstreamState;
      report: 'requeued' | 'none';
      nextAction?: string;
      attempts: number;
    }[] = [
      {
        name: 'STARTING',
        path: ['STARTING'],
        state: 'QUEUED',
        report: 'requeued',
        nextAction: 'resume',
        attempts: 1,
      },
      {
        name: 'RUNNING',
        path: ['STARTING', 'RUNNING'],
        state: 'QUEUED',
        report: 'requeued',
        nextAction: 'resume',
        attempts: 1,
      },
      {
        name: 'HANDING_OFF',
        path: ['STARTING', 'RUNNING', 'HANDING_OFF'],
        state: 'QUEUED',
        report: 'requeued',
        nextAction: 'resume',
        attempts: 1,
      },
      {
        name: 'VERIFYING',
        path: ['STARTING', 'RUNNING', 'VERIFYING'],
        state: 'QUEUED',
        report: 'requeued',
        nextAction: 'verify',
        attempts: 1,
      },
      {
        name: 'RECOVERING',
        path: ['STARTING', 'RUNNING', 'RECOVERING'],
        state: 'QUEUED',
        report: 'requeued',
        nextAction: 'resume',
        attempts: 1,
      },
      {
        name: 'TAKEN_OVER',
        path: ['STARTING', 'RUNNING', 'TAKEN_OVER'],
        state: 'QUEUED',
        report: 'requeued',
        nextAction: 'resume',
        attempts: 1,
      },
      { name: 'QUEUED', path: [], state: 'QUEUED', report: 'none', attempts: 0 },
      {
        name: 'PAUSED_LIMIT',
        path: ['STARTING', 'RUNNING', 'PAUSED_LIMIT'],
        state: 'PAUSED_LIMIT',
        report: 'none',
        attempts: 0,
      },
      {
        name: 'DONE',
        path: ['STARTING', 'RUNNING', 'VERIFYING', 'DONE'],
        state: 'DONE',
        report: 'none',
        attempts: 0,
      },
    ];

    it.each(cases)('$name', async (c) => {
      const ws = inState(c.path);
      const report = await recover();
      expect(report.requeued).toEqual(c.report === 'requeued' ? [ws.workstream.id] : []);
      expect(report.failed).toEqual([]);
      expect(report.parked).toEqual([]);
      const after = getWorkstream(state.db, ws.workstream.id);
      expect(after.state).toBe(c.state);
      expect(after.recoveryAttempts).toBe(c.attempts);
      if (c.nextAction) expect(after.nextAction.kind).toBe(c.nextAction);
      const terminal = c.state === 'DONE';
      // Terminal workstreams are not recovery's business: their rows stay as they were.
      expect(getWorkstreamRow(state.db, ws.workstream.id).leaseOwner).toBe(
        terminal ? 'dead-daemon' : null,
      );
      expect(after.currentSessionId === null).toBe(!terminal);
      expect(listSessions(state.db, ws.workstream.id)[0]?.exitReason ?? null).toBe(
        terminal ? null : 'daemon_restart',
      );
    });
  });
});
