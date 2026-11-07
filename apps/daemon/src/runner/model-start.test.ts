import {
  AccountProblem,
  Effort,
  isModelTier,
  ModelStatus,
  Provider,
  type AccountId,
} from '@10db/contracts';
import {
  getWorkstream,
  listAccountModels,
  listInbox,
  listModelProfiles,
  listSessions,
  markAccountModelUnusable,
  patchAccount,
  patchWorkstream,
  upsertModelProfiles,
  patchProject,
  replaceAccountModels,
  seedAccount,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';
import type { SessionSpec } from '../sessions';

// What a session starts on: the account's own ID for the planned model, a model chosen again after a
// move, and what happens when the account refuses the model it was given.

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

/** A second confirmed subscription. */
function secondPlan() {
  const account = seedAccount(engine.store, { kind: 'claude_subscription', label: 'Second plan' });
  engine.state.write((ctx) =>
    patchAccount(ctx, account.id, { expectedIdentity: 'second@example.com' }),
  );
  return account;
}

/** Every spec the fake adapter is started with, in order. */
function recordSpecs(): SessionSpec[] {
  const specs: SessionSpec[] = [];
  engine.adapter.seen = (spec) => {
    specs.push(spec);
    return {};
  };
  return specs;
}

const quick = { flow: 'quick' } as const;
const openCards = () => listInbox(engine.store.db, { states: ['OPEN'] });

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

  describe('after the project moves to an account that does not offer it', () => {
    it.each([
      { name: 'between planning and the start', moveAfterFirstSession: false },
      { name: 'part way through a step, between two sessions', moveAfterFirstSession: true },
    ])('is chosen again $name, and saved on the workstream', async ({ moveAfterFirstSession }) => {
      const second = { id: null as AccountId | null };
      let moved = false;
      const firstSession = moveAfterFirstSession
        ? [
            { do: 'context' as const, percentage: 75 },
            { do: 'await_message' as const, contains: 'write_handoff' },
            {
              do: 'mcp' as const,
              tool: 'write_handoff',
              args: handoffArgs('op-move-handoff', 'Write the file'),
            },
            turn,
          ]
        : finish('op-move-01');
      engine = await createTestEngine(
        { Alpha: moveAfterFirstSession ? [firstSession, finish('op-move-02')] : [firstSession] },
        {},
        {
          afterSession: () => {
            if (moveAfterFirstSession && !moved && second.id !== null) {
              moved = true;
              const to = second.id;
              engine.state.write((ctx) => patchProject(ctx, engine.project.id, { accountId: to }));
            }
            return Promise.resolve();
          },
        },
      );
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
      const planned = ws(workstream.id).steps[0]?.model ?? '';
      const there = secondPlan();
      second.id = there.id;
      // The second account lists every model but the planned one.
      list(
        there.id,
        claudeModels().filter((m) => m !== planned),
      );
      if (!moveAfterFirstSession)
        engine.state.write((ctx) => patchProject(ctx, engine.project.id, { accountId: there.id }));
      engine.launch(workstream.id);
      await engine.runner.idle();

      const ran = specs.at(-1)?.model ?? '';
      expect(ws(workstream.id).state).toBe('DONE');
      expect(specs.at(-1)?.account.accountId).toBe(there.id);
      expect(ran).not.toBe(planned);
      expect(isModelTier(ran)).toBe(false);
      expect(listAccountModels(engine.store.db, there.id).map((m) => m.model)).toContain(ran);
      const saved = ws(workstream.id);
      expect(saved.steps[0]).toMatchObject({ model: ran });
      expect(saved.steps[0]?.reason).toMatch(
        new RegExp(`${planned} is not offered by Second plan`),
      );
      expect(saved.model).toBe(ran);
    });
  });
});

describe('a model the account refuses at the first reply', () => {
  it('is marked unusable, raises a card, and the step starts over on another model', async () => {
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
    expect(openCards().map((c) => c.title)).toEqual([`Claude plan cannot run ${first ?? ''}`]);
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
    const refusal = cards.find((c) => c.title === 'Claude plan: sessions refused');
    expect(JSON.stringify(refusal?.detail)).toContain(AccountProblem.NoUsableModel);
    expect(refusal?.body).toMatch(/Settings › Accounts › Claude plan/);
  });

  it('starts over in the refused model’s tier, whatever the step’s setting', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'model_refused' }], finish('op-tier-01')] });
    list(engine.project.accountId, claudeModels());
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    const step = ws(workstream.id).steps[0];
    const fable = listModelProfiles(engine.store.db).find(
      (p) => p.model === 'claude-fable-5-1' && p.effort === Effort.High,
    );
    if (!step || !fable) throw new Error('no step or profile');
    engine.state.write((ctx) => {
      patchWorkstream(ctx, workstream.id, null, {
        steps: [
          {
            ...step,
            profileId: fable.id,
            model: fable.model,
            effort: fable.effort,
            setting: { kind: 'automatic' },
          },
        ],
        model: fable.model,
        effort: fable.effort,
      });
    });
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(specs.map((s) => s.model)).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
    expect(ws(workstream.id).steps[0]?.setting).toEqual({ kind: 'automatic' });
  });

  it('holds the account with one card and no session when every listed model is Unknown', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    engine.state.write((ctx) => {
      upsertModelProfiles(
        ctx,
        Object.values(Effort).map((effort) => ({
          provider: Provider.Claude,
          model: 'house-model',
          effort,
          aaSlug: null,
          enabled: false,
          maker: null,
          family: null,
          tier: null,
          status: ModelStatus.Unknown,
          inputPrice: null,
          outputPrice: null,
          releaseDate: null,
        })),
      );
    });
    list(engine.project.accountId, ['house-model']);
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(0);
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
    expect(openCards().map((c) => c.title)).toEqual(['Claude plan: sessions refused']);
  });

  it('fails the task, and does not ask again, for a model already marked unusable', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'model_refused' }], finish('op-again-01')] });
    list(engine.project.accountId, claudeModels());
    const accountId = engine.project.accountId;
    // Marked after the model was chosen, as an override that named a refused model would have left it.
    engine.adapter.seen = (spec) => {
      engine.state.write((ctx) => {
        markAccountModelUnusable(ctx, accountId, spec.model);
      });
      return {};
    };
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(ws(workstream.id).state).toBe('FAILED');
  });

  it('fails the task with its card when the account lists no model to mark', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'model_refused' }]] });
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(ws(workstream.id).state).toBe('FAILED');
    const cards = openCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toMatch(/^Claude plan cannot run /);
    expect(cards[0]?.body).toMatch(/lists no models/);
  });
});
