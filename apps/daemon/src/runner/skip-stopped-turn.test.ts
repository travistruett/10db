import { insertBuilderMessage, listSessions } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs, waitFor } from '../../test/fixtures';
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

  it('is not resumed when a handoff was requested', async () => {
    await run({
      Alpha: [
        [
          { do: 'context', percentage: 75 },
          { do: 'await_message', contains: 'write_handoff' },
          curl,
          turn,
        ],
      ],
    });
    expect(resumes()).toEqual([]);
  });

  it('is not resumed when a builder message is queued', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'await_signal', name: 'queued' }, curl, turn]],
    });
    const { task, workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => listSessions(engine.store.db, workstream.id)[0]);
    engine.state.write((ctx) => insertBuilderMessage(ctx, task.id, { body: 'Hold on', files: [] }));
    engine.adapter.signal('queued');
    await engine.runner.idle();
    expect(resumes()).toEqual([]);
  });

  it('sends nothing when the run is stopped at the same turn end', async () => {
    engine = await createTestEngine({
      Alpha: [[curl, { do: 'await_signal', name: 'stop' }, turn, resumed, turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => listSessions(engine.store.db, workstream.id)[0]);
    const cancelled = engine.runner.cancel(workstream.id);
    engine.adapter.signal('stop');
    await cancelled;
    await engine.runner.idle();
    expect(resumes()).toEqual([]);
  });
});
