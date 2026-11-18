import {
  compareRowSort,
  InboxPageQuery,
  mintId,
  PASS_SIGN_OFF_CHOICE,
  RoutedBy,
  type InboxItemId,
  type InboxPageDto,
  type PassCheckDetail,
  type PassId,
  type ProjectId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertInboxItem, updateInboxItem } from './inbox';
import { openRowsPage, type InboxPlacement } from './inbox-open-rows';
import { pageInbox } from './inbox-page';
import { failSend, insertDraft, markReturned, markSending, markSent } from './stakeholder-sends';
import type { Store } from './store';
import { insertTask } from './tasks';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
// Every clock read is a minute after the last, so created_at orders the cards as they were written.
let tick = 0;
beforeEach(() => {
  tick = 0;
  ({ store, close } = createTestStore(() => new Date(Date.UTC(2026, 10, 1, 0, tick++))));
});
afterEach(() => {
  close();
});

const OUT: InboxPlacement = { waitingOut: true };
const IN: InboxPlacement = { waitingOut: false };

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
  const ana = store.write((ctx) =>
    insertPerson(ctx, {
      handle: 'ana',
      name: 'Ana',
      slack: { teamId: 'T1', userId: 'U2', sendMode: 'review' as const, dailyLimit: 10 },
    }),
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
  const flag = (title: string, over: Partial<Parameters<typeof insertInboxItem>[1]> = {}) =>
    card(title, { kind: 'flag', options: [], body: 'docs/a.md', ...over });
  const ready = (passId: PassId, title: string) => {
    const detail: PassCheckDetail = {
      passId,
      taskId: mintId('Task'),
      workstreamId: mintId('Workstream'),
      turnId: mintId('PassTurn'),
      keptSha: 'a'.repeat(40),
      keptBaseSha: 'b'.repeat(40),
      turnFiles: [],
      pageFiles: [],
    };
    return card(title, {
      kind: 'check',
      options: [{ label: PASS_SIGN_OFF_CHOICE, description: '' }],
      detail,
    });
  };
  return { project, other, ana, card, flag, ready };
}

function resolve(id: InboxItemId) {
  store.write((ctx) => {
    updateInboxItem(ctx, id, { state: 'RESOLVED' });
  });
}

function pend(id: InboxItemId) {
  store.write((ctx) => {
    ctx.tx
      .update(schema.inboxItems)
      .set({ routedBy: RoutedBy.TriagePending })
      .where(eq(schema.inboxItems.id, id))
      .run();
  });
}

type SendKind = 'sent' | 'draft' | 'failed' | 'timer' | 'disagreed';
function send(
  id: InboxItemId,
  recipient: Parameters<typeof insertDraft>[1]['recipients'][number],
  kind: SendKind,
) {
  const draft = store.write((ctx) =>
    insertDraft(ctx, { inboxItemId: id, recipients: [recipient], text: 'Hi', hits: [] }),
  ).value;
  if (kind === 'draft') return;
  store.write((ctx) => {
    markSending(ctx, draft.id, { textSha256: 'abc', threadTs: null, startedAt: ctx.now });
  });
  if (kind === 'failed') {
    store.write((ctx) => {
      failSend(ctx, draft.id, 'x');
    });
    return;
  }
  store.write((ctx) => {
    markSent(ctx, draft.id, {
      channelId: 'D1',
      threadTs: '100.1',
      messageTs: '100.1',
      permalink: 'https://x/p',
      at: ctx.now,
    });
  });
  if (kind === 'timer' || kind === 'disagreed')
    store.write((ctx) => {
      markReturned(ctx, draft.id, kind === 'timer' ? 'timer' : 'disagreed');
    });
}

const read = (query: Record<string, string>, placement: InboxPlacement = IN): InboxPageDto =>
  openRowsPage(store.db, InboxPageQuery.parse({ state: 'open', ...query }), placement);
const idsOf = (a: InboxPageDto) => a.rows.map((row) => row.ids.length);

