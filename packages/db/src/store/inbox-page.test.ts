import {
  CARD_RESOLUTION,
  InboxOutcome,
  InboxPageQuery,
  compareRowSort,
  inboxOutcome,
  type InboxItemId,
  type PersonId,
  type ProjectId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertInboxItem, updateInboxItem } from './inbox';
import { pageInbox } from './inbox-page';
import { insertDraft, markReturned, markSending, markSent } from './stakeholder-sends';
import type { Store } from './store';
import { insertTask } from './tasks';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
// Every write is a minute after the last, so updatedAt orders the cards as they were written.
let tick = 0;
beforeEach(() => {
  tick = 0;
  ({ store, close } = createTestStore(() => new Date(Date.UTC(2026, 10, 1, 0, tick++))));
});
afterEach(() => {
  close();
});

const slack = (userId: string) => ({
  teamId: 'T1',
  userId,
  sendMode: 'review' as const,
  dailyLimit: 10,
});

function world() {
  const project = seedProject(store);
  const other = seedProject(store, { name: 'other' });
  const workstream = (projectId: ProjectId) => {
    const task = store.write((ctx) =>
      insertTask(ctx, projectId, { title: 'T', acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value;
    return store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
  };
  const lanes = { [project.id]: workstream(project.id), [other.id]: workstream(other.id) };
  const mark = store.write((ctx) =>
    insertPerson(ctx, { handle: 'mark', name: 'Mark', slack: slack('U1') }),
  ).value;
  const ana = store.write((ctx) =>
    insertPerson(ctx, { handle: 'ana', name: 'Ana', slack: slack('U2') }),
  ).value;
  const card = (
    title: string,
    over: Partial<Parameters<typeof insertInboxItem>[1]> = {},
  ): InboxItemId => {
    const projectId = over.projectId ?? project.id;
    const lane = lanes[projectId];
    if (lane === undefined) throw new Error('no lane for that project');
    return store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId,
        kind: 'question',
        title,
        body: '',
        options: [{ label: 'A', description: '' }],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: lane.id, sessionId: null }],
        ...over,
      }),
    ).value.id;
  };
  return { project, other, mark, ana, card };
}

function resolve(id: InboxItemId, over: Parameters<typeof updateInboxItem>[2] = {}) {
  store.write((ctx) => updateInboxItem(ctx, id, { state: 'RESOLVED', ...over }));
}

/** A send to `recipients` that went out; `returned` brings it back. */
function send(id: InboxItemId, recipients: PersonId[], returned = false, sentAt?: string) {
  const draft = store.write((ctx) =>
    insertDraft(ctx, { inboxItemId: id, recipients, text: 'Hi', hits: [] }),
  ).value;
  store.write((ctx) => {
    markSending(ctx, draft.id, { textSha256: 'abc', threadTs: null, startedAt: ctx.now });
  });
  store.write((ctx) => {
    markSent(ctx, draft.id, {
      channelId: 'D1',
      threadTs: '100.1',
      messageTs: '100.1',
      permalink: 'https://x/p',
      at: sentAt ?? ctx.now,
    });
  });
  if (returned)
    store.write((ctx) => {
      markReturned(ctx, draft.id, 'timer');
    });
  return draft.id;
}

/**
 * Every answer's rows mirror its items: one row per card, keyed by its id. A page read in the default order
 * has a next page when cards remain; a keyset or card answer is checked by its own test.
 */
const page = (query: Record<string, string>) => {
  const answer = pageInbox(store.db, InboxPageQuery.parse(query), { waitingOut: false });
  expect(answer.rows.map((row) => row.key)).toEqual(answer.items.map((item) => item.id));
  expect(answer.rows.map((row) => row.ids)).toEqual(answer.items.map((item) => [item.id]));
  expect(answer.rows.map((row) => row.passId)).toEqual(answer.items.map(() => null));
  const more = answer.items.length < answer.total && query['sort'] === undefined;
  if (query['page'] === undefined && query['after'] === undefined && query['card'] === undefined)
    expect(answer.next).toEqual(more ? (answer.rows.at(-1)?.sort ?? null) : null);
  return answer;
};
const titles = (query: Record<string, string>) => page(query).items.map((i) => i.title);

