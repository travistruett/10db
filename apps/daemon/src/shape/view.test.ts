import {
  EventType,
  InvalidError,
  mintId,
  PlanDraft,
  ShapeMessageAuthor,
  ShapeToolInputs,
  type DaemonEvent,
  type ShapeId,
} from '@10db/contracts';
import { getShape, insertShape, listShapeProposals, patchShape, retirePrinciple } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { FakeAdapter, type FakeShapeBehaviour } from '../sessions';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { createShapeService, DEFAULT_SHAPE_TITLE, type ShapeService } from './service';

// Shape spec §4, §11: what the screen reads (the view), and the actions the routes call.

let c: ConversationFixture;
let state: StateStore;
let adapter: FakeAdapter;
let service: ShapeService;
let shapeId: ShapeId;
let events: DaemonEvent[];
beforeEach(() => {
  c = seedConversation();
  const bus = createEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  state = createStateStore(c.store, bus);
  adapter = new FakeAdapter({});
  shapeId = c.shape.id;
  service = createShapeService({
    state,
    adapter,
    joiningProblem: () => null,
    clock: new ManualClock(),
    filesDir: '/files',
    log: silentLogger,
    mcp: { url: 'http://127.0.0.1:4317/mcp', toolTimeoutMs: 60_000 },
    launch: () => ({
      cwd: '/repo',
      model: 'opus',
      effort: 'high',
      env: {},
      account: {
        accountId: mintId('Account'),
        label: 'Claude plan',
        kind: 'claude_subscription',
        identity: null,
      },
      access: {
        checkout: '/repo',
        home: '/home',
        protectedReads: [],
        tempRoot: '/tmp/10db',
      },
    }),
  });
});
afterEach(async () => {
  await service.close();
  c.close();
});

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** A turn that calls propose_plan with the draft, then replies. */
const proposing =
  (draft: Record<string, unknown>): FakeShapeBehaviour =>
  async (turn) => {
    const handler = service.toolsFor({ sessionId: turn.spec.sessionId, shapeId }).propose_plan;
    await must(
      handler,
      'propose_plan',
    )(ShapeToolInputs.propose_plan.parse({ draft: PlanDraft.parse(draft) }));
    return { text: 'Proposed.' };
  };

function fullDraft(source: string): Record<string, unknown> {
  return {
    goals: [
      {
        key: 'g',
        title: 'Goal',
        objective: 'Do it.',
        ceremony: 'direct',
        sourceMessageIds: [source],
        tasks: [{ key: 'g1', title: 'Only task', areas: ['api'], size: 'S' }],
      },
    ],
    looseTasks: [
      {
        key: 'a',
        title: 'Loose A',
        criteria: ['It works'],
        areas: ['api'],
        size: 'S',
        ceremony: 'direct',
        sourceMessageIds: [source],
      },
    ],
    records: [
      {
        key: 'dec',
        kind: 'decision',
        scope: 'project',
        question: 'Which queue?',
        choice: 'pg-boss',
        rationale: 'Fits',
        sourceMessageIds: [source],
      },
    ],
  };
}

