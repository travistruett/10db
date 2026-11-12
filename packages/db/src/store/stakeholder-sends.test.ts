import { ConflictError, type InboxItemId, type PersonId, type SendState } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertInboxItem } from './inbox';
import {
  closeSend,
  dropDraft,
  everSent,
  failSend,
  insertDraft,
  keepWaiting,
  latestThreadFor,
  markAnswered,
  markApprovalSeen,
  markAskedWhichWay,
  markLoneReplyPending,
  markReminded,
  markReturned,
  markSending,
  markSent,
  markSettled,
  moveSend,
  newThreadsSince,
  openSends,
  sendForCard,
  sendingSends,
  sendsInThread,
  setHeldBy,
  setProposal,
  updateDraft,
} from './stakeholder-sends';
import type { Store } from './store';
import { insertTask } from './tasks';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const T0 = '2026-11-12T10:00:00.000Z';
const slack = (userId: string) => ({
  teamId: 'T1',
  userId,
  sendMode: 'review' as const,
  dailyLimit: 10,
});

function world() {
  const project = seedProject(store);
  const mark = store.write((ctx) =>
    insertPerson(ctx, { handle: 'mark', name: 'Mark', slack: slack('U1') }),
  ).value;
  const ana = store.write((ctx) =>
    insertPerson(ctx, { handle: 'ana', name: 'Ana', slack: slack('U2') }),
  ).value;
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['ui'] }),
  ).value;
  const ws = store.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value;
  const card = (title: string): InboxItemId =>
    store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title,
        body: '',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: ws.id, sessionId: null }],
      }),
    ).value.id;
  return { project, mark, ana, task, card };
}

function draft(inboxItemId: InboxItemId, recipients: PersonId[]) {
  return store.write((ctx) => insertDraft(ctx, { inboxItemId, recipients, text: 'Hi', hits: [] }))
    .value;
}

const sent = (id: ReturnType<typeof draft>['id'], at = T0, threadTs: string | null = null) => {
  store.write((ctx) => {
    markSending(ctx, id, { textSha256: 'abc', threadTs, startedAt: at });
  });
  store.write((ctx) => {
    markSent(ctx, id, {
      channelId: 'D1',
      threadTs: threadTs ?? '100.1',
      messageTs: '100.1',
      permalink: 'https://x/p',
      at,
    });
  });
};

type Move = (id: ReturnType<typeof draft>['id']) => void;
const MOVES: Record<string, { move: Move; from: SendState[] }> = {
  markSending: {
    from: ['draft'],
    move: (id) =>
      store.write((ctx) => {
        markSending(ctx, id, { textSha256: 'a', threadTs: null, startedAt: T0 });
      }),
  },
  markSent: {
    from: ['sending'],
    move: (id) =>
      store.write((ctx) => {
        markSent(ctx, id, {
          channelId: 'D1',
          threadTs: '1.1',
          messageTs: '1.1',
          permalink: null,
          at: T0,
        });
      }),
  },
  moveSend: {
    from: ['sent'],
    move: (id) =>
      store.write((ctx) => {
        moveSend(ctx, id, {
          channelId: 'G1',
          threadTs: '2.1',
          messageTs: '2.1',
          permalink: null,
          added: [],
        });
      }),
  },
  markReminded: {
    from: ['sent'],
    move: (id) =>
      store.write((ctx) => {
        markReminded(ctx, id, T0);
      }),
  },
  setProposal: {
    from: ['sent'],
    move: (id) =>
      store.write((ctx) => {
        setProposal(ctx, id, { choice: 'A', confidence: 0.9, ts: '3.1' });
      }),
  },
  markAnswered: {
    from: ['sent'],
    move: (id) =>
      store.write((ctx) => {
        markAnswered(ctx, id, {
          reply: { text: 'A', userId: 'U1', ts: '4.1' },
          readAs: 'option',
          answeredBy: null,
          replyVia: 'thread',
        });
      }),
  },
  closeSend: {
    from: ['draft', 'sending', 'sent'],
    move: (id) =>
      store.write((ctx) => {
        closeSend(ctx, id, 'builder');
      }),
  },
  failSend: {
    from: ['sending', 'sent'],
    move: (id) =>
      store.write((ctx) => {
        failSend(ctx, id, 'boom');
      }),
  },
  markReturned: {
    from: ['sent'],
    move: (id) =>
      store.write((ctx) => {
        markReturned(ctx, id, 'timer');
      }),
  },
  keepWaiting: {
    from: ['sent'],
    move: (id) =>
      store.write((ctx) => {
        keepWaiting(ctx, id, T0);
      }),
  },
  dropDraft: {
    from: ['draft'],
    move: (id) =>
      store.write((ctx) => {
        dropDraft(ctx, id);
      }),
  },
};