describe('pageInbox: resolved', () => {
  it('answers one page, newest first, with the total of every match', () => {
    const w = world();
    for (const n of [1, 2, 3, 4, 5]) resolve(w.card(`Card ${String(n)}`));
    w.card('Still open');
    expect(page({ state: 'resolved', pageSize: '2' })).toMatchObject({
      total: 5,
      page: 1,
      pageSize: 2,
    });
    expect(titles({ state: 'resolved', pageSize: '2' })).toEqual(['Card 5', 'Card 4']);
    expect(titles({ state: 'resolved', pageSize: '2', page: '2' })).toEqual(['Card 3', 'Card 2']);
    expect(titles({ state: 'resolved', pageSize: '2', page: '3' })).toEqual(['Card 1']);
  });

  it('answers the last page for a page past the end', () => {
    const w = world();
    for (const n of [1, 2, 3]) resolve(w.card(`Card ${String(n)}`));
    expect(page({ state: 'resolved', pageSize: '2', page: '9' })).toMatchObject({
      page: 2,
      total: 3,
    });
    expect(titles({ state: 'resolved', pageSize: '2', page: '9' })).toEqual(['Card 1']);
    expect(page({ state: 'waiting', page: '4' })).toMatchObject({ page: 1, total: 0, items: [] });
  });

  it.each([
    ['title ascending', { sort: 'title', dir: 'asc' }, ['Alpha', 'beta', 'Gamma']],
    ['title descending', { sort: 'title', dir: 'desc' }, ['Gamma', 'beta', 'Alpha']],
    ['oldest made first', { sort: 'createdAt', dir: 'asc' }, ['Gamma', 'Alpha', 'beta']],
    ['kind', { sort: 'kind', dir: 'asc' }, ['beta', 'Gamma', 'Alpha']],
  ])('sorts by %s', (_name, sort, expected) => {
    const w = world();
    const gamma = w.card('Gamma', { kind: 'proposal' });
    const alpha = w.card('Alpha', { kind: 'question' });
    const beta = w.card('beta', { kind: 'flag' });
    for (const id of [beta, alpha, gamma]) resolve(id);
    expect(titles({ state: 'resolved', ...sort })).toEqual(expected);
  });

  it('narrows by project and kind in the query', () => {
    const w = world();
    resolve(w.card('Here question'));
    resolve(w.card('Here flag', { kind: 'flag' }));
    resolve(w.card('There question', { projectId: w.other.id }));
    expect(titles({ state: 'resolved', project: w.project.id })).toEqual([
      'Here flag',
      'Here question',
    ]);
    expect(titles({ state: 'resolved', kind: 'question' })).toEqual([
      'There question',
      'Here question',
    ]);
    expect(page({ state: 'resolved', project: w.other.id, kind: 'flag' }).total).toBe(0);
  });

  it('files each card under the outcome inboxOutcome gives it', () => {
    const w = world();
    const resolution = { by: '10db', reason: 'The task finished.' };
    const cards: [string, Parameters<typeof updateInboxItem>[2]][] = [
      ['Slack', { answer: { choice: 'A', via: 'slack', answeredBy: 'mark' } }],
      [
        'Slack, then closed',
        { answer: { choice: 'A', via: 'slack' }, detail: { [CARD_RESOLUTION]: resolution } },
      ],
      ['Closed by 10db', { detail: { [CARD_RESOLUTION]: resolution } }],
      [
        'Answered, then closed',
        { answer: { choice: 'A' }, detail: { [CARD_RESOLUTION]: resolution } },
      ],
      ['Closed with no reason', { detail: { [CARD_RESOLUTION]: { by: '10db', reason: '' } } }],
      ['Closed by someone', { detail: { [CARD_RESOLUTION]: { by: 'mark', reason: 'x' } } }],
      ['Answered in the Inbox', { answer: { choice: 'A', via: 'inbox' } }],
      ['Answered', { answer: { choice: 'A' } }],
      ['Dismissed', {}],
    ];
    for (const [title, over] of cards) resolve(w.card(title), over);
    const all = page({ state: 'resolved', pageSize: '100' }).items;
    expect(all).toHaveLength(cards.length);
    for (const outcome of Object.values(InboxOutcome)) {
      const expected = all.filter((item) => inboxOutcome(item) === outcome).map((i) => i.title);
      expect(expected.length).toBeGreaterThan(0);
      expect(titles({ state: 'resolved', outcome, pageSize: '100' })).toEqual(expected);
    }
  });
});

