import { InboxState } from '@10db/contracts';
import { createTestStore, listInbox, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, createJudgeOutageCard } from '../inbox';

import { silentLogger } from '../log';
import { createJudge, createJudgeOutageWatch, type JudgeRequest } from './index';

const request: JudgeRequest = {
  decision: 'shape_record',
  state: 'Task: add a label.',
  question: 'Does this change need a review?',
  options: ['review', 'skip'],
};

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let status: number;

function build() {
  const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const watch = createJudgeOutageWatch({
    clock,
    logger: silentLogger,
    sink: createJudgeOutageCard({ state, inbox }),
  });
  return createJudge({
    state,
    clock,
    fetch: () =>
      Promise.resolve(
        status === 200
          ? new Response(
              JSON.stringify({
                id: 'g',
                model: 'typesafe/jev-1.13',
                answers: {
                  decision: {
                    type: 'choice',
                    choice: 'skip',
                    confidence: 0.9,
                    probabilities: { review: 0.1, skip: 0.9 },
                  },
                },
                usage: { cost: 0 },
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
              status,
            }),
      ),
    readCredential: () => Promise.resolve({ kind: 'openrouter', key: 'router-test-key-0123' }),
    decisionModelIds: () => new Set(['typesafe/jev-1.13']),
    off: false,
    logger: silentLogger,
    onCallHealth: watch,
  });
}

const cards = () =>
  listInbox(state.db, { states: [InboxState.Open, InboxState.Resolved] }).filter(
    (c) => c.title === "10db's judge can't answer",
  );

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  status = 402;
  seedProject(store);
});
afterEach(() => {
  close();
});

describe('a judge outage', () => {
  it('raises one card for an out-of-credits account, keeps it single while down, and closes it on an answer', async () => {
    const judge = build();
    await judge.choose(request);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ state: InboxState.Open });
    expect(cards()[0]?.body).toContain('OpenRouter says the account has no credits');

    for (let i = 0; i < 6; i += 1) await judge.choose(request);
    expect(cards()).toHaveLength(1);

    status = 200;
    await judge.choose(request);
    expect(cards()).toMatchObject([{ state: InboxState.Resolved }]);
  });

  it('raises a card only after repeated failures of an error that may clear', async () => {
    status = 500;
    const judge = build();
    for (let i = 0; i < 4; i += 1) await judge.choose(request);
    expect(cards()).toHaveLength(0);
    await judge.choose(request);
    expect(cards()).toHaveLength(1);
  });
});