/** A send in each state, reached by the real moves. */
function sendIn(state: SendState) {
  const w = world();
  const s = draft(w.card('q'), [w.mark.id]);
  if (state === 'draft') return s;
  store.write((ctx) => {
    markSending(ctx, s.id, { textSha256: 'a', threadTs: null, startedAt: T0 });
  });
  if (state === 'sending') return s;
  store.write((ctx) => {
    markSent(ctx, s.id, {
      channelId: 'D1',
      threadTs: '1.1',
      messageTs: '1.1',
      permalink: null,
      at: T0,
    });
  });
  if (state === 'sent') return s;
  if (state === 'answered')
    store.write((ctx) => {
      markAnswered(ctx, s.id, {
        reply: { text: 'A', userId: 'U1', ts: '4.1' },
        readAs: 'option',
        answeredBy: w.mark.id,
        replyVia: 'thread',
      });
    });
  else if (state === 'closed')
    store.write((ctx) => {
      closeSend(ctx, s.id, 'builder');
    });
  else
    store.write((ctx) => {
      failSend(ctx, s.id, 'boom');
    });
  return s;
}

const STATES: SendState[] = ['draft', 'sending', 'sent', 'answered', 'closed', 'failed'];
const CASES = Object.entries(MOVES).flatMap(([name, { move, from }]) =>
  STATES.map((state) => ({ name, move, state, allowed: from.includes(state) })),
);

describe('a send moves only along its states', () => {
  it.each(CASES)('$name from $state is allowed: $allowed', ({ move, state, allowed }) => {
    const s = sendIn(state);
    const before = store.db.$client
      .prepare('SELECT * FROM stakeholder_sends WHERE id = ?')
      .get(s.id);
    if (allowed) {
      move(s.id);
      return;
    }
    expect(() => {
      move(s.id);
    }).toThrow(ConflictError);
    expect(
      store.db.$client.prepare('SELECT * FROM stakeholder_sends WHERE id = ?').get(s.id),
    ).toEqual(before);
  });
});

