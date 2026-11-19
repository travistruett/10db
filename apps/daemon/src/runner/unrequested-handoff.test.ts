import { getWorkstream, listEventsAfter, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';
import { RESULT_NUDGE } from '../briefing';
import type { FakeScriptBook } from '../sessions';

// A handoff nobody asked for, below the handoff threshold, stands only while the step's work is
// outstanding: something uncommitted, or work the handoff names as not done. Otherwise the session is
// finishing its step, and a fresh session on the same step would only find it done.

let engine: TestEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

/** A lane on `script`, run to idle; the engine before it is closed. */
async function runAlpha(script: FakeScriptBook['Alpha']) {
  await engine?.close();
  engine = await createTestEngine({ Alpha: script });
  const { workstream } = engine.addTask('Alpha');
  engine.launch(workstream.id);
  await engine.runner.idle();
  return { db: engine.store.db, id: workstream.id };
}

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
/** A handoff that names work left, as the fixture's does. */
const handOff = (opId: string) => ({
  do: 'mcp' as const,
  tool: 'write_handoff',
  args: handoffArgs(opId, 'Do the second half'),
});
/** A handoff that says nothing is left: a model saying it finished. */
const handOffDone = (opId: string) => {
  const args = handoffArgs(opId, 'Nothing left');
  return {
    do: 'mcp' as const,
    tool: 'write_handoff',
    args: { ...args, progress: { done: ['all of it'], notDone: [], nextAction: 'Nothing left' } },
  };
};
const approve = (opId: string) => ({
  do: 'mcp' as const,
  tool: 'complete_step',
  args: { opId, summary: 'Looks right.', verdict: 'approve' },
});
const implement = (opId: string) => [write('src/api/a.txt'), commit(opId, ['src/api/a.txt']), turn];
type Lane = Awaited<ReturnType<typeof runAlpha>>;
const exits = ({ db, id }: Lane) => listSessions(db, id).map((s) => s.exitReason);
/** The reasons the workstream's transitions give. */
const reasons = ({ db, id }: Lane) =>
  listEventsAfter(db, 0, 1000)
    .filter((e) => e.type === 'workstream.changed' && e.entityId === id)
    .map((e) => e.data['reason']);

describe('a handoff written below the threshold', () => {
  it('ends the step when its work is committed and it names nothing left, or after three in a row with no commit between', async () => {
    const finished = await runAlpha([
      [
        { do: 'context', percentage: 20 },
        write('src/api/a.txt'),
        commit('op-unreq-01', ['src/api/a.txt']),
        handOffDone('op-unreq-handoff'),
        turn,
      ],
      [write('src/api/b.txt'), commit('op-unreq-02', ['src/api/b.txt']), turn],
    ]);
    expect
      .soft(getWorkstream(finished.db, finished.id).state, 'committed, nothing left: state')
      .toBe('DONE');
    expect.soft(exits(finished), 'committed, nothing left: exits').toEqual(['step_done']);

    // As ending the turn would.
    const looping = await runAlpha([
      [handOff('op-unreq-loop-1'), turn],
      [handOff('op-unreq-loop-2'), turn],
      [handOff('op-unreq-loop-3'), turn],
      [handOff('op-unreq-loop-4'), turn],
    ]);
    expect.soft(getWorkstream(looping.db, looping.id).state, 'three in a row: state').toBe('DONE');
    expect
      .soft(exits(looping), 'three in a row: exits')
      .toEqual(['handoff', 'handoff', 'step_done']);
    expect
      .soft(reasons(looping), 'three in a row: reason')
      .toContain('step complete after 3 handoffs in a row that nobody asked for');
  });

  it('starts a fresh session while work is outstanding: named left, uncommitted, or more committed each session, and counts the run again after an asked handoff', async () => {
    const rows: { name: string; script: FakeScriptBook['Alpha']; exits: string[] }[] = [
      {
        name: 'names work left, even with everything committed',
        script: [
          [
            write('src/api/a.txt'),
            commit('op-unreq-04', ['src/api/a.txt']),
            handOff('op-unreq-left'),
            turn,
          ],
          [write('src/api/b.txt'), commit('op-unreq-05', ['src/api/b.txt']), turn],
        ],
        exits: ['handoff', 'step_done'],
      },
      {
        name: 'work in its claims is left uncommitted',
        script: [
          [write('src/api/a.txt'), handOffDone('op-unreq-open'), turn],
          [commit('op-unreq-03', ['src/api/a.txt']), turn],
        ],
        exits: ['handoff', 'step_done'],
      },
      {
        name: 'each session commits more',
        script: [
          [
            write('src/api/a.txt'),
            commit('op-unreq-08', ['src/api/a.txt']),
            handOff('op-unreq-p1'),
            turn,
          ],
          [
            write('src/api/b.txt'),
            commit('op-unreq-09', ['src/api/b.txt']),
            handOff('op-unreq-p2'),
            turn,
          ],
          [
            write('src/api/c.txt'),
            commit('op-unreq-10', ['src/api/c.txt']),
            handOff('op-unreq-p3'),
            turn,
          ],
          [write('src/api/d.txt'), commit('op-unreq-11', ['src/api/d.txt']), turn],
        ],
        exits: ['handoff', 'handoff', 'handoff', 'step_done'],
      },
      {
        name: 'the run counts again from nothing after a handoff 10db asked for',
        script: [
          [handOff('op-unreq-r1'), turn],
          [handOff('op-unreq-r2'), turn],
          [
            // A fresh session's first reading is its briefing's baseline; the second passes the line.
            { do: 'context', percentage: 5 },
            { do: 'context', percentage: 90 },
            handOff('op-unreq-asked'),
            turn,
          ],
          [handOff('op-unreq-r3'), turn],
          [handOff('op-unreq-r4'), turn],
          [write('src/api/a.txt'), commit('op-unreq-12', ['src/api/a.txt']), turn],
        ],
        exits: ['handoff', 'handoff', 'handoff', 'handoff', 'handoff', 'step_done'],
      },
    ];
    for (const row of rows) {
      expect.soft(exits(await runAlpha(row.script)), row.name).toEqual(row.exits);
    }
  });

  it('asks a review that hands off naming nothing left for its result, not a fresh session', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-unreq-06'),
        [
          handOffDone('op-unreq-review'),
          turn,
          { do: 'await_message', contains: RESULT_NUDGE },
          approve('op-unreq-07'),
          turn,
        ],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    for (
      let i = 0;
      i < 4 && getWorkstream(engine.store.db, workstream.id).state !== 'DONE';
      i += 1
    ) {
      engine.launch(workstream.id);
      await engine.runner.idle();
    }

    const lane = { db: engine.store.db, id: workstream.id };
    expect(getWorkstream(lane.db, lane.id).state).toBe('DONE');
    expect(exits(lane)).toEqual(['step_done', 'step_done']);
  });
});
