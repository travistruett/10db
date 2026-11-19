import { getWorkstream, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';
import type { FakeScriptBook } from '../sessions';

type FakeStep = FakeScriptBook[string][number][number];

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const turn: FakeStep = { do: 'turn_complete' };
// No rule allows it in a lane on the fake's default mode: the broker skips it.
const curl: FakeStep = {
  do: 'tool',
  toolName: 'Bash',
  input: { command: 'curl -s https://example.com' },
};
const write = (path: string): FakeStep => ({
  do: 'tool',
  toolName: 'Write',
  input: { file_path: path, content: 'x' },
});
const commit = (opId: string, paths: string[]): FakeStep => ({
  do: 'mcp',
  tool: 'commit',
  args: { opId, paths, message: 'work' },
});
const resumed: FakeStep = { do: 'await_message', contains: 'Skipped:' };

/** The skip messages the runner resumed the lane's turns with. */
const resumes = () => engine.adapter.sent.filter((m) => m.text.startsWith('Skipped:'));

async function run(book: FakeScriptBook) {
  engine = await createTestEngine(book);
  const { task, workstream } = engine.addTask('Alpha');
  engine.launch(workstream.id);
  await engine.runner.idle();
  return { task, workstream };
}

describe('a turn a skip stopped', () => {
  it("is resumed with the skip's message", async () => {
    await run({
      Alpha: [
        [
          curl,
          turn,
          resumed,
          write('src/api/a.txt'),
          commit('op-skip-res-01', ['src/api/a.txt']),
          turn,
        ],
      ],
    });
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0]?.text).toMatch(/Carry on without it/);
  });

  it('ends the step as today at the third stop', async () => {
    const { workstream } = await run({
      Alpha: [[curl, turn, resumed, curl, turn, resumed, curl, turn]],
    });
    expect(resumes()).toHaveLength(2);
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'step_done',
    ]);
  });

  it('keeps its count across a fresh session in the run', async () => {
    await run({
      Alpha: [
        [
          curl,
          turn,
          resumed,
          { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-skip-ho-01', 'Go on') },
          turn,
        ],
        [curl, turn, resumed, curl, turn],
      ],
    });
    expect(resumes()).toHaveLength(2);
  });

  it('is not resumed when the turn ran a call after the skip', async () => {
    await run({
      Alpha: [[curl, write('src/api/a.txt'), commit('op-skip-res-02', ['src/api/a.txt']), turn]],
    });
    expect(resumes()).toEqual([]);
  });
});

// T4 call 11: a step that can't do its job without a skipped call says so, and fails naming both.
describe('a blocked step', () => {
  it('fails naming the reason and its skips', async () => {
    const { workstream } = await run({
      Alpha: [
        [
          curl,
          { do: 'mcp', tool: 'report_blocked', args: { reason: 'It needs the network' } },
          turn,
        ],
      ],
    });
    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state: 'FAILED',
      failureReason:
        "The implement step couldn't do its job without a call 10db skipped: It needs the network. Skipped: curl -s https://example.com",
    });
    expect(resumes()).toEqual([]);
  });
});
