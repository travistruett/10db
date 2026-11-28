import { DecisionRule, EventType, type WorkstreamId } from '@10db/contracts';
import {
  activeClaims,
  getWorkstreamRow,
  listInbox,
  listSessions,
  listTasks,
  seedProject,
  setAppSetting,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs, waitFor } from '../../test/fixtures';
import { projectPinKey } from '../git';
import { createOutOfMovesAnswers, OutOfMovesChoice } from '../inbox';
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
  const open = (prefix: string) =>
    listInbox(engine.store.db, { states: ['OPEN'] }).filter((c) => c.title.startsWith(prefix));
  const stuck = () => open('Stuck:');
  const outOfMoves = () => open('Out of moves:');
  const silence = () => {
    engine.clock.advance(STALL.activeIdleMs + 60_000);
  };
  const restartNotices = () => noticeRules.filter((rule) => rule === DecisionRule.StuckRun);
  // The answers as the daemon wires them, over this engine's runner and sweep.
  const answers = createOutOfMovesAnswers({
    db: engine.store.db,
    moreFixes: () => undefined,
    fixWithNote: () => undefined,
    abandon: () => undefined,
    shipWithout: () => undefined,
    retry: () => undefined,
    cancel: (target) => engine.runner.cancel(target),
    restartStalled: (target, opts) => engine.runner.restartStalled(target, opts),
    stopHung: (target) => {
      sweep.stopHung(target);
    },
    log: silentLogger,
  });
  /** Pins a project as 10db's own, where a defect task is filed. */
  const seedTenDb = () => {
    const project = seedProject(engine.store, { name: '10db' });
    engine.store.write((ctx) => {
      setAppSetting(ctx, projectPinKey(project.id), {
        gitDir: '/x',
        commonDir: '/x',
        id: '1:1/1:1',
        fetchUrl: null,
        pushUrl: 'git@github.com:travistruett/10db.git',
      });
    });
    return project;
  };
  return {
    id: workstream.id,
    sweep,
    restartNotices,
    stuck,
    outOfMoves,
    silence,
    answers,
    seedTenDb,
  };
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

  it('ends in the Out of Moves card naming a filed defect, with no requeue, when its stop has not finished in time', async () => {
    const { id, sweep, restartNotices, stuck, outOfMoves, silence, seedTenDb } = await silentRun({
      stopHangs: true,
    });
    const tenDb = seedTenDb();
    silence();
    sweep.sweep();
    expect(row(id).state).toBe('RUNNING');
    engine.clock.advance(STALL_STOP_DEADLINE_MS);
    await waitFor(() => outOfMoves().length === 1);
    expect(stuck()).toEqual([]);
    expect(row(id)).toMatchObject({ state: 'RUNNING', recoveryAttempts: 0 });
    expect(readRestart(engine.store.db, id)?.stopHungAt).not.toBeNull();
    expect(restartNotices()).toHaveLength(0);
    const defects = listTasks(engine.store.db, tenDb.id);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.description.split('\n')[0]).toBe(
      'Defect signature: stall:stop_hung:running',
    );
    const [card] = outOfMoves();
    expect(card?.title).toMatch(/would not stop$/);
    expect(card?.body).toContain(`10db filed this as its own defect: ${defects[0]?.title ?? ''}.`);
    expect(readRestart(engine.store.db, id)?.defectTaskId).toBe(defects[0]?.id);
    // A later sweep restarts nothing again, and rewrites nothing: one task, one card.
    sweep.sweep();
    expect(engine.runner.isRestarting(id)).toBe(false);
    expect(outOfMoves()).toHaveLength(1);
    expect(listTasks(engine.store.db, tenDb.id)).toHaveLength(1);
  });

  it('says the report could not be filed when 10db has no project here', async () => {
    const { id, sweep, outOfMoves, silence } = await silentRun({ stopHangs: true });
    silence();
    sweep.sweep();
    engine.clock.advance(STALL_STOP_DEADLINE_MS);
    await waitFor(() => outOfMoves().length === 1);
    expect(outOfMoves()[0]?.body).toContain(
      'This looks like a 10db defect; the report could not be filed here.',
    );
    expect(readRestart(engine.store.db, id)?.defectTaskId).toBeNull();
  });

  it('raises one Out of Moves card, and restarts nothing again, when the restarted run goes silent again', async () => {
    const { id, sweep, restartNotices, stuck, outOfMoves, silence, answers } = await silentRun();
    silence();
    sweep.sweep();
    await waitFor(() => !engine.runner.isRestarting(id));
    expect(row(id).state).toBe('QUEUED');
    engine.launch(id);
    await waitFor(
      () => listSessions(engine.store.db, id).length === 3 && row(id).state === 'RUNNING',
    );
    silence();
    sweep.sweep();
    sweep.sweep();
    expect(engine.runner.isRestarting(id)).toBe(false);
    expect(stuck()).toEqual([]);
    expect(restartNotices()).toHaveLength(1);
    expect(row(id)).toMatchObject({ state: 'RUNNING', recoveryAttempts: 1 });
    const cards = outOfMoves();
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card?.title).toMatch(/stalled again$/);
    expect(card?.options.map((o) => o.label)).toEqual([
      OutOfMovesChoice.More,
      OutOfMovesChoice.Change,
      OutOfMovesChoice.Drop,
    ]);
    expect(card?.body).toContain('10db restarted it once from its handoff, and it stalled again.');
    expect(card?.body).toContain('It holds its lane and its claims (api).');
    if (card === undefined) return;
    // Change the Task needs a note, and nothing happens without one.
    expect(() => {
      answers(card, { choice: OutOfMovesChoice.Change });
    }).toThrow(/needs a note/);
    expect(engine.runner.isRestarting(id)).toBe(false);
    // Drop It cancels the run.
    answers(card, { choice: OutOfMovesChoice.Drop });
    await waitFor(() => row(id).state === 'CANCELLED');
  });

  it('requeues a run once on Spend More Attempts, however many sweeps run while it stops', async () => {
    const { id, sweep, restartNotices, outOfMoves, silence, answers } = await silentRun({
      stopHangs: true,
    });
    silence();
    sweep.sweep();
    engine.clock.advance(STALL_STOP_DEADLINE_MS);
    await waitFor(() => outOfMoves().length === 1);
    const [card] = outOfMoves();
    if (card === undefined) return;
    answers(card, { choice: OutOfMovesChoice.More });
    expect(engine.runner.isRestarting(id)).toBe(true);
    sweep.sweep();
    await waitFor(() => !engine.runner.isRestarting(id));
    expect(row(id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 1 });
    expect(readRestart(engine.store.db, id)).toMatchObject({ stopHungAt: null });
    expect(restartNotices()).toHaveLength(1);
  });

  it('raises the card again when a stop an answer started does not finish', async () => {
    const { id, sweep, outOfMoves, silence } = await silentRun();
    silence();
    sweep.stopHung(id);
    expect(outOfMoves()).toHaveLength(1);
    expect(outOfMoves()[0]?.title).toMatch(/would not stop$/);
    expect(row(id).state).toBe('RUNNING');
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