describe('pageInbox: waiting', () => {
  it('holds open cards whose send went out and has not come back, longest out first', () => {
    const w = world();
    const first = w.card('First out');
    const unsent = w.card('Never sent');
    const returned = w.card('Came back');
    const second = w.card('Second out');
    send(first, [w.mark.id]);
    store.write((ctx) =>
      insertDraft(ctx, { inboxItemId: unsent, recipients: [w.mark.id], text: 'Hi', hits: [] }),
    );
    send(returned, [w.mark.id], true);
    send(second, [w.ana.id]);
    const answered = w.card('Answered after sending');
    send(answered, [w.mark.id]);
    resolve(answered);
    expect(titles({ state: 'waiting' })).toEqual(['First out', 'Second out']);
    expect(page({ state: 'waiting' }).total).toBe(2);
    expect(titles({ state: 'waiting', sort: 'sentAt', dir: 'desc' })).toEqual([
      'Second out',
      'First out',
    ]);
    expect(titles({ state: 'open' })).toEqual([
      'First out',
      'Never sent',
      'Came back',
      'Second out',
    ]);
  });

  it('narrows by who the question went to', () => {
    const w = world();
    send(w.card('To Mark'), [w.mark.id]);
    send(w.card('To both'), [w.mark.id, w.ana.id]);
    send(w.card('To Ana'), [w.ana.id]);
    send(w.card('Back from Ana'), [w.ana.id], true);
    expect(titles({ state: 'waiting', person: w.ana.id })).toEqual(['To both', 'To Ana']);
    expect(titles({ state: 'waiting', person: w.mark.id })).toEqual(['To Mark', 'To both']);
  });
});

describe('pageInbox: open', () => {
  it('is most urgent and then oldest first', () => {
    const w = world();
    w.card('Normal, older');
    w.card('Low', { urgency: 'low' });
    w.card('High', { urgency: 'high' });
    w.card('Normal, newer');
    expect(titles({ state: 'open' })).toEqual(['High', 'Normal, older', 'Normal, newer', 'Low']);
  });
});

/** Walks a list by `after` until `next` is null; every page's rows are those of the cards it holds. */
function walk(query: Record<string, string>) {
  const seen: string[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const answer = pageInbox(
      store.db,
      InboxPageQuery.parse(after === undefined ? query : { ...query, after }),
      { waitingOut: false },
    );
    expect(answer.page).toBe(1);
    seen.push(...answer.items.map((item) => item.title));
    if (answer.next === null) return seen;
    after = JSON.stringify(answer.next);
  }
  throw new Error('the walk never ended');
}