describe('sends', () => {
  it('sets the cursor to the message and starts the wait when sent', () => {
    const w = world();
    const s = draft(w.card('q'), [w.mark.id]);
    sent(s.id, T0);
    const [open] = openSends(store.db);
    expect(open).toMatchObject({
      id: s.id,
      channelId: 'D1',
      threadTs: '100.1',
      messageTs: '100.1',
      lastReadTs: '100.1',
      waitStartedAt: T0,
      sentAt: T0,
    });
    expect(open?.people.map((p) => p.userId)).toEqual(['U1']);
    expect(sendForCard(store.db, s.inboxItemId)?.state).toBe('sent');
    expect(sendingSends(store.db)).toEqual([]);
  });

  it('lists a send that is mid-sending with its thread and start', () => {
    const w = world();
    const s = draft(w.card('q'), [w.mark.id]);
    store.write((ctx) => {
      markSending(ctx, s.id, { textSha256: 'a', threadTs: '9.9', startedAt: T0 });
    });
    expect(sendingSends(store.db)).toMatchObject([{ id: s.id, threadTs: '9.9', startedAt: T0 }]);
  });

  it('round-trips a draft edit, a hold and the settle, which-way, approval and lone marks', () => {
    const w = world();
    const s = draft(w.card('q'), [w.mark.id]);
    store.write((ctx) => {
      updateDraft(ctx, s.id, {
        text: 'Edited',
        hits: [{ pattern: 'url', line: 1, severity: 'hold' }],
      });
    });
    store.write((ctx) => {
      setHeldBy(ctx, s.id, 'scan');
    });
    expect(sendForCard(store.db, s.inboxItemId)).toMatchObject({
      text: 'Edited',
      heldBy: 'scan',
      hits: [{ pattern: 'url', line: 1, severity: 'hold' }],
    });
    sent(s.id);
    store.write((ctx) => {
      markSettled(ctx, s.id, '101.1');
    });
    store.write((ctx) => {
      markAskedWhichWay(ctx, s.id, { at: T0, ts: '102.1', throughTs: '103.1' });
    });
    store.write((ctx) => {
      markApprovalSeen(ctx, s.id, { at: T0, by: w.mark.id });
    });
    store.write((ctx) => {
      markLoneReplyPending(ctx, s.id, T0);
    });
    expect(openSends(store.db)[0]).toMatchObject({
      settledThroughTs: '103.1',
      askedWhichWayAt: T0,
      askedWhichWayTs: '102.1',
      approvalSeenAt: T0,
      approvalBy: w.mark.id,
      loneReplyPendingSince: T0,
    });
    store.write((ctx) => {
      markApprovalSeen(ctx, s.id, null);
    });
    store.write((ctx) => {
      markLoneReplyPending(ctx, s.id, null);
    });
    expect(openSends(store.db)[0]).toMatchObject({
      approvalSeenAt: null,
      loneReplyPendingSince: null,
    });
  });

  it('keeps the old thread when a send moves, and finds it by either', () => {
    const w = world();
    const s = draft(w.card('q'), [w.mark.id, w.ana.id]);
    sent(s.id);
    store.write((ctx) => {
      moveSend(ctx, s.id, {
        channelId: 'G1',
        threadTs: '200.1',
        messageTs: '200.1',
        permalink: null,
        added: [{ userId: 'U3', personId: null, name: 'Zed', recipient: false }],
      });
    });
    const [open] = openSends(store.db);
    expect(open).toMatchObject({
      channelId: 'G1',
      threadTs: '200.1',
      lastReadTs: '200.1',
      movedFrom: { channelId: 'D1', threadTs: '100.1', lastReadTs: '100.1' },
    });
    expect(open?.people.map((p) => [p.userId, p.recipient])).toEqual([
      ['U1', true],
      ['U2', true],
      ['U3', false],
    ]);
    expect(sendsInThread(store.db, 'D1', '100.1').map((x) => x.id)).toEqual([s.id]);
    expect(sendsInThread(store.db, 'G1', '200.1').map((x) => x.id)).toEqual([s.id]);
    expect(sendsInThread(store.db, 'D1', 'other')).toEqual([]);
  });

  it('keepWaiting clears the reminder and the return and restarts the wait', () => {
    const w = world();
    const s = draft(w.card('q'), [w.mark.id]);
    sent(s.id);
    store.write((ctx) => {
      markReminded(ctx, s.id, T0);
    });
    store.write((ctx) => {
      markReturned(ctx, s.id, 'timer');
    });
    expect(openSends(store.db)[0]).toMatchObject({ remindedAt: T0 });
    expect(openSends(store.db)[0]?.returnedAt).not.toBeNull();
    const later = '2026-11-12T18:00:00.000Z';
    store.write((ctx) => {
      keepWaiting(ctx, s.id, later);
    });
    expect(openSends(store.db)[0]).toMatchObject({
      remindedAt: null,
      returnedAt: null,
      waitStartedAt: later,
    });
  });

  it('an answered send leaves the open list and records the reply', () => {
    const w = world();
    const s = draft(w.card('q'), [w.mark.id]);
    sent(s.id);
    store.write((ctx) => {
      markAnswered(ctx, s.id, {
        reply: { text: 'B', userId: 'U1', ts: '5.1' },
        readAs: 'option',
        answeredBy: w.mark.id,
        replyVia: 'top_level',
      });
    });
    expect(openSends(store.db)).toEqual([]);
    expect(sendForCard(store.db, s.inboxItemId)).toMatchObject({
      state: 'answered',
      reply: { text: 'B', userId: 'U1', ts: '5.1' },
      replyVia: 'top_level',
      readAs: 'option',
      answeredBy: w.mark.id,
    });
  });

  it('refuses a second live send for one card', () => {
    const w = world();
    const id = w.card('q');
    draft(id, [w.mark.id]);
    expect(() => draft(id, [w.mark.id])).toThrow();
  });

  it.each(['closed', 'failed', 'answered'] as const)(
    'allows a new send after the last one is %s, and the card reads the new one',
    (state) => {
      const w = world();
      const id = w.card('q');
      const first = draft(id, [w.mark.id]);
      sent(first.id);
      if (state === 'closed')
        store.write((ctx) => {
          closeSend(ctx, first.id, 'taken_back');
        });
      else if (state === 'failed')
        store.write((ctx) => {
          failSend(ctx, first.id, 'down');
        });
      else
        store.write((ctx) => {
          markAnswered(ctx, first.id, {
            reply: { text: 'A', userId: 'U1', ts: '5.1' },
            readAs: 'option',
            answeredBy: w.mark.id,
            replyVia: 'thread',
          });
        });
      const second = draft(id, [w.ana.id]);
      expect(sendForCard(store.db, id)).toMatchObject({ id: second.id, state: 'draft' });
    },
  );
});

