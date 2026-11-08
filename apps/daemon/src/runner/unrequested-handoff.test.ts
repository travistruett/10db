import { getWorkstream, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';
import { RESULT_NUDGE } from '../briefing';

// A handoff nobody asked for, below the handoff threshold, stands only while the step's work is
// outstanding: something uncommitted, or work the handoff names as not done. Otherwise the session is
// finishing its step, and a fresh session on the same step would only find it done.

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
const exits = (id: Parameters<typeof listSessions>[1]) =>
  listSessions(engine.store.db, id).map((s) => s.exitReason);

describe('a handoff written below the threshold', () => {
  it('ends the step when its work is committed and it names nothing left', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'context', percentage: 20 },
          write('src/api/a.txt'),
          commit('op-unreq-01', ['src/api/a.txt']),
          handOffDone('op-unreq-handoff'),
          turn,
        ],
        [write('src/api/b.txt'), commit('op-unreq-02', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(getWorkstream(engine.store.db, workstream.id).state).toBe('DONE');
    expect(exits(workstream.id)).toEqual(['step_done']);
  });

  it('starts a fresh session when it names work left, even with everything committed', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/api/a.txt'),
          commit('op-unreq-04', ['src/api/a.txt']),
          handOff('op-unreq-left'),
          turn,
        ],
        [write('src/api/b.txt'), commit('op-unreq-05', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(exits(workstream.id)).toEqual(['handoff', 'step_done']);
  });

  it('still starts a fresh session when work in its claims is left uncommitted', async () => {
    engine = await createTestEngine({
      Alpha: [
        [write('src/api/a.txt'), handOffDone('op-unreq-open'), turn],
        [commit('op-unreq-03', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(exits(workstream.id)).toEqual(['handoff', 'step_done']);
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

    expect(getWorkstream(engine.store.db, workstream.id).state).toBe('DONE');
    expect(exits(workstream.id)).toEqual(['step_done', 'step_done']);
  });

  it('fails the step, naming what was left, after three in a row with no commit between', async () => {
    engine = await createTestEngine({
      Alpha: [
        [handOff('op-unreq-loop-1'), turn],
        [handOff('op-unreq-loop-2'), turn],
        [handOff('op-unreq-loop-3'), turn],
        [handOff('op-unreq-loop-4'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const failed = getWorkstream(engine.store.db, workstream.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.failureReason).toContain('handed off 3 times in a row');
    expect(failed.failureReason).toContain('second half');
    expect(exits(workstream.id)).toHaveLength(3);
  });

  it('keeps handing off while each session commits more', async () => {
    engine = await createTestEngine({
      Alpha: [
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
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(exits(workstream.id)).toEqual(['handoff', 'handoff', 'handoff', 'step_done']);
  });
});