describe('the view', () => {
  it('reads an empty conversation: idle, nothing heard, nothing proposed', () => {
    const view = service.view(shapeId);
    expect(view).toMatchObject({
      shape: { id: shapeId, round: 0, proposeUnlocked: false },
      messages: [],
      proposals: [],
      heard: [],
      turn: { running: false, queued: 0, proposing: false },
    });
  });

  it('counts the tokens the conversation has used, growing as each turn finishes', async () => {
    expect(service.view(shapeId).tokens).toBe(0);
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok' });
    service.send(shapeId, 'hello');
    await service.settled(shapeId);
    // The fake session reports its running totals: 100 in and 10 out after its first turn, 200 and 20
    // after its second.
    expect(service.view(shapeId).tokens).toBe(110);
    // A turn with no reply text still counts, and the screen is told when it ends.
    adapter.shapeBehaviour = () => Promise.resolve({});
    events.length = 0;
    service.send(shapeId, 'again');
    await service.settled(shapeId);
    expect(service.view(shapeId).tokens).toBe(220);
    expect(events.at(-1)).toMatchObject({ type: EventType.ShapeChanged, entityId: shapeId });
  });

  it('shows the transcript and the latest note_heard echo as items', async () => {
    const heard: FakeShapeBehaviour = async (turn) => {
      const echo = must(
        service.toolsFor({ sessionId: turn.spec.sessionId, shapeId }).note_heard,
        'note_heard',
      );
      await echo({ items: ['old item'] });
      await echo({ items: ['Thinner scrollbars', 'Denser cards'] });
      return { text: 'Noted.' };
    };
    adapter.shapeBehaviour = heard;
    service.send(shapeId, 'Scrollbars and density');
    await service.settled(shapeId);
    const view = service.view(shapeId);
    expect(view.heard).toEqual(['Thinner scrollbars', 'Denser cards']);
    expect(view.messages.map((m) => m.author)).toContain(ShapeMessageAuthor.Builder);
  });

  it('says a turn is running with the next one queued, and a Propose pending', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.shapeBehaviour = async () => {
      await held;
      return { text: 'ok' };
    };
    service.send(shapeId, 'first');
    await tick();
    service.send(shapeId, 'second');
    service.propose(shapeId);
    expect(service.view(shapeId).turn).toEqual({
      running: true,
      queued: 2,
      proposing: true,
      rehearsing: false,
    });
    release();
    await service.settled(shapeId);
    expect(service.view(shapeId).turn).toEqual({
      running: false,
      queued: 0,
      proposing: false,
      rehearsing: false,
    });
  });

  it('types each proposal’s body, and says what a converted one became', async () => {
    const m = c.say();
    adapter.shapeBehaviour = proposing(fullDraft(m));
    service.propose(shapeId);
    await service.settled(shapeId);
    const pending = service.view(shapeId);
    expect(pending.shape.round).toBe(1);
    expect(pending.proposals.map((p) => [p.key, p.kind, p.state, p.converted])).toEqual([
      ['g', 'goal', 'pending', null],
      ['a', 'task', 'pending', null],
      ['dec', 'decision', 'pending', null],
    ]);
    const goal = pending.proposals.find((p) => p.kind === 'goal');
    // The body is typed by the kind, so a goal's body has its tasks.
    expect(goal?.kind === 'goal' ? goal.body.tasks[0]?.title : undefined).toBe('Only task');

    const ids = pending.proposals.map((p) => p.id);
    const outcome = await service.convert(shapeId, ids);
    expect(outcome).toMatchObject({ ok: true, createdNow: 3 });
    const done = service.view(shapeId);
    const byKey = new Map(done.proposals.map((p) => [p.key, p]));
    expect(byKey.get('g')?.converted).toMatchObject({ taskIds: [expect.any(String)] });
    expect(byKey.get('g')?.converted?.goalId).toEqual(expect.any(String));
    expect(byKey.get('a')?.converted).toMatchObject({ goalId: null, decisionId: null });
    expect(byKey.get('a')?.converted?.taskIds).toHaveLength(1);
    expect(byKey.get('dec')?.converted?.decisionId).toEqual(expect.any(String));
    expect(byKey.get('dec')?.converted?.withdrawn).toBe(false);
  });
});

describe('a conversation’s title', () => {
  it('is the first line of the first message, cut at 60 characters', () => {
    const shape = service.create(c.project.id, { title: DEFAULT_SHAPE_TITLE, origin: 'app' });
    service.send(shape.id, `${'Word '.repeat(20)}\nsecond line`);
    const title = getShape(c.store.db, shape.id).title;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith('Word Word')).toBe(true);
    expect(title).not.toContain('second');
  });

  it('is kept once set, and a named conversation keeps its name', () => {
    const named = service.create(c.project.id, { title: 'Board polish', origin: 'app' });
    service.send(named.id, 'Something else entirely');
    expect(getShape(c.store.db, named.id).title).toBe('Board polish');
    const fresh = service.create(c.project.id, { title: DEFAULT_SHAPE_TITLE, origin: 'app' });
    service.send(fresh.id, 'First thing');
    service.send(fresh.id, 'Second thing');
    expect(getShape(c.store.db, fresh.id).title).toBe('First thing');
  });
});

describe('list', () => {
  it('puts the conversation touched last first', () => {
    const other = state.write((ctx) =>
      insertShape(ctx, c.project.id, { title: 'Newer', origin: 'app' }),
    );
    expect(service.list(c.project.id).map((s) => s.id)).toEqual([other.id, c.shape.id]);
    // Touching the older one (a title change stamps updatedAt) puts it first.
    c.store.write((ctx) => {
      patchShape(ctx, c.shape.id, { title: 'Touched' });
    });
    expect(service.list(c.project.id).map((s) => s.id)).toEqual([c.shape.id, other.id]);
  });
});

