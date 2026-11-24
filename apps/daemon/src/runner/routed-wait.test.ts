import { ClaimKind, RoutedBy, type WorkstreamId } from '@10db/contracts';
import {
  activeClaims,
  claimConflict,
  getWorkstream,
  insertPerson,
  listInbox,
  listSessions,
  listSkipsForWorkstream,
  setInboxRecipients,
  setRoutingRules,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestEngine,
  routeQuestionsAway,
  triageHeld,
  type TestEngine,
} from '../../test/engine';
import { waitFor } from '../../test/fixtures';
import type { FakeScriptBook } from '../sessions';

type FakeStep = FakeScriptBook[string][number][number];

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const ws = (id: WorkstreamId) => getWorkstream(engine.store.db, id);
const openCard = () => listInbox(engine.store.db, { states: ['OPEN'] })[0];
const turn: FakeStep = { do: 'turn_complete' };

const askHuman = (category: string, opId: string): FakeStep => ({
  do: 'mcp',
  tool: 'ask_human',
  args: {
    opId,
    category,
    question: 'Charge tax?',
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
  },
});
/** Mark and Ana, with an area route for `category` on the `api` area that the engine's tasks claim. */
function routeTo(category: string, handles: ('mark' | 'ana')[], areaScoped = true) {
  const person = (handle: string, name: string, userId: string) =>
    engine.store.write((ctx) =>
      insertPerson(ctx, {
        handle,
        name,
        slack: [{ teamId: 'T1', userId, sendMode: 'review', dailyLimit: 10 }],
      }),
    ).value;
  const people = { mark: person('mark', 'Mark', 'U1'), ana: person('ana', 'Ana', 'U2') };
  engine.store.write((ctx) =>
    setRoutingRules(ctx, engine.project.id, {
      rules: handles.map((h) => ({
        category: category as 'product',
        area: areaScoped ? 'api' : null,
        personId: people[h].id,
      })),
    }),
  );
}

const oneAsk = (...first: FakeStep[]): FakeScriptBook => ({ Alpha: [[...first, turn], [turn]] });

describe('a question routed to someone else', () => {
  it('parks the session at once, and the answer requeues it with the answer in its prompt', async () => {
    engine = await createTestEngine(oneAsk(askHuman('product', 'op-routed-ask-1')));
    routeTo('product', ['mark']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    await engine.runner.idle();

    expect(card.assignees).toEqual(['mark']);
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'answer', inboxId: card.id },
    });
    engine.inbox.answer(card.id, { choice: 'Yes' });
    expect(ws(workstream.id).state).toBe('QUEUED');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
  });

  // T4 call 21: a lane nobody watches never waits on the builder; a question for them is answered at once.
  it('answers a builder question at once, while another category routes to someone', async () => {
    engine = await createTestEngine(oneAsk(askHuman('engineering', 'op-builder-ask-1')));
    routeTo('product', ['mark']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listInbox(engine.store.db, {})).toEqual([]);
    expect(listSkipsForWorkstream(engine.store.db, workstream.id)).toMatchObject([
      { toolName: 'ask_human', summary: 'Charge tax?', kind: 'question' },
    ]);
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('parks a session already waiting on a card triage has yet to route when it asks a second, routed question', async () => {
    engine = await createTestEngine(
      oneAsk(askHuman('engineering', 'op-builder-ask-2')),
      {},
      {},
      triageHeld(),
    );
    routeQuestionsAway(engine);
    const { task, workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const first = await waitFor(openCard);
    expect(ws(workstream.id).currentSessionId).not.toBeNull();
    const session = await waitFor(() => listSessions(engine.store.db, workstream.id)[0]);
    const observer = engine.live.get(session.id)?.observer;
    const { item: second } = engine.inbox.ask({
      projectId: engine.project.id,
      workstreamId: workstream.id,
      sessionId: session.id,
      kind: 'question',
      title: 'Another?',
      body: '',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail: null,
      signal: new AbortController().signal,
    });
    // Triage is held for this one too, so the builder sends it to the stakeholder.
    engine.state.write((ctx) =>
      setInboxRecipients(ctx, second.id, {
        assignees: ['stakeholder'],
        routedBy: RoutedBy.Builder,
        suggestion: null,
      }),
    );
    observer?.onWaitStart(second);
    await engine.runner.idle();

    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'answer', inboxId: first.id },
    });
    expect(task.id).toBe(ws(workstream.id).taskId);
    engine.inbox.answer(first.id, { choice: 'Yes' });
    expect(ws(workstream.id).state).toBe('QUEUED');
    engine.inbox.answer(second.id, { choice: 'A' });
    expect(ws(workstream.id).state).toBe('QUEUED');
  });
});

