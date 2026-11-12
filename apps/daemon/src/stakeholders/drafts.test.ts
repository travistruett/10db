import { InboxState, RoutedBy, type PersonDto } from '@10db/contracts';
import {
  closeSend,
  createTestStore,
  getInboxItem,
  insertInboxItem,
  insertPerson,
  sendForCard,
  setInboxRecipients,
  setRoutingRules,
  updateInboxItem,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { silentLogger } from '../log';
import { draftFor, sweepDrafts, type DraftDeps } from './drafts';

let store: Store;
let close: () => void;
let afterDrafts: string[];
beforeEach(() => {
  ({ store, close } = createTestStore());
  afterDrafts = [];
});
afterEach(() => {
  close();
});

const contact = (userId: string) => ({
  teamId: 'T1',
  userId,
  sendMode: 'review' as const,
  dailyLimit: 10,
});

const deps = (over: Partial<DraftDeps> = {}): DraftDeps => ({
  projectName: 'demo',
  goalTitle: null,
  builderName: 'Travis',
  afterDraft: (id) => afterDrafts.push(id),
  log: silentLogger,
  ...over,
});

interface CardOptions {
  kind?: 'question' | 'permission';
  body?: string;
  pending?: boolean;
}

function world() {
  const ws = seedWorkstream(store);
  const person = (handle: string, slack: boolean): PersonDto =>
    store.write((ctx) =>
      insertPerson(ctx, {
        handle,
        name: handle.charAt(0).toUpperCase() + handle.slice(1),
        ...(slack ? { slack: contact(`U-${handle}`) } : {}),
      }),
    ).value;
  const builder = store.write((ctx) =>
    insertPerson(ctx, { handle: 'me', name: 'Travis', isBuilder: true }),
  ).value;
  const mark = person('mark', true);
  const ana = person('ana', true);
  const dana = person('dana', false);
  const route = (people: PersonDto[], area: string | null = 'api') =>
    store.write((ctx) =>
      setRoutingRules(ctx, ws.project.id, {
        rules: people.map((p) => ({ category: 'product' as const, area, personId: p.id })),
      }),
    );
  const newCard = (ctx: Parameters<Parameters<Store['write']>[0]>[0], over: CardOptions) =>
    insertInboxItem(ctx, {
      projectId: ws.project.id,
      kind: over.kind ?? 'question',
      title: 'Charge tax?',
      body: over.body ?? 'For EU customers',
      options: [
        { label: 'Yes', description: '' },
        { label: 'No', description: '' },
      ],
      recommendation: 'Yes',
      category: 'product',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: ws.workstream.id, sessionId: null }],
      ...(over.pending === true ? { pendingTriage: true } : {}),
    });
  const insert = (over: CardOptions = {}) => store.write((ctx) => newCard(ctx, over)).value;
  /** The card is inserted and drafted in one write, as the daemon does. */
  const insertAndDraft = (over: CardOptions = {}, d: DraftDeps = deps()) =>
    store.write((ctx) => {
      const card = newCard(ctx, over);
      return { card, after: draftFor(ctx, card, d) };
    }).value;
  return { ws, builder, mark, ana, dana, route, insert, insertAndDraft };
}

