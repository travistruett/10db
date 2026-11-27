import { InboxState } from '@10db/contracts';
import { createTestStore, listInbox, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { noticesPosted } from '../../test/notices-posted';
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
let message = 'Insufficient credits';

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
          : new Response(JSON.stringify({ error: { message } }), {
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

const notices = () => noticesPosted(state.db).filter((n) => n.key === 'judge-outage');

const cards = () =>
  listInbox(state.db, { states: [InboxState.Open, InboxState.Resolved] }).filter((c) =>
    c.title.startsWith('Unattended work skips more: '),
  );

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  status = 402;
  message = 'Insufficient credits';
  seedProject(store);
});
afterEach(() => {
  close();
});

describe('a judge outage', () => {
  it('posts one notice for a lasting 5xx and no card, then raises a dead account as a card at once, closes it after three answers, and raises another', async () => {
    const judge = build();
    status = 500;
    for (let i = 0; i < 4; i += 1) await judge.choose(request);
    expect(notices()).toHaveLength(0);
    for (let i = 0; i < 4; i += 1) await judge.choose(request);
    expect(cards()).toHaveLength(0);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.body).not.toContain('OpenRouter OpenRouter');
    expect(notices()[0]?.body).toContain('Decisions run on OpenRouter, typesafe/jev-1.13.');

    // No credits is the builder's to fix: a card, though a notice for the 5xx is already out.
    status = 402;
    for (let i = 0; i < 6; i += 1) await judge.choose(request);
    expect(cards()).toMatchObject([{ state: InboxState.Open }]);
    expect(cards()[0]?.body).toContain('says the account has no credits');
    expect(notices()).toHaveLength(1);

    status = 200;
    await judge.choose(request);
    await judge.choose(request);
    expect(cards()).toMatchObject([{ state: InboxState.Open }]);
    await judge.choose(request);
    expect(cards()).toMatchObject([{ state: InboxState.Resolved }]);

    clock.advance(31 * 60 * 1000);
    status = 400;
    message = 'Your credit balance is too low';
    await judge.choose(request);
    expect(cards().map((c) => c.state)).toEqual([InboxState.Resolved, InboxState.Open]);
    expect(cards()[1]?.body).toContain('has no credits');
  });

  it('raises nothing for a tail of failures among answers, and raises once nothing has answered for two minutes', async () => {
    const judge = build();
    for (let minute = 0; minute < 10; minute += 1) {
      status = 200;
      for (let i = 0; i < 6; i += 1) await judge.choose(request);
      // A burst of slow answers under load: five in a row, but fewer than the answers around them.
      status = 500;
      for (let i = 0; i < 5; i += 1) await judge.choose(request);
      clock.advance(60 * 1000);
    }
    expect(cards()).toHaveLength(0);

    status = 200;
    await judge.choose(request);
    status = 500;
    await judge.choose(request);
    clock.advance(119 * 1000);
    await judge.choose(request);
    expect(notices()).toHaveLength(0);
    clock.advance(1000);
    await judge.choose(request);
    expect(notices()).toHaveLength(1);
    expect(cards()).toHaveLength(0);
  });

  it('cards a 401 at once, with no notice', async () => {
    const judge = build();
    status = 401;
    await judge.choose(request);
    expect(cards()).toMatchObject([{ state: InboxState.Open }]);
    expect(cards()[0]?.body).toContain('rejected the key');
    expect(notices()).toHaveLength(0);
  });
});
