import {
  getWorkstream,
  listEvidence,
  listEventsAfter,
  listTasks,
  patchJudgeConfig,
} from '@10db/db';
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

/** A fake OpenRouter whose nth call answers `answers[n]`, a probability of yes per question id. */
function openRouterReading(answers: readonly Record<string, number>[]) {
  const asked: string[][] = [];
  const fetchFake: typeof fetch = (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      questions?: Record<string, unknown>;
    };
    const ids = Object.keys(body.questions ?? {});
    asked.push(ids);
    const given = answers[asked.length - 1] ?? {};
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: 'typesafe/jev-1.13-20260917',
          answers: Object.fromEntries(
            ids.map((id) => [id, { type: 'noul', noul: given[id] ?? 0.99 }]),
          ),
          usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  return { asked, openRouter: { fetch: fetchFake } };
}

describe('the acceptance check at the end of an implement step', () => {
  it('sends a run back once for a criterion the second opinion reads as not met, then goes on to Review', async () => {
    const world = openRouterReading([
      { met_0: 0.95, met_1: 0.5, unasked: 0.05 },
      { met_1: 0.1, unasked: 0.05 },
      { met_0: 0.95, met_1: 0.95, unasked: 0.05 },
    ]);
    const approve = {
      do: 'mcp' as const,
      tool: 'complete_step',
      args: { opId: 'op-acc-review', summary: 'Looks right.', verdict: 'approve' },
    };
    engine = await createTestEngine(
      {
        Alpha: [
          implement('op-acc-0001'),
          [write('src/api/b.txt', 'b'), commit('op-acc-0002', ['src/api/b.txt']), turn],
          [approve, turn],
        ],
      },
      { delivery: 'local', gateCommand: 'true', changedCheckCommand: 'true' },
      {},
      { openRouter: world.openRouter },
    );
    engine.state.write((ctx) =>
      patchJudgeConfig(ctx, {
        decisions: {
          test_value: { enabled: false },
          acceptance: { enabled: true },
          acceptance_second: { enabled: true, model: 'typesafe/jev-1.13' },
        },
      }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard', criteria: 2 });
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 0,
      nextAction: { kind: 'fix' },
    });
    const fix = ws(workstream.id).nextAction;
    expect(fix.kind === 'fix' ? typeof fix.providerSessionId : null).toBe('string');
    const sentBack = listEventsAfter(engine.store.db, 0, 10_000).filter(
      (e) => e.type === 'step.changed' && e.data['sentBackBy'] === 'acceptance',
    );
    expect(sentBack).toHaveLength(1);
    expect(ws(workstream.id).steps[0]?.acceptanceSentBack).toBe(1);

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1 });
    const read = listEvidence(engine.store.db, workstream.id).filter(
      (e) => e.kind === 'acceptance',
    );
    expect(read.map((e) => e.detail?.sentBack)).toEqual([true, false]);
    expect(read[1]?.detail?.criteria.map((c) => c.verdict)).toEqual(['met', 'met']);
    expect(world.asked).toHaveLength(3);
  });
});