describe('draftFor', () => {
  it('writes the message in the same transaction as a routed card, and calls afterDraft after it', () => {
    const w = world();
    w.route([w.mark]);
    const { card, after } = w.insertAndDraft();
    const send = sendForCard(store.db, card.id);
    expect(send).toMatchObject({ state: 'draft', hits: [], people: [{ userId: 'U-mark' }] });
    expect(send?.text).toContain("Travis's 10db build of *demo* has a question for you.");
    expect(afterDrafts).toEqual([]);
    after?.();
    expect(afterDrafts).toEqual([card.id]);
  });

  it('holds both recipients of a tie, named in routing order', () => {
    const w = world();
    w.route([w.ana, w.mark]);
    const { card } = w.insertAndDraft();
    const send = sendForCard(store.db, card.id);
    expect(send?.people.map((p) => p.userId)).toEqual(['U-ana', 'U-mark']);
    expect(send?.text).toContain('has a question for Ana and Mark.');
  });

  it('leaves the card written, without a draft and with the builder, when composing throws', () => {
    const w = world();
    w.route([w.mark]);
    const { card, after } = w.insertAndDraft(
      {},
      deps({
        compose: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(after).toBeNull();
    expect(sendForCard(store.db, card.id)).toBeNull();
    expect(getInboxItem(store.db, card.id)).toMatchObject({
      state: 'OPEN',
      assignees: ['me'],
      routedBy: 'builder',
      detail: { draftFailed: true },
    });
  });

  it('gives a recipient with no Slack contact no draft, and the card to the builder', () => {
    const w = world();
    w.route([w.dana]);
    const { card } = w.insertAndDraft();
    expect(sendForCard(store.db, card.id)).toBeNull();
    expect(getInboxItem(store.db, card.id)).toMatchObject({
      assignees: ['me'],
      routedBy: 'builder',
    });
  });

  it('gives a tie with one recipient lacking a contact to the builder too', () => {
    const w = world();
    w.route([w.mark, w.dana]);
    const { card } = w.insertAndDraft();
    expect(sendForCard(store.db, card.id)).toBeNull();
    expect(getInboxItem(store.db, card.id).assignees).toEqual(['me']);
  });

  it('never drafts a permission card, or a builder card', () => {
    const w = world();
    w.route([w.mark]);
    expect(sendForCard(store.db, w.insertAndDraft({ kind: 'permission' }).card.id)).toBeNull();
    w.route([]);
    expect(sendForCard(store.db, w.insertAndDraft().card.id)).toBeNull();
  });

  it('gives a card waiting for triage none, and one once it is routed', () => {
    const w = world();
    w.route([w.mark], null);
    const { card } = w.insertAndDraft({ pending: true });
    expect(card.routedBy).toBe(RoutedBy.TriagePending);
    expect(sendForCard(store.db, card.id)).toBeNull();
    const routed = store.write((ctx) => {
      const item = setInboxRecipients(ctx, card.id, {
        assignees: ['mark'],
        routedBy: RoutedBy.Judge,
        suggestion: null,
      });
      return draftFor(ctx, item, deps());
    }).value;
    expect(sendForCard(store.db, card.id)?.state).toBe('draft');
    routed?.();
    expect(afterDrafts).toEqual([card.id]);
  });

  it('is idempotent: a card with a live send gets no second one', () => {
    const w = world();
    w.route([w.mark]);
    const { card } = w.insertAndDraft();
    const again = store.write((ctx) => draftFor(ctx, getInboxItem(ctx.tx, card.id), deps())).value;
    expect(again).toBeNull();
  });

  it('holds a fenced code block in the card body even though composing drops the backticks', () => {
    const w = world();
    w.route([w.mark]);
    const { card } = w.insertAndDraft({ body: 'Use:\n```\nrm -rf x\n```' });
    const send = sendForCard(store.db, card.id);
    expect(send?.hits.map((h) => [h.pattern, h.severity])).toContainEqual(['code_block', 'hold']);
  });

  it('holds a url in the card', () => {
    const w = world();
    w.route([w.mark]);
    const { card } = w.insertAndDraft({ body: 'See https://example.com/x' });
    expect(sendForCard(store.db, card.id)?.hits.map((h) => h.pattern)).toContain('url');
  });
});

describe('sweepDrafts', () => {
  const sweep = () =>
    store.write((ctx) =>
      sweepDrafts(ctx, { afterDraft: (id) => afterDrafts.push(id), log: silentLogger }),
    ).value;

  it('drafts a routed open question that has none', () => {
    const w = world();
    w.route([w.mark]);
    const card = w.insert();
    expect(sendForCard(store.db, card.id)).toBeNull();
    const after = sweep();
    expect(sendForCard(store.db, card.id)?.state).toBe('draft');
    after.forEach((f) => {
      f();
    });
    expect(afterDrafts).toEqual([card.id]);
  });

  it('drops a draft whose card was rerouted, and drafts for the new people', () => {
    const w = world();
    w.route([w.mark]);
    const { card } = w.insertAndDraft();
    const first = sendForCard(store.db, card.id);
    store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['ana'],
        routedBy: RoutedBy.Builder,
        suggestion: null,
      }),
    );
    sweep();
    const second = sendForCard(store.db, card.id);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.people.map((p) => p.userId)).toEqual(['U-ana']);
  });

  const failedCompose = () =>
    deps({
      compose: () => {
        throw new Error('boom');
      },
    });

  it('retries a card whose compose failed, but not one the builder took back on purpose', () => {
    const w = world();
    w.route([w.mark]);
    const failed = w.insertAndDraft({}, failedCompose()).card;
    const kept = w.insertAndDraft().card;
    store.write((ctx) => {
      const send = sendForCard(ctx.tx, kept.id);
      if (send) closeSend(ctx, send.id, 'taken_back');
      setInboxRecipients(ctx, kept.id, {
        assignees: [],
        routedBy: RoutedBy.Builder,
        suggestion: null,
      });
    });
    const after = sweep();
    expect(getInboxItem(store.db, failed.id)).toMatchObject({
      assignees: ['mark'],
      routedBy: 'rule',
    });
    expect(getInboxItem(store.db, failed.id).detail?.['draftFailed']).toBeUndefined();
    expect(sendForCard(store.db, failed.id)?.state).toBe('draft');
    expect(after).toHaveLength(1);
    expect(getInboxItem(store.db, kept.id)).toMatchObject({
      assignees: ['me'],
      routedBy: 'builder',
    });
    expect(sendForCard(store.db, kept.id)?.state).toBe('closed');
  });

  it('retries a failed compose for the people the rules name now, not when the card was made', () => {
    const w = world();
    w.route([w.mark]);
    const failed = w.insertAndDraft({}, failedCompose()).card;
    w.route([w.ana]);
    sweep();
    expect(getInboxItem(store.db, failed.id).assignees).toEqual(['ana']);
    expect(sendForCard(store.db, failed.id)?.people.map((p) => p.userId)).toEqual(['U-ana']);
  });

  it('leaves a failed compose with the builder when the rules now route it to the builder', () => {
    const w = world();
    w.route([w.mark]);
    const failed = w.insertAndDraft({}, failedCompose()).card;
    w.route([]);
    expect(sweep()).toEqual([]);
    expect(getInboxItem(store.db, failed.id)).toMatchObject({
      assignees: ['me'],
      routedBy: 'builder',
    });
    expect(getInboxItem(store.db, failed.id).detail?.['draftFailed']).toBeUndefined();
  });

  it('does not reroute a card the rules sent to the builder on purpose', () => {
    const w = world();
    w.route([w.mark]);
    const card = w.insert();
    w.route([]);
    store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: [],
        routedBy: RoutedBy.Rule,
        suggestion: null,
      }),
    );
    w.route([w.mark]);
    expect(sweep()).toEqual([]);
    expect(getInboxItem(store.db, card.id).assignees).toEqual(['me']);
  });

  it('keeps a draft whose recipients still match', () => {
    const w = world();
    w.route([w.mark]);
    const { card } = w.insertAndDraft();
    const first = sendForCard(store.db, card.id);
    expect(sweep()).toEqual([]);
    expect(sendForCard(store.db, card.id)?.id).toBe(first?.id);
  });

  it('settles a stranded open card waiting for triage to the lane rule', () => {
    const w = world();
    w.route([w.mark], null);
    const { card } = w.insertAndDraft({ pending: true });
    const swept = sweep();
    expect(getInboxItem(store.db, card.id)).toMatchObject({
      routedBy: 'rule',
      assignees: ['mark'],
    });
    expect(sendForCard(store.db, card.id)?.state).toBe('draft');
    expect(swept).toHaveLength(1);
  });

  it('only clears the pending mark on a card that was answered', () => {
    const w = world();
    w.route([w.mark], null);
    const { card } = w.insertAndDraft({ pending: true });
    store.write((ctx) =>
      updateInboxItem(ctx, card.id, { state: InboxState.Answered, answer: { choice: 'Yes' } }),
    );
    sweep();
    expect(getInboxItem(store.db, card.id)).toMatchObject({
      routedBy: 'builder',
      state: 'ANSWERED',
    });
    expect(sendForCard(store.db, card.id)).toBeNull();
  });

  it('closes the draft of a card that is no longer open', () => {
    const w = world();
    w.route([w.mark]);
    const { card } = w.insertAndDraft();
    store.write((ctx) => updateInboxItem(ctx, card.id, { state: InboxState.Cancelled }));
    sweep();
    expect(sendForCard(store.db, card.id)?.state).toBe('closed');
  });
});
