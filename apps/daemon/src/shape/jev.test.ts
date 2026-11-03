import {
  JudgeDecision,
  mintId,
  PlanDraft,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type ShapeMessageId,
} from '@10db/contracts';
import {
  insertShapeMessage,
  listJudgeCalls,
  listShadowAnswers,
  listShapeProposals,
  patchShape,
  setShapeJevOptIn,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { Judge, JudgeRequest } from '../judge';
import { silentLogger } from '../log';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { convertProposals } from './convert';
import { createShapeJev, shadowAgreement } from './jev';
import { dropProposal, editProposal, reconcileDraft } from './rounds';

// Shape spec §9: Jev's three Shape decisions run in shadow, only for a project that opted in, and
// are scored against what happened.

let c: ConversationFixture;
let state: StateStore;
let asked: JudgeRequest[];
/** What the fake judge answers, per decision. */
let answers: Partial<Record<JudgeDecision, string>>;

const fakeJudge: Judge = {
  off: false,
  choose: (req) => {
    asked.push(req);
    return Promise.resolve({
      kind: 'answered',
      choice: answers[req.decision] ?? 'no',
      confidence: 0.9,
      model: 'typesafe/jev-1.13',
      latencyMs: 5,
      costUsd: 0.0002,
      callId: mintId('JudgeCall'),
    });
  },
};

beforeEach(() => {
  c = seedConversation();
  state = createStateStore(c.store, createEventBus());
  asked = [];
  answers = {};
});
afterEach(() => {
  c.close();
});

const jev = (judge: Judge = fakeJudge) =>
  createShapeJev({ state, judge, log: silentLogger, now: () => new Date() });
const optIn = (enabled = true): void => {
  state.write((ctx) => {
    setShapeJevOptIn(ctx, c.project.id, enabled);
  });
};
const note = (kind: ShapeMessageKind): ShapeMessageId =>
  state.write((ctx) =>
    insertShapeMessage(ctx, c.shape.id, { author: ShapeMessageAuthor.Note, kind, body: kind }),
  ).id;

describe('the opt-in', () => {
  it('makes no judge call and logs nothing for a project that has not opted in', async () => {
    const m = c.say('We decided to keep the board comfortable.');
    await jev().heard(c.shape.id, m);
    expect(asked).toEqual([]);
    expect(listShadowAnswers(c.store.db)).toEqual([]);
    expect(listJudgeCalls(c.store.db, 100)).toEqual([]);
  });

  it('makes no call when the project turned it back off', async () => {
    optIn(true);
    optIn(false);
    await jev().heard(c.shape.id, c.say());
    expect(asked).toEqual([]);
  });

  it('asks the three decisions in shadow once a project opts in, with the message fenced as data', async () => {
    optIn();
    answers = { [JudgeDecision.ShapeRecord]: 'yes' };
    const m = c.say('We decided to keep the board comfortable.');
    await jev().heard(c.shape.id, m);
    expect(asked.map((r) => r.decision).sort()).toEqual(
      ['shape_elsewhere', 'shape_ready', 'shape_record'].sort(),
    );
    expect(asked[0]?.state).toContain('We decided to keep the board comfortable.');
    expect(asked[0]?.options).toEqual(['yes', 'no']);
    expect(
      listShadowAnswers(c.store.db)
        .map((r) => [r.decision, r.answer, r.messageId])
        .sort(),
    ).toEqual(
      [
        ['shape_elsewhere', 'no', m],
        ['shape_ready', 'no', m],
        ['shape_record', 'yes', m],
      ].sort(),
    );
  });

  it('stops asking shape_ready once the builder has pressed Propose', async () => {
    optIn();
    state.write((ctx) => {
      patchShape(ctx, c.shape.id, { proposeUnlocked: true });
    });
    await jev().heard(c.shape.id, c.say());
    expect(asked.map((r) => r.decision).sort()).toEqual(['shape_elsewhere', 'shape_record']);
  });

  it('makes no call when the daemon runs with the judge off', async () => {
    optIn();
    await jev({ ...fakeJudge, off: true }).heard(c.shape.id, c.say());
    expect(asked).toEqual([]);
  });
});

describe('scoring', () => {
  const agreement = (decision: JudgeDecision, now = new Date()) =>
    must(
      shadowAgreement(c.store.db, now).find((a) => a.decision === decision),
      decision,
    );

  function record(m: ShapeMessageId, key: string): void {
    state.write((ctx) => {
      patchShape(ctx, c.shape.id, { proposeUnlocked: true });
      const out = reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          records: [
            {
              key,
              kind: 'decision',
              scope: 'project',
              question: 'Which density?',
              choice: 'Comfortable',
              rationale: 'Readable.',
              sourceMessageIds: [m],
            },
          ],
          questions: [
            { key: `q-${key}`, text: 'Ask design?', for: 'design', sourceMessageIds: [m] },
          ],
        }),
      );
      if (!out.ok) throw new Error(out.errors.join('; '));
    });
  }
  const rowOf = (key: string) =>
    must(
      listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === key),
      key,
    );

  it.each([
    ['a citing record still pending is not scored', 'pending', 0, 0],
    ['a citing record converted agrees with yes', 'converted', 1, 1],
    ['a citing record kept (pinned) agrees with yes', 'kept', 1, 1],
    ['a citing record dropped disagrees with yes once the conversation converts', 'dropped', 1, 0],
  ] as const)('shape_record: %s', async (_name, outcome, scored, agreed) => {
    optIn();
    answers = { [JudgeDecision.ShapeRecord]: 'yes' };
    const m = c.say('We decided to keep the board comfortable.');
    await jev().heard(c.shape.id, m);
    record(m, 'density');
    if (outcome === 'converted')
      state.write((ctx) => convertProposals(ctx, c.shape.id, [rowOf('density').id]));
    if (outcome === 'kept')
      state.write((ctx) => {
        editProposal(ctx, rowOf('density').id, { choice: 'Comfortable rows' });
      });
    if (outcome === 'dropped')
      state.write((ctx) => {
        dropProposal(ctx, rowOf('density').id);
        patchShape(ctx, c.shape.id, { state: 'converted' });
      });
    expect(agreement(JudgeDecision.ShapeRecord)).toMatchObject({ answered: 1, scored, agreed });
  });

  it('shape_record: a message nothing cites counts as no once the conversation is idle for 7 days', async () => {
    optIn();
    await jev().heard(c.shape.id, c.say('Hello.'));
    expect(agreement(JudgeDecision.ShapeRecord)).toMatchObject({ scored: 0 });
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(agreement(JudgeDecision.ShapeRecord, later)).toMatchObject({ scored: 1, agreed: 1 });
  });

  it.each([
    ['Propose pressed within his next two messages', 1, true],
    ['Propose pressed only after his third message', 3, false],
  ])('shape_ready: %s', async (_name, before, pressed) => {
    optIn();
    answers = { [JudgeDecision.ShapeReady]: 'yes' };
    const m = c.say('That is everything.');
    await jev().heard(c.shape.id, m);
    for (let i = 0; i < before; i += 1) c.say(`more ${String(i)}`);
    note(ShapeMessageKind.Propose);
    expect(agreement(JudgeDecision.ShapeReady)).toMatchObject({
      scored: 1,
      agreed: pressed ? 1 : 0,
    });
  });

  it('shape_elsewhere: a citing question kept agrees with yes', async () => {
    optIn();
    answers = { [JudgeDecision.ShapeElsewhere]: 'yes' };
    const m = c.say('Ask design whether compact is fine.');
    await jev().heard(c.shape.id, m);
    record(m, 'density');
    expect(agreement(JudgeDecision.ShapeElsewhere)).toMatchObject({ scored: 0 });
    state.write((ctx) => {
      editProposal(ctx, rowOf('q-density').id, { text: 'Ask design: is compact fine?' });
    });
    expect(agreement(JudgeDecision.ShapeElsewhere)).toMatchObject({ scored: 1, agreed: 1 });
  });

  it('can show only after 20 scored answers with 75% agreeing', async () => {
    optIn();
    for (let i = 0; i < 20; i += 1) await jev().heard(c.shape.id, c.say(`m${String(i)}`));
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(agreement(JudgeDecision.ShapeRecord, later)).toEqual({
      decision: 'shape_record',
      answered: 20,
      scored: 20,
      agreed: 20,
      canShow: true,
    });
  });
});
