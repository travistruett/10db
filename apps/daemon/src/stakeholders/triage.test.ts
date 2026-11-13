import {
  EventType,
  InboxState,
  type InboxItemId,
  type JudgeOutcome,
  type PersonDto,
} from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  insertInboxItem,
  insertJudgeCall,
  insertPerson,
  listJudgeCalls,
  listRoutingRules,
  setInboxRecipients,
  setRoutingRules,
  updateInboxItem,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { Judge, JudgeAnswer, JudgeRequest } from '../judge';
import { silentLogger } from '../log';
import { createTriage } from './triage';

let store: Store;
let close: () => void;
let state: StateStore;
let events: string[];
let routed: InboxItemId[];

beforeEach(() => {
  ({ store, close } = createTestStore());
  const bus = createEventBus();
  events = [];
  bus.subscribe((e) => {
    if (e.type === EventType.InboxTriaged) events.push(`${e.type}:${JSON.stringify(e.data)}`);
  });
  state = createStateStore(store, bus);
  routed = [];
});
afterEach(() => {
  close();
});

function world() {
  const ws = seedWorkstream(store);
  const person = (handle: string): PersonDto =>
    store.write((ctx) => insertPerson(ctx, { handle, name: handle })).value;
  const mark = person('mark');
  const ana = person('ana');
  const sarah = person('sarah');
  store.write((ctx) =>
    setRoutingRules(ctx, ws.project.id, {
      rules: [
        { category: 'product', area: null, personId: mark.id },
        { category: 'product', area: null, personId: ana.id },
        { category: null, area: null, topic: 'billing', personId: sarah.id },
      ],
    }),
  );
  const topicRoute = listRoutingRules(store.db, ws.project.id).find((r) => r.topic === 'billing');
  const card = (topic: string | null = null) =>
    store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: ws.project.id,
        kind: 'question',
        title: 'Charge tax?',
        body: 'For EU customers',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: ws.workstream.id, sessionId: null }],
        topic,
        pendingTriage: true,
      }),
    ).value;
  return { ws, mark, ana, sarah, card, topicKey: `topic:${topicRoute?.id ?? ''}` };
}

type Reply =
  | { choice: string; confidence: number }
  | { fallback: 'timeout' | 'no_key' | 'error' }
  | { throws: true };

function judgeReplying(reply: Reply, onAsked?: (req: JudgeRequest) => void): Judge {
  return {
    off: false,
    choose: (req) => {
      onAsked?.(req);
      if ('throws' in reply) return Promise.reject(new Error('judge exploded'));
      const outcome: JudgeOutcome =
        'fallback' in reply
          ? 'fallback_timeout'
          : reply.confidence >= 0.8
            ? 'acted'
            : 'below_floor';
      const callId = state.write((ctx) =>
        insertJudgeCall(ctx, {
          decision: req.decision,
          model: 'typesafe/jev-1.13',
          state: req.state,
          question: req.question,
          answer: 'choice' in reply ? reply.choice : null,
          confidence: 'choice' in reply ? reply.confidence : null,
          outcome,
          latencyMs: 10,
          costUsd: null,
          workstreamId: null,
          taskId: req.taskId ?? null,
        }),
      );
      const answer: JudgeAnswer =
        'fallback' in reply
          ? { kind: 'fallback', reason: reply.fallback, detail: 'x', callId }
          : {
              kind: 'answered',
              choice: reply.choice,
              confidence: reply.confidence,
              model: 'typesafe/jev-1.13',
              latencyMs: 10,
              costUsd: null,
              callId,
            };
      return Promise.resolve(answer);
    },
  };
}

const triageWith = (judge: Judge, log = silentLogger) =>
  createTriage({ state, judge, log, afterRouted: (id) => routed.push(id) });

const read = (id: InboxItemId) => getInboxItem(store.db, id);
const outcomes = () => listJudgeCalls(store.db, 5).map((c) => c.outcome);