describe('openRowsPage: rows', () => {
  it('folds three identical flags into one row', () => {
    const w = world();
    w.flag('Outside claim');
    w.flag('Outside claim');
    w.flag('Outside claim');
    const a = read({});
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.ids).toHaveLength(3);
    expect(a.items).toHaveLength(3);
    expect(a.total).toBe(1);
  });

  it('keeps one flag title in two projects as two rows', () => {
    const w = world();
    w.flag('Outside claim');
    w.flag('Outside claim', { projectId: w.other.id });
    expect(read({}).rows).toHaveLength(2);
  });

  it('gives a pass its own row and a failed turn of the pass its own', () => {
    const w = world();
    const pass = mintId('Pass');
    w.ready(pass, 'Ready: A');
    w.ready(pass, 'Ready: B');
    w.flag('Turn failed', { options: [{ label: 'retry_turn', description: '' }] });
    const a = read({});
    expect(idsOf(a)).toEqual([2, 1]);
    expect(a.rows[0]?.key).toBe(`pass:${pass}`);
    expect(a.rows[0]?.passId).toBe(pass);
    expect(a.rows[1]?.passId).toBeNull();
  });

  it('counts only rows holding a card triage has placed', () => {
    const w = world();
    pend(w.card('Pending'));
    w.card('Placed');
    const pendingFlag = w.flag('Mixed');
    w.flag('Mixed');
    pend(pendingFlag);
    const a = read({});
    expect(a.rows).toHaveLength(3);
    expect(a.total).toBe(2);
  });
});

describe('openRowsPage: pages', () => {
  it('walks 60 single cards by keyset without a seam', () => {
    const w = world();
    const made = Array.from({ length: 60 }, (_, i) => w.card(`Card ${String(i)}`));
    const seen: InboxItemId[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const a = read({ pageSize: '25', ...(after === undefined ? {} : { after }) });
      expect(a.page).toBe(1);
      seen.push(...a.items.map((i) => i.id));
      if (a.next === null) break;
      after = JSON.stringify(a.next);
    }
    expect(seen).toEqual(made);
    const all = read({ pageSize: '100' });
    const sorts = all.rows.map((r) => r.sort);
    sorts.forEach((sort, i) => {
      const prev = sorts[i - 1];
      if (prev !== undefined) expect(compareRowSort('open', prev, sort)).toBeLessThan(0);
    });
    expect(read({ pageSize: '25', after: JSON.stringify(all.rows[49]?.sort) }).next).toBeNull();
  });

  it('never splits a row across a page', () => {
    const w = world();
    for (let i = 0; i < 24; i++) w.card(`Card ${String(i)}`);
    w.flag('Same');
    w.flag('Same');
    w.flag('Same');
    const first = read({ pageSize: '25' });
    expect(first.rows).toHaveLength(25);
    expect(first.rows.at(-1)?.ids).toHaveLength(3);
    expect(first.next).toBeNull();
    const small = read({ pageSize: '24' });
    expect(small.rows).toHaveLength(24);
    expect(small.next).not.toBeNull();
    const rest = read({ pageSize: '24', after: JSON.stringify(small.next) });
    expect(idsOf(rest)).toEqual([3]);
  });

  it('answers the second page of rows for page 2 with no after', () => {
    const w = world();
    const made = Array.from({ length: 5 }, (_, i) => w.card(`Card ${String(i)}`));
    const a = read({ pageSize: '2', page: '2' });
    expect(a.page).toBe(2);
    expect(a.items.map((i) => i.id)).toEqual(made.slice(2, 4));
    expect(a.next).not.toBeNull();
    expect(read({ pageSize: '2', page: '9' }).page).toBe(3);
  });

  it('shows a row holding a card that joined, with the same key and sort', () => {
    const w = world();
    w.flag('Same');
    w.flag('Same');
    w.flag('Same');
    const before = read({}).rows[0];
    const added = w.flag('Same');
    const a = read({ card: added });
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.ids).toHaveLength(4);
    expect(a.rows[0]?.key).toBe(before?.key);
    expect(a.rows[0]?.sort).toEqual(before?.sort);
    expect(a.page).toBe(1);
    expect(read({ card: mintId('InboxItem') }).rows).toEqual([]);
  });

  it('shrinks a row when its first card leaves and re-sorts it by the second', () => {
    const w = world();
    const first = w.flag('Same');
    const second = w.flag('Same');
    w.flag('Same');
    resolve(first);
    const a = read({ card: second });
    expect(a.rows[0]?.ids).toHaveLength(2);
    expect(a.rows[0]?.sort[2]).toBe(second);
  });
});

