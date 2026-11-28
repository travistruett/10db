import {
  AcceptanceChoice,
  Answerer,
  InboxState,
  type AcceptanceDetail,
  type InboxItemId,
} from '@10db/contracts';
import { createTestStore, getTask, updateInboxItem, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { acceptedCriteria, applyAcceptanceAnswer, raiseAcceptanceCard } from './card';

let close: () => void;
let base: Store;
let state: StateStore;
let inbox: InboxService;

beforeEach(() => {
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  inbox = createInboxService({
    state,
    onParkedAnswer: () => undefined,
    onAcceptanceAnswer: (ctx, item, answer) => {
      applyAcceptanceAnswer(ctx, item, answer);
    },
  });
});
afterEach(() => {
  close();
});

const unproven = (criterion: string): AcceptanceDetail => ({
  criteria: [{ criterion, verdict: 'not_met', note: 'read as not met' }],
  unasked: null,
  sentBack: false,
});

function raise(criterion: string) {
  const ws = seedWorkstream(base);
  const card = state.write((ctx) =>
    raiseAcceptanceCard(ctx, {
      workstreamId: ws.workstream.id,
      projectId: ws.project.id,
      taskTitle: ws.task.title,
      detail: unproven(criterion),
      reviewFollows: false,
      evalLines: [],
    }),
  );
  return { ws, card };
}

describe('an acceptance card', () => {
  it('is answered Accept or Drop only by the builder, and only the builder accepts a criterion', () => {
    const { ws, card } = raise('it works');
    expect(card.recommendation).toBeNull();
    expect(card.options.map((o) => o.label)).toEqual([
      AcceptanceChoice.Accept,
      AcceptanceChoice.Drop,
      AcceptanceChoice.SendBack,
    ]);
    for (const answerer of [Answerer.Agent, Answerer.Rule, Answerer.Stakeholder]) {
      expect(() => inbox.answer(card.id, { choice: AcceptanceChoice.Accept }, answerer)).toThrow(
        /Only the builder/,
      );
    }
    expect(() => inbox.answer(card.id, { choice: AcceptanceChoice.Drop }, Answerer.Agent)).toThrow(
      /Only the builder/,
    );
    expect(acceptedCriteria(state.db, ws.workstream.id).size).toBe(0);

    inbox.answer(card.id, { choice: AcceptanceChoice.Accept }, Answerer.Builder);
    expect([...acceptedCriteria(state.db, ws.workstream.id)]).toEqual(['it works']);
  });

  it('counts no answer an agent recorded, even one that got past the service', () => {
    const { ws, card } = raise('it works');
    const answerAs = (id: InboxItemId, answerer: Answerer) =>
      state.write((ctx) =>
        updateInboxItem(ctx, id, {
          state: InboxState.Resolved,
          answer: { choice: AcceptanceChoice.Accept, answerer },
        }),
      );
    answerAs(card.id, Answerer.Agent);
    expect(acceptedCriteria(state.db, ws.workstream.id).size).toBe(0);
  });

  it('drops the criteria from the task when the builder answers Drop', () => {
    const { ws, card } = raise('it works');
    inbox.answer(card.id, { choice: AcceptanceChoice.Drop }, Answerer.Builder);
    expect(getTask(state.db, ws.task.id).acceptanceCriteria).toEqual([]);
  });
});
