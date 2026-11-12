import { RoutedBy, type WorkstreamId } from '@10db/contracts';
import {
  getWorkstream,
  insertPerson,
  listInbox,
  listSessions,
  patchAccount,
  setInboxRecipients,
  setRoutingRules,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
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
const askUser: FakeStep = {
  do: 'tool',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Ship it?',
        header: 'Ship',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        multiSelect: false,
      },
    ],
  },
};

/** Mark and Ana, with an area route for `category` on the `api` area that the engine's tasks claim. */
function routeTo(category: string, handles: ('mark' | 'ana')[], areaScoped = true) {
  const person = (handle: string, name: string, userId: string) =>
    engine.store.write((ctx) =>
      insertPerson(ctx, {
        handle,
        name,
        slack: { teamId: 'T1', userId, sendMode: 'review', dailyLimit: 10 },
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

  it('parks the same way for AskUserQuestion on a route for other', async () => {
    engine = await createTestEngine(oneAsk(askUser));
    routeTo('other', ['mark']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(openCard);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', currentSessionId: null });
  });

  it('parks the same way on a Codex account', async () => {
    engine = await createTestEngine(
      oneAsk(askHuman('product', 'op-routed-codex1')),
      {},
      {},
      { account: { kind: 'codex_signin', label: 'ChatGPT plan' } },
    );
    engine.state.write((ctx) =>
      patchAccount(ctx, engine.project.accountId, {
        expectedIdentity: 'chatgpt@example.com · ws-1',
      }),
    );
    routeTo('product', ['mark']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(openCard);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', currentSessionId: null });
  });

  it('parks for a tie of Mark and Ana', async () => {
    engine = await createTestEngine(oneAsk(askHuman('product', 'op-routed-tie-01')));
    routeTo('product', ['mark', 'ana']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    await engine.runner.idle();
    expect(card.assignees).toEqual(['mark', 'ana']);
    expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', currentSessionId: null });
  });

  it('still waits live for a builder question, until the timer', async () => {
    engine = await createTestEngine(oneAsk(askHuman('engineering', 'op-builder-ask-1')));
    routeTo('product', ['mark']);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(openCard);
    engine.clock.advance(9 * 60_000);
    expect(ws(workstream.id).currentSessionId).not.toBeNull();
    engine.clock.advance(60_000);
    await engine.runner.idle();
    expect(ws(workstream.id).currentSessionId).toBeNull();
  });

  it('parks a session already waiting on a builder card when it asks a second, routed question', async () => {
    engine = await createTestEngine(oneAsk(askHuman('engineering', 'op-builder-ask-2')));
    routeTo('product', ['mark']);
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
    expect(second.assignees).toEqual(['mark']);
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

  it('reads the card again on wait start, so a card rerouted since the ask parks', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'await_message', contains: 'never' }], [turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const session = await waitFor(() => listSessions(engine.store.db, workstream.id)[0]);
    const { item: stale } = engine.inbox.ask({
      projectId: engine.project.id,
      workstreamId: workstream.id,
      sessionId: session.id,
      kind: 'question',
      title: 'Rerouted?',
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
    expect(stale.assignees).toEqual(['me']);
    engine.state.write((ctx) =>
      setInboxRecipients(ctx, stale.id, {
        assignees: ['mark'],
        routedBy: RoutedBy.Builder,
        suggestion: null,
      }),
    );
    engine.live.get(session.id)?.observer.onWaitStart(stale);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', currentSessionId: null });
  });
});

describe('Runner.parkFor', () => {
  it('parks a live session waiting on a builder card', async () => {
    engine = await createTestEngine(oneAsk(askHuman('engineering', 'op-park-for-0001')));
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

  it('parks every session whose identical ask folded into the card', async () => {
    engine = await createTestEngine({
      Alpha: [[askHuman('engineering', 'op-folded-ask-001'), turn], [turn]],
      Beta: [[askHuman('engineering', 'op-folded-ask-002'), turn], [turn]],
    });
    const alpha = engine.addTask('Alpha');
    const beta = engine.addTask('Beta', ['ui']);
    engine.launch(alpha.workstream.id);
    engine.launch(beta.workstream.id);
    const card = await waitFor(() => {
      const open = listInbox(engine.store.db, { states: ['OPEN'] });
      return open.length === 1 && open[0]?.targets.length === 2 ? open[0] : undefined;
    });
    expect(ws(alpha.workstream.id).currentSessionId).not.toBeNull();
    expect(ws(beta.workstream.id).currentSessionId).not.toBeNull();

    engine.runner.parkFor(card.id);
    await engine.runner.idle();
    for (const w of [alpha.workstream, beta.workstream])
      expect(ws(w.id)).toMatchObject({
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
