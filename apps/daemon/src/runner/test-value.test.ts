import { getWorkstream, listTasks, patchJudgeConfig } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const TEST_FILE = "import { it } from 'vitest';\nit('does a thing', () => {\n  // body\n});\n";

const write = (path: string, content: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content },
});
const commit = (opId: string, paths: string[]) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: {
    opId,
    paths,
    message: `test: add a test\n\nValue: protects=a thing; fails_when=it breaks; why_new=none; no_claim=none`,
  },
});
const turn = { do: 'turn_complete' as const };
const approve = (opId: string) => ({
  do: 'mcp' as const,
  tool: 'complete_step',
  args: { opId, summary: 'Looks right.', verdict: 'approve' },
});
const implement = (opId: string) => [
  write('src/api/a.test.ts', TEST_FILE),
  commit(opId, ['src/api/a.test.ts']),
  turn,
];

/** A fake OpenRouter that answers every System One question with `choice`, and keeps what was asked. */
function openRouterAnswering(choice: string) {
  const asked: string[] = [];
  const fetchFake: typeof fetch = (_input, init) => {
    asked.push(typeof init?.body === 'string' ? init.body : '');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'gen-1',
          model: 'typesafe/jev-1.13-20260917',
          provider: 'TypeSafe',
          answers: {
            decision: {
              type: 'choice',
              choice,
              confidence: 0.95,
              probabilities: { [choice]: 0.95 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  return { asked, openRouter: { fetch: fetchFake } };
}

const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);
const until = async (id: Parameters<typeof getWorkstream>[1]) => {
  for (let i = 0; i < 10 && ws(id).state !== 'DONE'; i += 1) {
    if (ws(id).state === 'FAILED') throw new Error(String(ws(id).failureReason));
    engine.launch(id);
    await engine.runner.idle();
  }
};
const followUps = (): string[] =>
  listTasks(engine.store.db, engine.project.id)
    .filter((t) => t.title.includes('does a thing'))
    .map((t) => t.title);

describe('the test-value judge at the end of an implement step', () => {
  it('files one follow-up task for a test it would move, on a task with no review step', async () => {
    const world = openRouterAnswering('move_cheaper');
    engine = await createTestEngine(
      { Alpha: [implement('op-tv-0001')] },
      {},
      {},
      { openRouter: world.openRouter },
    );
    const { workstream, task } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
    await until(workstream.id);
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement']);
    expect(followUps()).toEqual(['Move "does a thing" to a cheaper level']);
    const [filed] = listTasks(engine.store.db, engine.project.id).filter((t) =>
      t.title.includes('does a thing'),
    );
    expect(filed?.description).toContain('src/api/a.test.ts:2');
    expect(filed?.description).toContain(task.title);
    expect(world.asked).toHaveLength(1);
  });

  it('files nothing when the judge keeps the test', async () => {
    const world = openRouterAnswering('keep');
    engine = await createTestEngine(
      { Alpha: [implement('op-tv-0002')] },
      {},
      {},
      { openRouter: world.openRouter },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
    await until(workstream.id);
    expect(world.asked).toHaveLength(1);
    expect(followUps()).toEqual([]);
  });

  it('tells the reviewer instead, and files no follow-up, when a review step follows', async () => {
    const world = openRouterAnswering('move_cheaper');
    engine = await createTestEngine(
      { Alpha: [implement('op-tv-0003'), [approve('op-tv-0004'), turn]] },
      {},
      {},
      { openRouter: world.openRouter },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], {
      flow: 'quick',
      kinds: ['dependency'],
    });
    await until(workstream.id);
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement', 'review']);
    const reviewPrompt = engine.adapter.prompts[1]?.prompt ?? '';
    expect(reviewPrompt).toContain('does a thing');
    expect(reviewPrompt).toContain('input, not a finding');
    expect(followUps()).toEqual([]);
    // One judge call, made for the review, not one more for the follow-up.
    expect(world.asked).toHaveLength(1);
  });

  it('asks nothing and changes nothing with the decision turned off', async () => {
    const world = openRouterAnswering('move_cheaper');
    engine = await createTestEngine(
      { Alpha: [implement('op-tv-0005')] },
      {},
      {},
      { openRouter: world.openRouter },
    );
    engine.state.write((ctx) =>
      patchJudgeConfig(ctx, { decisions: { test_value: { enabled: false } } }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
    await until(workstream.id);
    expect(ws(workstream.id).state).toBe('DONE');
    expect(world.asked).toEqual([]);
    expect(followUps()).toEqual([]);
  });
});