describe('the daily limit counts new threads', () => {
  const SINCE = '2026-11-11T10:00:00.000Z';

  it('counts a new thread once per recipient, and a failed send, a follow-up and a reminder never', () => {
    const w = world();
    const a = draft(w.card('a'), [w.mark.id, w.ana.id]);
    sent(a.id, T0);
    const followUp = draft(w.card('b'), [w.mark.id]);
    sent(followUp.id, T0, '100.1');
    const failed = draft(w.card('c'), [w.mark.id]);
    store.write((ctx) => {
      markSending(ctx, failed.id, { textSha256: 'a', threadTs: null, startedAt: T0 });
    });
    store.write((ctx) => {
      failSend(ctx, failed.id, 'down');
    });
    store.write((ctx) => {
      markReminded(ctx, a.id, T0);
    });
    store.write((ctx) => {
      moveSend(ctx, a.id, {
        channelId: 'G1',
        threadTs: '9.1',
        messageTs: '9.1',
        permalink: null,
        added: [],
      });
    });
    expect(newThreadsSince(store.db, w.mark.id, SINCE)).toBe(1);
    expect(newThreadsSince(store.db, w.ana.id, SINCE)).toBe(1);
  });

  it('ignores threads older than the window', () => {
    const w = world();
    const a = draft(w.card('a'), [w.mark.id]);
    sent(a.id, '2026-11-10T10:00:00.000Z');
    expect(newThreadsSince(store.db, w.mark.id, SINCE)).toBe(0);
  });

  it('knows who has ever been sent to', () => {
    const w = world();
    expect(everSent(store.db, w.mark.id)).toBe(false);
    const a = draft(w.card('a'), [w.mark.id]);
    expect(everSent(store.db, w.mark.id)).toBe(false);
    sent(a.id);
    expect(everSent(store.db, w.mark.id)).toBe(true);
    expect(everSent(store.db, w.ana.id)).toBe(false);
  });
});

describe('latestThreadFor', () => {
  it('finds the open thread for the same people on the same task, and whether it was reviewed', () => {
    const w = world();
    const a = draft(w.card('a'), [w.mark.id]);
    store.write((ctx) => {
      setHeldBy(ctx, a.id, 'review');
    });
    store.write((ctx) => {
      markSending(ctx, a.id, { textSha256: 'a', threadTs: null, startedAt: T0 });
    });
    store.write((ctx) => {
      markSent(ctx, a.id, {
        channelId: 'D1',
        threadTs: '1.1',
        messageTs: '1.1',
        permalink: null,
        at: T0,
      });
    });
    expect(latestThreadFor(store.db, [w.mark.id], w.task.id)).toEqual({
      channelId: 'D1',
      threadTs: '1.1',
      reviewed: true,
    });
    expect(latestThreadFor(store.db, [w.mark.id, w.ana.id], w.task.id)).toBeNull();
    expect(latestThreadFor(store.db, [w.ana.id], w.task.id)).toBeNull();
  });

  it('is unreviewed when nothing held the send', () => {
    const w = world();
    const a = draft(w.card('a'), [w.mark.id]);
    sent(a.id);
    expect(latestThreadFor(store.db, [w.mark.id], w.task.id)?.reviewed).toBe(false);
  });

  it('skips a closed, failed or unsent thread', () => {
    const w = world();
    const a = draft(w.card('a'), [w.mark.id]);
    sent(a.id);
    store.write((ctx) => {
      closeSend(ctx, a.id, 'taken_back');
    });
    expect(latestThreadFor(store.db, [w.mark.id], w.task.id)).toBeNull();
  });
});
