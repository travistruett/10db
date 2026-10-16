import { spawn } from 'node:child_process';
import { mintId, type WorkstreamState } from '@10db/contracts';
import {
  acquireLease,
  createTestStore,
  getWorkstream,
  getWorkstreamRow,
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
import { createTempRepo, seedWorkstream, waitFor } from '../../test/fixtures';
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

  it('re-runs verification when the daemon died while verifying, killing the orphaned gate group', async () => {
    const gate = await orphanProcess(true);
    const ws = inState(['STARTING', 'RUNNING', 'VERIFYING']);
    state.write((ctx) => {
      patchWorkstream(ctx, ws.workstream.id, null, {
        gatePid: gate.pid,
        gatePidStart: gate.startedAt,
      });
    });
    await recover();
    await gate.exited;
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'verify' },
    });
    expect(getWorkstreamRow(state.db, ws.workstream.id).gatePid).toBeNull();
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
