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
  schema,
  seedAccount,
  setPlaybook,
  WORDING_MARK_MS,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs } from '../../test/fixtures';
import { seedProfiles } from '../../test/seed-profiles';
import type { LaneSessionSpec } from '../sessions';

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
      // The write that records the step's session keeps the model the launch just saved.
      expect(saved.steps[0]?.providerSessionId).toBe(
        listSessions(engine.store.db, workstream.id).at(-1)?.providerSessionId,
      );
    });
  });
});

describe('an account whose provider has no model profiles yet', () => {
  it('leaves the step queued without pausing the account, and runs it once the profiles exist', async () => {
    const held: { account: string; projectId: string }[] = [];
    engine = await createTestEngine(
      { Alpha: [finish('op-profiles-01')] },
      {},
      {
        modelWait: {
          hold: (account, projectId) => {
            held.push({ account: account.label, projectId });
          },
        },
      },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    // An old database before its first catalogue read: the step is planned, and no profile has been written.
    engine.store.db.delete(schema.modelProfiles).run();
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('QUEUED');
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(0);
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(openCards()).toEqual([]);
    // The scheduler is told, so it does not claim the row again on every tick.
    expect(held).toEqual([{ account: 'Claude plan', projectId: engine.project.id }]);

    seedProfiles(engine.state);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });
});

describe('a step the gate sends back for another try', () => {
  it('moves up among the models of the account the lane ran on, not the account the project has moved to', async () => {
    const second = { id: null as AccountId | null };
    engine = await createTestEngine(
      { Alpha: [[turn], finish('op-escalate-01')] },
      { gateCommand: 'test -f src/api/a.txt' },
    );
    const specs: LaneSessionSpec[] = [];
    // The project moves to an account that lists only the planned model while the first session runs.
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      if (specs.length === 1 && second.id !== null) {
        const to = second.id;
        engine.state.write((ctx) => patchProject(ctx, engine.project.id, { accountId: to }));
      }
      return {};
    };
    // Light's default build needs 35, which Sonnet meets at low effort; this test climbs from its high one.
    engine.state.write((ctx) =>
      setPlaybook(ctx, null, {
        cells: [
          {
            rigor: 'light',
            role: 'implement',
            model: { kind: 'automatic', minimum: 40 },
          },
        ],
      }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    const planned = ws(workstream.id).steps[0]?.model ?? '';
    second.id = secondPlan().id;
    list(second.id, [planned]);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).steps[0]?.reason).toBe(
      'escalated from claude-sonnet-5-5@high after the gate failed',
    );
    expect(ws(workstream.id).steps[0]?.model).toBe('claude-opus-5-5');
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
    // The model's own card says nothing is left, not that the step runs on a next model.
    const own = cards.find((c) => c.title === `Claude plan cannot run ${only}`);
    expect(own?.body).toMatch(/nothing left to run/);
    expect(own?.body).not.toMatch(/running the step on/);
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

  it('lets a second lane retry on another model when the first already marked the refused one', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'model_refused' }], finish('op-again-01')] });
    list(engine.project.accountId, claudeModels());
    const accountId = engine.project.accountId;
    const specs: LaneSessionSpec[] = [];
    // Another lane's refusal of the same model lands after this lane chose it and before its own arrives.
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      if (specs.length === 1)
        engine.state.write((ctx) => {
          markAccountModelUnusable(ctx, accountId, spec.model);
        });
      return {};
    };
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(specs).toHaveLength(2);
    expect(specs[1]?.model).not.toBe(specs[0]?.model);
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('does not say it marked a model unusable when the account no longer lists it', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'model_refused' }], finish('op-unmarked-1')],
    });
    const accountId = engine.project.accountId;
    list(accountId, claudeModels());
    const specs: LaneSessionSpec[] = [];
    // The account's list changes while the session runs and no longer holds the model it was given.
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      if (specs.length === 1)
        list(
          accountId,
          claudeModels().filter((m) => m !== spec.model),
        );
      return {};
    };
    const { workstream } = engine.addTask('Alpha', ['api'], [], quick);
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const [card] = openCards();
    expect(card?.body).toMatch(new RegExp(`running the step on ${specs[1]?.model ?? ''}`));
    expect(card?.body).not.toMatch(/marked .* unusable/);
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
    expect(openCards()[0]?.body).toMatch(/error’s wording/);

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

  it('becomes final when the model, tried again, is refused the same way', async () => {
    engine = await createTestEngine({
      Alpha: [[wording], finish('op-final-a1')],
      Beta: [[wording], finish('op-final-b1')],
      Gamma: [finish('op-final-g1')],
    });
    list(engine.project.accountId, claudeModels());
    const specs = recordSpecs();

    const [first] = await runTask('Alpha', specs);
    engine.clock.advance(WORDING_MARK_MS);
    const [again, other] = await runTask('Beta', specs);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(offer(first ?? '')).toMatchObject({ unusable: true, wordingMarkEndsAt: null });

    engine.clock.advance(100 * WORDING_MARK_MS);
    expect(await runTask('Gamma', specs)).not.toContain(first);
    expect(offer(first ?? '')?.unusable).toBe(true);
  });

  it('stays unusable when it came from model_not_found', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'model_refused' }], finish('op-notfound-a1')],
      Beta: [finish('op-notfound-b1')],
    });
    list(engine.project.accountId, claudeModels());
    const specs = recordSpecs();

    const [first] = await runTask('Alpha', specs);
    expect(offer(first ?? '')).toMatchObject({ unusable: true, wordingMarkEndsAt: null });
    engine.clock.advance(100 * WORDING_MARK_MS);
    expect(await runTask('Beta', specs)).not.toContain(first);
    expect(offer(first ?? '')?.unusable).toBe(true);
  });
});