describe('pageInbox: keyset', () => {
  it('walks Resolved newest first, once each, tied cards by id descending', () => {
    const w = world();
    const ids = Array.from({ length: 60 }, (_, n) => w.card(`Card ${String(n).padStart(2, '0')}`));
    for (const id of ids) resolve(id);
    // Two cards resolved in the same minute tie on updatedAt.
    const tie = [w.card('Tie a'), w.card('Tie b')];
    store.write((ctx) => {
      for (const id of tie) updateInboxItem(ctx, id, { state: 'RESOLVED' });
    });
    const expected = [
      ...[...tie]
        .sort()
        .reverse()
        .map((id) => (id === tie[0] ? 'Tie a' : 'Tie b')),
      ...Array.from({ length: 60 }, (_, n) => `Card ${String(59 - n).padStart(2, '0')}`),
    ];
    const walked = walk({ state: 'resolved', pageSize: '7' });
    expect(walked).toHaveLength(62);
    expect(walked.slice(2)).toEqual(expected.slice(2));
    expect(new Set(walked).size).toBe(62);
    expect(walked.slice(0, 2).sort()).toEqual(['Tie a', 'Tie b']);
  });

  it('walks cards that tie across a page seam, each once, in the browser merge order', () => {
    const w = world();
    const tied = ['Tie a', 'Tie b', 'Tie c'].map((title) => w.card(title));
    store.write((ctx) => {
      for (const id of tied) updateInboxItem(ctx, id, { state: 'RESOLVED' });
    });
    const byId = new Map(tied.map((id, n) => [id, `Tie ${'abc'[n] ?? ''}`]));
    const expected = [...tied]
      .sort()
      .reverse()
      .map((id) => byId.get(id));
    expect(walk({ state: 'resolved', pageSize: '1' })).toEqual(expected);
  });

  it('walks Waiting cards sent at the same moment across a page seam, each once', () => {
    const w = world();
    const at = new Date(Date.UTC(2026, 10, 1, 5)).toISOString();
    for (const title of ['Out a', 'Out b', 'Out c']) send(w.card(title), [w.mark.id], false, at);
    const walked = walk({ state: 'waiting', pageSize: '1' });
    expect(walked.toSorted()).toEqual(['Out a', 'Out b', 'Out c']);
  });

  it('orders two cards that tie as the browser merge does', () => {
    const w = world();
    const a = w.card('Tie a');
    const b = w.card('Tie b');
    store.write((ctx) => {
      for (const id of [a, b]) updateInboxItem(ctx, id, { state: 'RESOLVED' });
    });
    const answer = page({ state: 'resolved' });
    const [first, second] = answer.rows;
    if (first === undefined || second === undefined) throw new Error('two rows expected');
    expect(first.sort[1]).toBe(second.sort[1]);
    expect(compareRowSort('resolved', first.sort, second.sort)).toBeLessThan(0);
    expect(answer.rows.map((row) => row.sort[2])).toEqual([a, b].sort().reverse());
  });

  it('walks Waiting longest out first, once each', () => {
    const w = world();
    const all = Array.from({ length: 30 }, (_, n) => `Out ${String(n).padStart(2, '0')}`);
    for (const title of all) send(w.card(title), [w.mark.id]);
    expect(walk({ state: 'waiting', pageSize: '4' })).toEqual(all);
  });

  it('leaves out Resolved cards updated before since', () => {
    const w = world();
    const old = w.card('Old');
    resolve(old);
    const cut = new Date(Date.UTC(2026, 10, 1, 0, 30)).toISOString();
    tick = 31;
    resolve(w.card('New a'));
    resolve(w.card('New b'));
    expect(titles({ state: 'resolved', since: cut })).toEqual(['New b', 'New a']);
    expect(page({ state: 'resolved', since: cut }).total).toBe(2);
  });

  it('searches the title and the body, folds ASCII case, and takes _ literally', () => {
    const w = world();
    resolve(w.card('Deploy plan'));
    resolve(w.card('Other', { body: 'the DEPLOY went out' }));
    resolve(w.card('snake_case name'));
    resolve(w.card('snakeXcase name'));
    resolve(w.card('Fifty %'));
    resolve(w.card('Unrelated'));
    expect(titles({ state: 'resolved', q: 'deploy' })).toEqual(['Other', 'Deploy plan']);
    expect(titles({ state: 'resolved', q: 'ake_c' })).toEqual(['snake_case name']);
    expect(titles({ state: 'resolved', q: '%' })).toEqual(['Fifty %']);
    const out = w.card('Waiting deploy');
    send(out, [w.mark.id]);
    expect(titles({ state: 'waiting', q: 'DEPLOY' })).toEqual(['Waiting deploy']);
  });

  it('answers a Waiting card only when its send went to the person asked', () => {
    const w = world();
    const toMark = w.card('To Mark');
    send(toMark, [w.mark.id]);
    send(w.card('To Ana'), [w.ana.id]);
    const ask = (person: PersonId) =>
      pageInbox(store.db, InboxPageQuery.parse({ state: 'waiting', card: toMark, person }), {
        waitingOut: false,
      }).items.map((item) => item.id);
    expect(ask(w.mark.id)).toEqual([toMark]);
    expect(ask(w.ana.id)).toEqual([]);
  });

  it('answers one row for a card in the list and none for a card in another', () => {
    const w = world();
    const done = w.card('Done');
    resolve(done);
    resolve(w.card('Other done'));
    const open = w.card('Open one');
    const one = pageInbox(store.db, InboxPageQuery.parse({ state: 'resolved', card: done }), {
      waitingOut: false,
    });
    expect(one.items.map((item) => item.id)).toEqual([done]);
    expect(one.rows.map((row) => row.key)).toEqual([done]);
    expect(one).toMatchObject({ page: 1, next: null });
    const none = pageInbox(store.db, InboxPageQuery.parse({ state: 'resolved', card: open }), {
      waitingOut: false,
    });
    expect(none).toMatchObject({ items: [], rows: [], next: null });
  });
});