describe('events', () => {
  it('announces a conversation change when a turn starts and when it ends', async () => {
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok' });
    service.send(shapeId, 'hello');
    await service.settled(shapeId);
    events.length = 0;
    service.send(shapeId, 'again');
    await service.settled(shapeId);
    const changes = events.filter(
      (e) => e.type === EventType.ShapeChanged && e.entityId === shapeId,
    );
    // The message itself, the turn starting, the reply and the turn ending.
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.every((e) => e.data['projectId'] === c.project.id)).toBe(true);
  });
});

describe('Remove Draft Goal and Withdraw Decision', () => {
  async function converted(): Promise<void> {
    const m = c.say();
    adapter.shapeBehaviour = proposing(fullDraft(m));
    service.propose(shapeId);
    await service.settled(shapeId);
    const ids = service.view(shapeId).proposals.map((p) => p.id);
    await service.convert(shapeId, ids);
  }

  it('removes a converted goal from its goal id, with no conversation named', async () => {
    await converted();
    const goalId = must(
      service.view(shapeId).proposals.find((p) => p.kind === 'goal')?.converted?.goalId,
      'the goal id',
    );
    service.removeDraftGoal(goalId);
    const view = service.view(shapeId);
    const goal = view.proposals.find((p) => p.kind === 'goal');
    expect(goal).toMatchObject({ state: 'pending', converted: null });
    expect(listShapeProposals(c.store.db, shapeId).find((r) => r.key === 'g')?.state).toBe(
      'pending',
    );
  });

  it('refuses a goal no conversation made', () => {
    expect(() => {
      service.removeDraftGoal(mintId('Goal'));
    }).toThrow(InvalidError);
  });

  it('says what a converted principle and question became, and withdraws the principle', async () => {
    const m = c.say('Never sleep in tests.');
    adapter.shapeBehaviour = proposing({
      records: [
        {
          key: 'no-sleeps',
          kind: 'principle',
          scope: 'project',
          statement: 'Never sleep in tests',
          rationale: 'Sleeps make the suite flaky.',
          sourceMessageIds: [m],
        },
      ],
      questions: [{ key: 'who', text: 'Who pays?', for: 'finance', sourceMessageIds: [m] }],
    });
    service.propose(shapeId);
    await service.settled(shapeId);
    await service.convert(
      shapeId,
      service.view(shapeId).proposals.map((p) => p.id),
    );
    const rowOf = (kind: string) => service.view(shapeId).proposals.find((p) => p.kind === kind);
    const principleId = must(rowOf('principle')?.converted?.principleId, 'the principle id');
    expect(rowOf('principle')?.converted).toMatchObject({
      decisionId: null,
      withdrawn: false,
      superseded: false,
    });
    expect(rowOf('question')?.converted?.questionId).toEqual(expect.any(String));

    expect(() => {
      service.withdrawPrinciple(shapeId, principleId, '');
    }).toThrow(InvalidError);
    events.length = 0;
    service.withdrawPrinciple(shapeId, principleId, 'We allow it now');
    expect(rowOf('principle')?.converted).toMatchObject({ withdrawn: true });
    expect(events.some((e) => e.type === EventType.ShapeChanged && e.entityId === shapeId)).toBe(
      true,
    );
  });

  it('says a converted principle was retired from Knowledge', async () => {
    const m = c.say('Never sleep in tests.');
    adapter.shapeBehaviour = proposing({
      records: [
        {
          key: 'no-sleeps',
          kind: 'principle',
          scope: 'project',
          statement: 'Never sleep in tests',
          rationale: 'Sleeps make the suite flaky.',
          sourceMessageIds: [m],
        },
      ],
    });
    service.propose(shapeId);
    await service.settled(shapeId);
    await service.convert(
      shapeId,
      service.view(shapeId).proposals.map((p) => p.id),
    );
    const rowOf = () => service.view(shapeId).proposals.find((p) => p.kind === 'principle');
    expect(rowOf()?.converted).toMatchObject({ retired: false });
    const principleId = must(rowOf()?.converted?.principleId, 'the principle id');
    c.store.write((ctx) => retirePrinciple(ctx, principleId, 'me', 'No longer true'));
    expect(rowOf()?.converted).toMatchObject({ retired: true, withdrawn: false });
  });

  it('withdraws a converted decision, and the view says so', async () => {
    await converted();
    const decisionId = must(
      service.view(shapeId).proposals.find((p) => p.kind === 'decision')?.converted?.decisionId,
      'the decision id',
    );
    expect(() => {
      service.withdrawDecision(shapeId, decisionId, '');
    }).toThrow(InvalidError);
    service.withdrawDecision(shapeId, decisionId, 'We chose differently');
    expect(
      service.view(shapeId).proposals.find((p) => p.kind === 'decision')?.converted?.withdrawn,
    ).toBe(true);
  });
});
