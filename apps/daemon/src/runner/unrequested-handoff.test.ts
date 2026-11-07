import { getWorkstream, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';

// A session that writes a handoff nobody asked for, below the handoff threshold, is finishing its
// step, not running out of room: a fresh session on the same step would only find it done.

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
const handOff = (opId: string) => ({
  do: 'mcp' as const,
  tool: 'write_handoff',
  args: handoffArgs(opId, 'Nothing left'),
});

describe('a handoff written below the threshold', () => {
  it('ends the step when its work is committed, without a fresh session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'context', percentage: 20 },
          write('src/api/a.txt'),
          commit('op-unreq-01', ['src/api/a.txt']),
          handOff('op-unreq-handoff'),
          turn,
        ],
        [write('src/api/b.txt'), commit('op-unreq-02', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(getWorkstream(engine.store.db, workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'step_done',
    ]);
  });

  it('still starts a fresh session when work in its claims is left uncommitted', async () => {
    engine = await createTestEngine({
      Alpha: [
        [write('src/api/a.txt'), handOff('op-unreq-open'), turn],
        [commit('op-unreq-03', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'handoff',
      'step_done',
    ]);
  });
});