describe('triage', () => {
  it('routes a confident topic to its people, and logs the call as acted', async () => {
    const w = world();
    const card = w.card('billing');
    expect(card).toMatchObject({ routedBy: 'triage_pending', assignees: ['me'] });
    await triageWith(judgeReplying({ choice: w.topicKey, confidence: 0.95 })).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'judge', assignees: ['sarah'] });
    expect(outcomes()).toEqual(['acted']);
    expect(events).toEqual(['inbox.triaged:{"routedBy":"judge","toBuilder":false}']);
    expect(routed).toEqual([card.id]);
  });

  it('routes a confident category to everyone on it, in routing order', async () => {
    const w = world();
    const card = w.card();
    await triageWith(judgeReplying({ choice: 'category:product', confidence: 0.9 })).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'judge', assignees: ['mark', 'ana'] });
  });

  it('keeps the builder on a confident nobody, with no suggestion', async () => {
    const w = world();
    const card = w.card();
    await triageWith(judgeReplying({ choice: 'nobody', confidence: 0.9 })).run(card.id);
    expect(read(card.id)).toMatchObject({
      routedBy: 'builder',
      assignees: ['me'],
      routeSuggestion: null,
    });
    expect(events).toEqual(['inbox.triaged:{"routedBy":"builder","toBuilder":true}']);
    expect(routed).toEqual([card.id]);
  });

  it('only suggests the top route below the floor', async () => {
    const w = world();
    const card = w.card();
    await triageWith(judgeReplying({ choice: w.topicKey, confidence: 0.64 })).run(card.id);
    expect(read(card.id)).toMatchObject({
      routedBy: 'builder',
      assignees: ['me'],
      routeSuggestion: { personIds: [w.sarah.id], confidence: 0.64 },
    });
    expect(outcomes()).toEqual(['below_floor']);
    expect(events).toEqual(['inbox.triaged:{"routedBy":"builder","toBuilder":true}']);
  });

  it('suggests nothing when nobody is the top choice below the floor', async () => {
    const w = world();
    const card = w.card();
    await triageWith(judgeReplying({ choice: 'nobody', confidence: 0.5 })).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'builder', routeSuggestion: null });
  });

  it.each([
    ['a timeout', { fallback: 'timeout' }],
    ['no key', { fallback: 'no_key' }],
    ['a judge that throws', { throws: true }],
  ] as const)('falls back to the lane topic on %s', async (_name, reply) => {
    const w = world();
    const card = w.card('billing');
    await triageWith(judgeReplying(reply)).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'rule', assignees: ['sarah'] });
    expect(routed).toEqual([card.id]);
  });

  it('falls back to the category routes when the lane named no topic', async () => {
    const w = world();
    const card = w.card();
    await triageWith(judgeReplying({ fallback: 'timeout' })).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'rule', assignees: ['mark', 'ana'] });
  });

  it('falls back when a store read throws inside the run', async () => {
    const w = world();
    const card = w.card('billing');
    let broke = true;
    const judge = judgeReplying({ choice: w.topicKey, confidence: 0.95 }, () => {
      if (broke) {
        broke = false;
        throw new Error('db hiccup');
      }
    });
    await triageWith(judge).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'rule', assignees: ['sarah'] });
  });

  it('falls back when the chosen route was removed meanwhile', async () => {
    const w = world();
    const card = w.card();
    const judge = judgeReplying({ choice: w.topicKey, confidence: 0.95 }, () => {
      store.write((ctx) =>
        setRoutingRules(ctx, w.ws.project.id, {
          rules: [{ category: 'product', area: null, personId: w.mark.id }],
        }),
      );
    });
    await triageWith(judge).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'rule', assignees: ['mark'] });
  });

  it('keeps an answer given before the judge replied, and only leaves pending', async () => {
    const w = world();
    const card = w.card();
    const judge = judgeReplying({ choice: 'category:product', confidence: 0.95 }, () => {
      store.write((ctx) =>
        updateInboxItem(ctx, card.id, {
          state: InboxState.Answered,
          answer: { choice: 'Yes' },
        }),
      );
    });
    await triageWith(judge).run(card.id);
    expect(read(card.id)).toMatchObject({
      routedBy: 'builder',
      state: 'ANSWERED',
      answer: { choice: 'Yes' },
      assignees: ['me'],
    });
  });

  it('leaves a card the builder routed meanwhile as it is, and only records the call', async () => {
    const w = world();
    const card = w.card();
    const judge = judgeReplying({ choice: 'category:product', confidence: 0.95 }, () => {
      store.write((ctx) =>
        setInboxRecipients(ctx, card.id, {
          assignees: ['sarah'],
          routedBy: 'builder',
          suggestion: null,
        }),
      );
    });
    await triageWith(judge).run(card.id);
    expect(read(card.id)).toMatchObject({ routedBy: 'builder', assignees: ['sarah'] });
    expect(outcomes()).toEqual(['acted']);
    expect(routed).toEqual([]);
  });

  it('settles a card once: a second run does nothing and calls the judge no more', async () => {
    const w = world();
    const card = w.card();
    let asked = 0;
    const triage = triageWith(
      judgeReplying({ choice: 'category:product', confidence: 0.9 }, () => (asked += 1)),
    );
    await triage.run(card.id);
    await triage.run(card.id);
    expect(asked).toBe(1);
    expect(routed).toEqual([card.id]);
  });

  it('sends the judge the card, the options with their criteria, and the lane tags', async () => {
    const w = world();
    const card = w.card('billing');
    let seen: JudgeRequest | undefined;
    await triageWith(
      judgeReplying({ choice: 'nobody', confidence: 0.9 }, (req) => {
        seen = req;
      }),
    ).run(card.id);
    expect(seen?.decision).toBe('question_route');
    expect(seen?.options).toEqual(['category:product', w.topicKey, 'nobody']);
    expect(seen?.criteria?.['category:product']).toMatch(/Answered by mark and ana\.$/);
    expect(JSON.parse(seen?.state ?? '{}')).toMatchObject({
      title: 'Charge tax?',
      category: 'product',
      topic: 'billing',
      task: 'Alpha',
    });
  });
});