describe('Runner.parkFor', () => {
  it('parks a live session waiting on a card triage has yet to route', async () => {
    engine = await createTestEngine(
      oneAsk(askHuman('engineering', 'op-park-for-0001')),
      {},
      {},
      triageHeld(),
    );
    routeQuestionsAway(engine);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    expect(ws(workstream.id).currentSessionId).not.toBeNull();
    engine.runner.parkFor(card.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'answer', inboxId: card.id },
    });
  });
});

describe('a question the judge routes after the lane asked', () => {
  it('parks the session once triage sends the card to someone else', async () => {
    engine = await createTestEngine(
      oneAsk(askHuman('product', 'op-triage-park-01')),
      {},
      {},
      {
        openRouter: {
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  model: 'typesafe/jev-1.13',
                  answers: {
                    decision: {
                      type: 'choice',
                      choice: 'category:product',
                      confidence: 0.9,
                      probabilities: { 'category:product': 0.95, nobody: 0.05 },
                    },
                  },
                  usage: { cost: 0 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              ),
            ),
        },
      },
    );
    routeTo('product', ['mark'], false);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    await waitFor(() => (ws(workstream.id).currentSessionId === null ? true : undefined));
    expect(listInbox(engine.store.db, {}).find((c) => c.id === card.id)).toMatchObject({
      routedBy: 'judge',
      assignees: ['mark'],
    });
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'answer', inboxId: card.id },
    });
  });
});

// T4 call 21: a question no rule sends to a person is the builder's, so a lane nobody watches answers it.
describe('a question no route sends to a person', () => {
  it('is answered at once in a lane, with no card left for triage', async () => {
    engine = await createTestEngine(
      oneAsk(askHuman('product', 'op-triage-builder1')),
      {},
      {},
      { openRouter: { fetch: () => Promise.resolve(new Response('{}', { status: 500 })) } },
    );
    // Only a topic route: the question is left to triage, which can name nobody.
    const mark = engine.store.write((ctx) =>
      insertPerson(ctx, {
        handle: 'mark',
        name: 'Mark',
        slack: [{ teamId: 'T1', userId: 'U1', sendMode: 'review', dailyLimit: 10 }],
      }),
    ).value;
    engine.store.write((ctx) =>
      setRoutingRules(ctx, engine.project.id, {
        rules: [{ category: null, area: null, topic: 'billing', personId: mark.id }],
      }),
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listInbox(engine.store.db, {})).toEqual([]);
    expect(listSkipsForWorkstream(engine.store.db, workstream.id)).toMatchObject([
      { toolName: 'ask_human', kind: 'question' },
    ]);
  });
});

