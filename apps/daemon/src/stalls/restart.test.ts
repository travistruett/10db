import { DecisionRule, EventType, type WorkstreamId } from '@10db/contracts';
import { activeClaims, getWorkstreamRow, listInbox, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs, waitFor } from '../../test/fixtures';
import { silentLogger } from '../log';
import type { FakeScriptBook } from '../sessions';
import { readRestart } from './restart-record';
import { STALL_STOP_DEADLINE_MS } from './restart-rule';
import { createStallSweep } from './sweep';
import { STALL } from './thresholds';

let engine: TestEngine;
let stopsHeld = false;
afterEach(async () => {
  // A stop the test held back is let through, so the engine can close its lane.
  stopsHeld = false;
  await engine.close();
});

const silentAfterHandoff: FakeScriptBook = {
  Alpha: [
    [
      { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-stall-ho-01', 'Carry on') },
      { do: 'turn_complete' },
    ],
    [{ do: 'hang' }],
  ],
};

/**
 * A run whose second session has started and says nothing more, with a stall sweep over the engine's
 * state. With `stopHangs` the session's stop never returns, as a hung process's doesn't.
 */
async function silentRun(opts: { readonly stopHangs?: boolean } = {}) {
  engine = await createTestEngine(silentAfterHandoff);
  if (opts.stopHangs === true) {
    stopsHeld = true;
    const open = engine.adapter.open.bind(engine.adapter);
    let opened = 0;
    engine.adapter.open = (spec) => {
      const handle = open(spec);
      opened += 1;
      // The first session ends at its handoff by a stop that returns; the silent one's does not.
      if (opened < 2) return handle;
      return {
        ...handle,
        stop: () => (stopsHeld ? handle.stop() : new Promise<void>(() => undefined)),
      };
    };
  }
  const { workstream } = engine.addTask('Alpha', ['api']);
  engine.launch(workstream.id);
  await waitFor(
    () =>
      listSessions(engine.store.db, workstream.id).length === 2 &&
      getWorkstreamRow(engine.store.db, workstream.id).state === 'RUNNING',
  );
  const sweep = createStallSweep({
    state: engine.state,
    inbox: engine.inbox,
    waits: { get: () => undefined },
    held: () => false,
    dataDir: engine.dataDir,
    gateTimeoutFloorMs: 20_000,
    clock: engine.clock,
    logger: silentLogger,
    restart: (id) => engine.runner.restartStalled(id),
    isRestarting: (id) => engine.runner.isRestarting(id),
    isRunning: (id) => engine.runner.isRunning(id),
    maxRecoveryAttempts: 3,
  });
  const noticeRules: unknown[] = [];
  engine.bus.subscribe((event) => {
    if (event.type !== EventType.NoticePosted) return;
    const decision = event.data['decision'];
    if (typeof decision === 'object' && decision !== null && 'rule' in decision)
      noticeRules.push(decision['rule']);
  });
  const stuck = () =>
    listInbox(engine.store.db, { states: ['OPEN'] }).filter((c) => c.title.startsWith('Stuck:'));
  const silence = () => {
    engine.clock.advance(STALL.activeIdleMs + 60_000);
  };
  const restartNotices = () => noticeRules.filter((rule) => rule === DecisionRule.StuckRun);
  return { id: workstream.id, sweep, restartNotices, stuck, silence };
}

const row = (id: WorkstreamId) => getWorkstreamRow(engine.store.db, id);

describe('a stalled active run', () => {
  it('is requeued once from its handoff, claims kept, with a notice and no card, however many ask while it stops', async () => {
    const { id, sweep, restartNotices, stuck, silence } = await silentRun();
    silence();
    sweep.sweep();
    expect(engine.runner.isRestarting(id)).toBe(true);
    // A second sweep and a second call while the stop is pending stop nothing again.
    sweep.sweep();
    const pending = engine.runner.restartStalled(id);
    expect(engine.runner.restartStalled(id)).toBe(pending);
    expect(await pending).toBe('restarted');
    expect(row(id)).toMatchObject({
      state: 'QUEUED',
      recoveryAttempts: 1,
      nextAction: { kind: 'continue_from_handoff' },
    });
    expect(activeClaims(engine.store.db, id).length).toBeGreaterThan(0);
    expect(restartNotices()).toHaveLength(1);
    expect(stuck()).toEqual([]);
    expect(readRestart(engine.store.db, id)).toMatchObject({ state: 'RUNNING', stopHungAt: null });
    expect(listSessions(engine.store.db, id)).toHaveLength(2);
  });

  it('ends in a card, with no requeue, when its stop has not finished in time', async () => {
    const { id, sweep, restartNotices, stuck, silence } = await silentRun({ stopHangs: true });
    silence();
    sweep.sweep();
    expect(row(id).state).toBe('RUNNING');
    engine.clock.advance(STALL_STOP_DEADLINE_MS);
    await waitFor(() => stuck().length === 1);
    expect(row(id)).toMatchObject({ state: 'RUNNING', recoveryAttempts: 0 });
    expect(readRestart(engine.store.db, id)?.stopHungAt).not.toBeNull();
    expect(restartNotices()).toHaveLength(0);
    // A later sweep restarts nothing again.
    sweep.sweep();
    expect(engine.runner.isRestarting(id)).toBe(false);
  });

  it('is left alone, with no notice and no attempt charged, when it ended while it stopped', async () => {
    const { id, sweep, restartNotices, silence } = await silentRun();
    silence();
    sweep.sweep();
    await engine.runner.cancel(id);
    await waitFor(() => !engine.runner.isRestarting(id));
    expect(row(id)).toMatchObject({ state: 'CANCELLED', recoveryAttempts: 0 });
    expect(restartNotices()).toHaveLength(0);
    expect(readRestart(engine.store.db, id)).toBeNull();
  });
});
