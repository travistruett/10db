import { getWorkstream, insertTask, insertWorkstream, listInbox, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoCeilingChoice, createAutoCeilingAnswers, createAutoCeilingCards } from '../inbox';
import { createEventBus } from '../events';
import { createFolderHold } from '../folder-hold';
import { createGit } from '../git';
import { silentLogger } from '../log';
import { createQueueWaits, createScheduler } from '../scheduler';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const turn = { do: 'turn_complete' as const };
const write = (path: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content: 'x' },
});
const commit = (opId: string, paths: string[]) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths, message: `Commit ${opId}` },
});
/** A session that does one commit and ends. */
const finish = (name: string) => [
  write(`src/api/${name}.txt`),
  commit(`op-${name}-001`, [`src/api/${name}.txt`]),
  turn,
];

const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);

/** A run 10db filed and started itself, as a gate fix task is. */
function fileFix(title: string) {
  const task = engine.state.write((ctx) =>
    insertTask(ctx, engine.project.id, {
      title,
      acceptanceCriteria: ['it works'],
      areas: ['api'],
    }),
  );
  return engine.state.write((ctx) =>
    insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      selfStarted: true,
    }),
  );
}

describe('the daily ceiling of 10db’s own work', () => {
  it('holds 10db’s own runs at the ceiling, with one Money card, and never the builder’s', async () => {
    const crash = { do: 'crash' as const, message: 'boom' };
    engine = await createTestEngine(
      {
        Fix1: [finish('fix1')],
        Fix2: [finish('fix2')],
        // Its first session reaches the ceiling and hands off, so the runner meets it between sessions.
        Fix3: [
          [
            { do: 'context', percentage: 20 },
            { do: 'await_message', contains: 'write_handoff' },
            { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-fix3-handoff', 'Go on') },
            turn,
          ],
          finish('fix3'),
        ],
        Mine: [finish('mine')],
        // Crashes once, is re-run by 10db (counted), then hands off at the ceiling and its next session runs.
        Rerun: [
          [crash],
          [
            { do: 'context', percentage: 20 },
            { do: 'await_message', contains: 'write_handoff' },
            { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-rerun-handoff', 'Go on') },
            turn,
          ],
          finish('rerun'),
        ],
      },
      // A low handoff line, so the scripted context report asks for the handoff.
      { autoCeilingSessions: 1, handoffPct: 12, nudgePct: 90 },
    );
    const waits = createQueueWaits({ state: engine.state, clock: engine.clock });
    const cards = createAutoCeilingCards({
      state: engine.state,
      inbox: engine.inbox,
      ceiling: engine.autoCeiling,
    });
    const scheduler = createScheduler({
      folderHold: createFolderHold({ state: engine.state, bus: createEventBus() }),
      state: engine.state,
      clock: engine.clock,
      caps: { global: 4 },
      instanceId: 'test-daemon',
      leaseMs: 60_000,
      tickMs: 2_000,
      logger: silentLogger,
      runner: engine.runner,
      accounts: { ...engine.accounts, prepare: () => undefined },
      branches: createGit(),
      onWrongBranch: () => undefined,
      onWorktreeMissing: () => undefined,
      keptWork: { ready: () => true },
      waits,
      ceiling: {
        reached: (projectId) => engine.autoCeiling.reached(projectId),
        raise: (projectId, waiting) => {
          cards.raise(projectId, waiting);
        },
        closeEarlierDays: () => {
          cards.closeEarlierDays();
        },
      },
    });
    const answers = createAutoCeilingAnswers({
      carryOn: (projectId, day) => {
        engine.autoCeiling.carryOn(projectId, day);
      },
    });
    const answer = (choice: string): void => {
      const [card] = listInbox(engine.store.db, { states: ['OPEN'] });
      if (!card) throw new Error('no open card');
      answers(card, { choice });
      engine.inbox.answer(card.id, { choice });
    };
    const openCards = () => listInbox(engine.store.db, { states: ['OPEN'] });
    const tick = async (): Promise<number> => {
      const launched = await scheduler.tick();
      await engine.runner.idle();
      return launched;
    };

    // The builder's run crashes once (its session is not counted); 10db's re-run of it is, which reaches
    // the ceiling. The run's next session starts anyway: only the re-run itself was checked.
    const rerun = engine.addTask('Rerun').workstream;
    expect(await tick()).toBe(1);
    expect(ws(rerun.id)).toMatchObject({ state: 'QUEUED' });
    expect(await tick()).toBe(1);
    expect(ws(rerun.id)).toMatchObject({ state: 'DONE' });
    expect(listSessions(engine.store.db, rerun.id)).toHaveLength(3);
    expect(engine.autoCeiling.today(engine.project.id)).toMatchObject({
      unmeasured: 1,
      reached: 'sessions',
    });

    // At the ceiling 10db's own run waits and the builder's launches.
    const held = fileFix('Fix2');
    const mine = engine.addTask('Mine').workstream;
    expect(await tick()).toBe(1);
    expect(ws(mine.id).state).toBe('DONE');
    expect(ws(held.id).state).toBe('QUEUED');
    expect(waits.get(held.id)?.kind).toBe('ceiling');
    expect(openCards()).toHaveLength(1);
    expect(openCards()[0]).toMatchObject({
      kind: 'flag',
      title: `${engine.project.name}'s own work reached today's ceiling`,
    });
    expect(openCards()[0]?.options.map((o) => o.label)).toEqual([
      AutoCeilingChoice.Carry,
      AutoCeilingChoice.Wait,
    ]);
    // Another tick finds the same hold and raises nothing more.
    expect(await tick()).toBe(0);
    expect(openCards()).toHaveLength(1);

    // Carry On Today launches the waiting run; reaching the raised ceiling raises a second card.
    answer(AutoCeilingChoice.Carry);
    expect(await tick()).toBe(1);
    expect(ws(held.id).state).toBe('DONE');
    const next = fileFix('Fix3');
    expect(await tick()).toBe(0);
    expect(ws(next.id).state).toBe('QUEUED');
    expect(openCards()).toHaveLength(1);

    // Wait Until Tomorrow keeps it waiting and raises no third card that day; the new day releases it.
    answer(AutoCeilingChoice.Wait);
    expect(await tick()).toBe(0);
    expect(openCards()).toHaveLength(0);
    engine.clock.advance(25 * 60 * 60_000);
    // Its first session reaches the new day's ceiling and hands off: the runner puts the run back, where
    // the scheduler holds it and raises that day's card.
    expect(await tick()).toBe(1);
    expect(ws(next.id).state).toBe('QUEUED');
    expect(await tick()).toBe(0);
    expect(waits.get(next.id)?.kind).toBe('ceiling');
    expect(openCards()).toHaveLength(1);
    answer(AutoCeilingChoice.Carry);
    expect(await tick()).toBe(1);
    expect(ws(next.id).state).toBe('DONE');
  });
});