describe('openRowsPage: filters and search', () => {
  it('filters by project and kind with a pass row kept whole', () => {
    const w = world();
    const pass = mintId('Pass');
    w.ready(pass, 'Ready: A');
    w.ready(pass, 'Ready: B');
    w.card('Other project', { projectId: w.other.id });
    expect(idsOf(read({ project: w.project.id }))).toEqual([2]);
    expect(idsOf(read({ kind: 'check' }))).toEqual([2]);
    expect(read({ kind: 'flag' }).rows).toEqual([]);
  });

  it('matches a whole pass row when one page title matches', () => {
    const w = world();
    const pass = mintId('Pass');
    const a = w.ready(pass, 'Ready: retry parser');
    const b = w.ready(pass, 'Ready: docs');
    w.card('Unrelated');
    const answer = read({ q: 'retry' });
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]?.ids).toEqual([a, b]);
    expect(answer.total).toBe(1);
  });

  it('answers a card for its row when only another card of the row matches the search', () => {
    const w = world();
    const pass = mintId('Pass');
    const a = w.ready(pass, 'Ready: retry parser');
    const b = w.ready(pass, 'Ready: docs');
    const answer = read({ q: 'retry', card: b });
    expect(answer.rows.map((row) => row.ids)).toEqual([[a, b]]);
    expect(read({ q: 'nothing', card: b }).rows).toEqual([]);
  });

  it('keeps the project and kind filters on the page after a row', () => {
    const w = world();
    const mine = [w.card('Mine 1'), w.card('Mine 2'), w.card('Mine 3')];
    w.card('Elsewhere', { projectId: w.other.id });
    w.flag('A flag');
    const first = read({ project: w.project.id, kind: 'question', pageSize: '1' });
    expect(first.items.map((i) => i.id)).toEqual([mine[0]]);
    const second = read({
      project: w.project.id,
      kind: 'question',
      pageSize: '5',
      after: JSON.stringify(first.next),
    });
    expect(second.items.map((i) => i.id)).toEqual(mine.slice(1));
  });

  it('matches a literal percent only, and folds ASCII case only', () => {
    const w = world();
    const pct = w.card('Used 50% of quota');
    w.card('Used 50 of quota');
    const retry = w.card('Please retry');
    const accent = w.card('CAFÉ closed');
    expect(read({ q: '%' }).items.map((i) => i.id)).toEqual([pct]);
    expect(read({ q: 'RETRY' }).items.map((i) => i.id)).toEqual([retry]);
    // Only ASCII letters fold: é does not match É, in either direction, while the same letters match.
    expect(read({ q: 'café' }).items.map((i) => i.id)).toEqual([]);
    expect(read({ q: 'CAFé' }).items.map((i) => i.id)).toEqual([]);
    expect(read({ q: 'cafÉ' }).items.map((i) => i.id)).toEqual([accent]);
  });
});

describe('openRowsPage: placement', () => {
  it.each<[string, SendKind | null, boolean, boolean]>([
    ['a sent card', 'sent', true, false],
    ['a sent card', 'sent', false, true],
    ['a draft', 'draft', true, true],
    ['a failed send', 'failed', true, true],
    ['a card with no send', null, true, true],
    ['a send the timer returned', 'timer', true, true],
    ['a send whose recipients disagree', 'disagreed', true, true],
  ])('%s with waitingOut=%s is in Open: %s', (_name, kind, waitingOut, inOpen) => {
    const w = world();
    const id = w.card('Q');
    if (kind !== null) send(id, w.ana.id, kind);
    const a = read({}, { waitingOut });
    expect(a.items.map((i) => i.id)).toEqual(inOpen ? [id] : []);
  });

  it('totals a mixed seed by hand', () => {
    const w = world();
    w.flag('Same');
    w.flag('Same');
    w.flag('Same');
    const pass = mintId('Pass');
    w.ready(pass, 'Ready: A');
    w.ready(pass, 'Ready: B');
    w.card('Single one');
    w.card('Single two');
    pend(w.card('Pending single'));
    send(w.card('Sent card'), w.ana.id, 'sent');
    // flag row, pass row, two singles; the pending single and the sent card do not count.
    expect(read({}, OUT).total).toBe(4);
    expect(read({}, OUT).rows).toHaveLength(5);
  });

  it('is what pageInbox answers for state open', () => {
    const w = world();
    w.card('Q');
    expect(pageInbox(store.db, InboxPageQuery.parse({ state: 'open' }), IN)).toEqual(read({}));
  });
});
