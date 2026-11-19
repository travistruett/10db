import { AccountProblem, Provider, type AccountId } from '@10db/contracts';
import {
  getWorkstream,
  listAccountModels,
  listInbox,
  listModelProfiles,
  listSessions,
  replaceAccountModels,
  WORDING_MARK_MS,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { noticesPosted } from '../../test/notices-posted';
import type { LaneSessionSpec } from '../sessions';

// What a session starts on: the account's own ID for the planned model, and what happens when the
// account refuses the model it was given.

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
const finish = (opId: string) => [write('src/api/a.txt'), commit(opId, ['src/api/a.txt']), turn];

const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);
const claudeModels = (): string[] => [
  ...new Set(
    listModelProfiles(engine.store.db)
      .filter((p) => p.provider === Provider.Claude)
      .map((p) => p.model),
  ),
];

/** Lists `models` as the account's own, each launched under `launchId(model)`. */
function list(accountId: AccountId, models: readonly string[], launchId = (m: string) => m): void {
  engine.state.write((ctx) =>
    replaceAccountModels(
      ctx,
      accountId,
      models.map((model) => ({
        model,
        family: null,
        launchId: launchId(model),
        efforts: [],
        inputPrice: null,
        outputPrice: null,
      })),
    ),
  );
}

/** Every spec the fake adapter is started with, in order. */
function recordSpecs(): LaneSessionSpec[] {
  const specs: LaneSessionSpec[] = [];
  engine.adapter.seen = (spec) => {
    specs.push(spec);
    return {};
  };
  return specs;
}

const quick = { flow: 'quick' } as const;
const openCards = () => listInbox(engine.store.db, { states: ['OPEN'] });
/** The refusals 10db retried on another model: notices on the task, never cards. */
const refusalNotices = () =>
  noticesPosted(engine.store.db).filter((n) => n.key.startsWith('model-refused:'));

describe('the model a planned step starts on', () => {
  it('is the account’s own ID for the model, and the step keeps its canonical one', async () => {
    engine = await createTestEngine({ Alpha: [finish('op-launch-01')] });
    list(engine.project.accountId, claudeModels(), (m) => `us.anthropic.${m}`);
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    const planned = ws(workstream.id).steps[0]?.model ?? '';
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(specs.map((s) => s.model)).toEqual([`us.anthropic.${planned}`]);
    expect(ws(workstream.id).steps[0]?.model).toBe(planned);
  });
});

describe('a model the account refuses at the first reply', () => {
  it('is marked unusable, posts a notice on its task, and the step starts over on another model', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'model_refused' }], finish('op-refused-01')],
    });
    list(engine.project.accountId, claudeModels());
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();

    const [first, next] = specs.map((s) => s.model);
    expect(ws(workstream.id).state).toBe('DONE');
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
    const rows = listAccountModels(engine.store.db, engine.project.accountId);
    expect(rows.filter((r) => r.unusable).map((r) => r.model)).toEqual([first]);
    expect(openCards()).toEqual([]);
    expect(refusalNotices()).toMatchObject([
      {
        key: `model-refused:${engine.project.accountId}:${first ?? ''}`,
        tone: 'warning',
        line: `Claude plan cannot run ${first ?? ''}`,
        projectId: engine.project.id,
        taskId: ws(workstream.id).taskId,
      },
    ]);
    expect(ws(workstream.id).steps[0]?.reason).toMatch(
      new RegExp(`${first ?? ''} is marked unusable on Claude plan`),
    );
  });

  it('holds the account with one refusal card, beside the model’s own, and starts no second session when no model is left', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'model_refused' }]] });
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    const only = ws(workstream.id).steps[0]?.model ?? '';
    list(engine.project.accountId, [only]);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(true);
    const cards = openCards();
    expect(cards.map((c) => c.title).sort()).toEqual([
      `Claude plan cannot run ${only}`,
      'Claude plan: sessions refused',
    ]);
    // The step still names what was planned, so a later resolve says why it changed.
    expect(ws(workstream.id).steps[0]?.model).toBe(only);
    // The model's own card says nothing is left, not that the step runs on a next model.
    const own = cards.find((c) => c.title === `Claude plan cannot run ${only}`);
    expect(own?.body).toMatch(/nothing left to run/);
    expect(own?.body).not.toMatch(/running the step on/);
    const refusal = cards.find((c) => c.title === 'Claude plan: sessions refused');
    expect(JSON.stringify(refusal?.detail)).toContain(AccountProblem.NoUsableModel);
    expect(refusal?.body).toMatch(/Settings › Accounts › Claude plan/);
  });
});

// The words of an error cannot tell "Tool use with model X is not supported" (a config error) from "Model X is
// not available in this region" (a refusal), so a mark from them ends on its own and one later session settles it.
describe('a model the account refuses by an error’s wording alone', () => {
  const wording = { do: 'model_refused' as const, basis: 'wording' as const };
  const offer = (model: string) =>
    listAccountModels(engine.store.db, engine.project.accountId).find((m) => m.model === model);

  /** Runs the task to the end and answers the models its sessions started on. */
  async function runTask(title: string, specs: LaneSessionSpec[]): Promise<string[]> {
    const before = specs.length;
    const { workstream } = engine.addTask(title, ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    return specs.slice(before).map((s) => s.model);
  }

  it('is marked with an end, keeps the model out of later steps until then, and lets a later step use it after', async () => {
    engine = await createTestEngine({
      Alpha: [[wording], finish('op-wording-a1')],
      Beta: [finish('op-wording-b1')],
      Gamma: [finish('op-wording-g1')],
    });
    list(engine.project.accountId, claudeModels());
    const specs = recordSpecs();

    const [first, second] = await runTask('Alpha', specs);
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
    expect(offer(first ?? '')).toMatchObject({
      unusable: true,
      wordingMarkEndsAt: new Date(engine.clock.now().getTime() + WORDING_MARK_MS).toISOString(),
    });
    expect(refusalNotices()[0]?.body).toMatch(/error’s wording/);

    // A real refusal is not routed to again while its mark holds.
    engine.clock.advance(WORDING_MARK_MS - 1);
    expect(await runTask('Beta', specs)).not.toContain(first);
    expect(offer(first ?? '')?.unusable).toBe(true);

    // A config error is: the mark ends, a later step runs on the model, and its first good reply clears the mark.
    engine.clock.advance(1);
    expect(offer(first ?? '')?.unusable).toBe(false);
    expect(await runTask('Gamma', specs)).toEqual([first]);
    expect(offer(first ?? '')).toMatchObject({ unusable: false, wordingMarkEndsAt: null });
  });
});