/** The judge's triage answer: one route's choice, or nobody, sure of it. */
const triageSays = (choice: string) => ({
  openRouter: {
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'typesafe/jev-1.13',
            answers: {
              decision: {
                type: 'choice',
                choice,
                confidence: 0.9,
                probabilities: { [choice]: 0.95 },
              },
            },
            usage: { cost: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
  },
});

describe('a lane question triage keeps with the builder', () => {
  it.each([['ask_human', askHuman('product', 'op-triage-kept-01'), 'product', 'Charge tax?']])(
    '%s is answered at once, listed, and its card withdrawn',
    async (toolName, ask, category, question) => {
      engine = await createTestEngine(oneAsk(ask), {}, {}, triageSays('nobody'));
      routeTo(category, ['mark'], false);
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      expect(listSkipsForWorkstream(engine.store.db, workstream.id)).toMatchObject([
        { toolName, summary: question, kind: 'question' },
      ]);
    },
  );
});

/** A project-wide route for `category` to Tess, who has no Slack, so her card goes back to the builder. */
function routeToNoSlack(category: string): void {
  engine.state.write((ctx) => {
    const tess = insertPerson(ctx, { handle: 'tess', name: 'Tess' });
    setRoutingRules(ctx, engine.project.id, {
      rules: [{ category: category as 'product', area: null, personId: tess.id }],
    });
  });
}

// A lane nobody watches never waits on the builder: a card handed back to them for want of Slack is answered at once.
describe('a lane question routed to a person with no Slack', () => {
  it('ask_human, by a rule is answered at once, listed, and its card withdrawn', async () => {
    engine = await createTestEngine(oneAsk(askHuman('product', 'op-no-slack-rule1')));
    routeToNoSlack('product');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => ws(workstream.id).state === 'DONE');

    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
    expect(listSkipsForWorkstream(engine.store.db, workstream.id)).toMatchObject([
      { kind: 'question' },
    ]);
  });
});

describe('a task cancelled while its question waits for triage', () => {
  it('cancels the card, and the judge answering later only leaves pending', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine = await createTestEngine(
      oneAsk(askHuman('product', 'op-cancel-triage1')),
      {},
      {},
      {
        openRouter: {
          fetch: async () => {
            await gate;
            return new Response(
              JSON.stringify({
                model: 'typesafe/jev-1.13',
                answers: {
                  decision: {
                    type: 'choice',
                    choice: 'category:product',
                    confidence: 0.9,
                    probabilities: { 'category:product': 0.95, nobody: 0.05 },
                  },
                },
                usage: { cost: 0 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
      },
    );
    routeTo('product', ['mark'], false);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    expect(card.routedBy).toBe('triage_pending');

    await engine.runner.cancel(workstream.id);
    const cancelled = listInbox(engine.store.db, {}).find((c) => c.id === card.id);
    expect(cancelled?.state).toBe('CANCELLED');

    release();
    await waitFor(() => {
      const now = listInbox(engine.store.db, {}).find((c) => c.id === card.id);
      return now?.routedBy === 'triage_pending' ? undefined : now;
    });
    const after = listInbox(engine.store.db, {}).find((c) => c.id === card.id);
    expect(after).toMatchObject({ state: 'CANCELLED', routedBy: 'builder', assignees: ['me'] });
  });
});

describe('a task waiting on a person', () => {
  it('lets go of its claims so another task can take the area, and asks for them again on the answer', async () => {
    engine = await createTestEngine(oneAsk(askHuman('product', 'op-yield-ask-1')));
    routeTo('product', ['mark']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    await engine.runner.idle();

    await waitFor(() => (activeClaims(engine.store.db, workstream.id).length === 0 ? true : false));
    const other = engine.addTask('Beta');
    const ask = {
      projectId: engine.project.id,
      workstreamId: other.workstream.id,
      requests: [{ kind: ClaimKind.Area, name: 'api' }],
    };
    expect(claimConflict(engine.store.db, ask)).toBeNull();

    // Beta takes the area; the answer queues Alpha, which then waits for it like any queued task.
    engine.launch(other.workstream.id);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    expect(ws(workstream.id).state).toBe('QUEUED');
    expect(claimConflict(engine.store.db, { ...ask, workstreamId: workstream.id })).toMatchObject({
      name: 'api',
      heldBy: other.workstream.id,
    });
  });
});
