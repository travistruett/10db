import {
  ConflictError,
  InvalidError,
  InboxState,
  PARK_TASK_CHOICE,
  RoutedBy,
  type InboxItemId,
  type PersonDto,
  type StakeholderSendDto,
} from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  insertInboxItem,
  insertPerson,
  listInbox,
  markReturned,
  moveSend,
  updateInboxItem,
  listRoutingRules,
  newThreadsSince,
  sendForCard,
  setRoutingRules,
  updatePerson,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { FakeSlack } from '../../test/fake-slack';
import type { SlackClient, SlackMessage } from '../slack';
import { draftContext, draftFor } from './drafts';
import { createStakeholderSends, type StakeholderSends } from './sends';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let slack: FakeSlack;
let sends: StakeholderSends;
let parked: InboxItemId[];

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  slack = new FakeSlack();
  parked = [];
  sends = build(slack);
});
afterEach(() => {
  close();
});

function build(client: SlackClient | null): StakeholderSends {
  return createStakeholderSends({
    state,
    slack: client,
    clock,
    log: silentLogger,
    parkFor: (id) => parked.push(id),
  });
}

const contact = (
  userId: string,
  over: { sendMode?: 'auto' | 'review'; dailyLimit?: number | null } = {},
) => ({
  teamId: 'T1',
  userId,
  sendMode: over.sendMode ?? ('auto' as const),
  dailyLimit: over.dailyLimit === undefined ? 10 : over.dailyLimit,
});

function world() {
  const ws = seedWorkstream(store);
  const person = (handle: string, slackOver: Parameters<typeof contact>[1] = {}): PersonDto =>
    store.write((ctx) =>
      insertPerson(ctx, {
        handle,
        name: handle.charAt(0).toUpperCase() + handle.slice(1),
        slack: contact(`U-${handle}`, slackOver),
      }),
    ).value;
  store.write((ctx) => insertPerson(ctx, { handle: 'me', name: 'Travis', isBuilder: true }));
  const route = (people: PersonDto[]) =>
    store.write((ctx) =>
      setRoutingRules(ctx, ws.project.id, {
        rules: people.map((p) => ({ category: 'product' as const, area: 'api', personId: p.id })),
      }),
    );
  /** A routed card with its draft, written as the daemon writes them; afterDraft is not yet called. */
  let tasks = 0;
  /** Each card is asked by a task of its own, unless it is given one: a follow-up shares its task. */
  const card = (
    title = 'Charge tax?',
    body = 'For EU customers',
    on: ReturnType<typeof seedWorkstream> | null = null,
  ): InboxItemId => {
    tasks += 1;
    const asker =
      on ?? seedWorkstream(store, { project: ws.project, title: `Task ${String(tasks)}` });
    return store.write((ctx) => {
      const item = insertInboxItem(ctx, {
        projectId: ws.project.id,
        kind: 'question',
        title,
        body,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        recommendation: 'Yes',
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: `${title}${body}`,
        targets: [{ workstreamId: asker.workstream.id, sessionId: null }],
      });
      draftFor(ctx, item, {
        ...draftContext(ctx.tx, item),
        afterDraft: () => undefined,
        log: silentLogger,
      });
      return item.id;
    }).value;
  };
  return {
    ws,
    person,
    route,
    card,
    nextAsker: () => seedWorkstream(store, { project: ws.project, title: 'Shared' }),
  };
}

const send = (id: InboxItemId): StakeholderSendDto => {
  const found = sendForCard(store.db, id);
  if (!found) throw new Error('no send');
  return found;
};

/** Marks a person as already sent to, so the first-send review no longer applies. */
async function seasoned(w: ReturnType<typeof world>, person: PersonDto): Promise<void> {
  w.route([person]);
  const first = w.card('Earlier?', 'x');
  await sends.afterDraft(first);
  await sends.send(first, {});
  slack.posts.length = 0;
}

describe('afterDraft', () => {
  it('sends at once in auto mode after a first send', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    const id = w.card();
    await sends.afterDraft(id);
    expect(send(id)).toMatchObject({ state: 'sent', heldBy: null });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({
      channel: 'D-U-mark',
      metadata: { eventType: 'tendb_send', eventPayload: { sendId: send(id).id } },
    });
    expect(slack.posts[0]?.threadTs).toBeUndefined();
  });

  it('leaves the draft held for review in review mode and calls Slack not at all', async () => {
    const w = world();
    const mark = w.person('mark', { sendMode: 'review' });
    w.route([mark]);
    const id = w.card();
    await sends.afterDraft(id);
    expect(send(id)).toMatchObject({ state: 'draft', heldBy: 'first_send' });
    expect(slack.posts).toEqual([]);
    expect(slack.opened).toEqual([]);
  });

  it('holds the first send to a person even in auto mode', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    expect(send(id)).toMatchObject({ state: 'draft', heldBy: 'first_send' });
  });

  it('holds review for a seasoned person in review mode', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    store.write((ctx) =>
      updatePerson(ctx, mark.id, {
        handle: 'mark',
        name: 'Mark',
        slack: contact('U-mark', { sendMode: 'review' }),
      }),
    );
    const id = w.card();
    await sends.afterDraft(id);
    expect(send(id).heldBy).toBe('review');
  });

  it('holds a url even in auto mode, and a path only warns', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    const url = w.card('See https://example.com', 'x');
    await sends.afterDraft(url);
    expect(send(url)).toMatchObject({ state: 'draft', heldBy: 'scan' });
    const path = w.card('Edit src/api/a.ts?', 'y');
    await sends.afterDraft(path);
    expect(send(path).state).toBe('sent');
    expect(send(path).hits.map((h) => h.severity)).toEqual(['warn']);
  });

  it('sends the tenth new thread in 24 hours and holds the eleventh', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: 10 });
    await seasoned(w, mark);
    // The earlier send was the first; nine more make ten.
    for (let i = 0; i < 9; i += 1) {
      const id = w.card(`Q${String(i)}?`, String(i));
      await sends.afterDraft(id);
      expect(send(id).state).toBe('sent');
    }
    const eleventh = w.card('Q10?', 'z');
    await sends.afterDraft(eleventh);
    expect(send(eleventh)).toMatchObject({ state: 'draft', heldBy: 'limit' });
  });

  it('refuses Send on a limit draft without overrideLimit, and posts with it', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: 1 });
    await seasoned(w, mark);
    const id = w.card('Over?', 'x');
    await sends.afterDraft(id);
    expect(send(id).heldBy).toBe('limit');
    await expect(sends.send(id, {})).rejects.toBeInstanceOf(ConflictError);
    await sends.send(id, { overrideLimit: true });
    expect(send(id).state).toBe('sent');
  });

  it('does not count a failed send toward the limit', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: 2 });
    await seasoned(w, mark);
    slack.failNext('chat.postMessage', 'channel_not_found');
    const failed = w.card('Fails?', 'a');
    await sends.afterDraft(failed);
    expect(send(failed).state).toBe('failed');
    const next = w.card('Next?', 'b');
    await sends.afterDraft(next);
    expect(send(next).state).toBe('sent');
  });

  it('never makes a person with the limit off wait on it', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: null });
    await seasoned(w, mark);
    for (let i = 0; i < 12; i += 1) {
      const id = w.card(`Q${String(i)}?`, String(i));
      await sends.afterDraft(id);
      expect(send(id).state).toBe('sent');
    }
  });

  it('posts a follow-up on the same task in the first thread, skipping review and the limit', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: 1, sendMode: 'review' });
    w.route([mark]);
    const task = w.nextAsker();
    const first = w.card('First?', 'a', task);
    await sends.afterDraft(first);
    await sends.send(first, {});
    const parent = slack.posts[0];
    const second = w.card('Second?', 'b', task);
    await sends.afterDraft(second);
    expect(send(second).state).toBe('sent');
    expect(slack.posts[1]?.threadTs).toBe(parent?.ts);
    expect(slack.posts[1]?.channel).toBe(parent?.channel);
    // A follow-up is not a new thread, so it does not count toward the limit either.
    const third = w.card('Third?', 'c', task);
    await sends.afterDraft(third);
    expect(send(third).state).toBe('sent');
    expect(slack.posts[2]?.threadTs).toBe(parent?.ts);
  });

  it('opens one group DM for a tie, posts once, and names them in routing order', async () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana');
    w.route([ana, mark]);
    const id = w.card();
    await sends.afterDraft(id);
    expect(send(id)).toMatchObject({ heldBy: 'first_send' });
    await sends.send(id, {});
    expect(slack.opened).toEqual([{ kind: 'group', users: ['U-ana', 'U-mark'] }]);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toContain('has a question for Ana and Mark.');
  });

  it('holds a tie while one recipient is on review, and counts a sent tie once for each', async () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana', { sendMode: 'review' });
    await seasoned(w, mark);
    await seasoned(w, ana);
    w.route([mark, ana]);
    const tie = w.card('Tie?', 't');
    await sends.afterDraft(tie);
    expect(send(tie)).toMatchObject({ state: 'draft', heldBy: 'review' });
    await sends.send(tie, {});
    expect(send(tie).state).toBe('sent');
    const since = new Date(clock.now().getTime() - 24 * 3600_000).toISOString();
    expect(newThreadsSince(store.db, mark.id, since)).toBe(2);
    expect(newThreadsSince(store.db, ana.id, since)).toBe(2);
  });

  it('holds a tie while one recipient is at the limit', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: 1 });
    const ana = w.person('ana');
    await seasoned(w, mark);
    await seasoned(w, ana);
    w.route([mark, ana]);
    const tie = w.card('Tie?', 't');
    await sends.afterDraft(tie);
    expect(send(tie)).toMatchObject({ state: 'draft', heldBy: 'limit' });
  });

  it('leaves every draft as it is when Slack is off', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    const off = build(null);
    await off.afterDraft(id);
    expect(send(id)).toMatchObject({ state: 'draft', heldBy: null });
    await expect(off.send(id, {})).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('send', () => {
  it('escapes an edited text so a ping typed by mistake does not reach the workspace', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    await sends.send(id, { text: 'Hey <!channel> what about <@U123>?' });
    expect(slack.posts[0]?.text).not.toContain('<!channel>');
    expect(slack.posts[0]?.text).not.toContain('<@U123>');
    expect(slack.posts[0]?.text).toContain('&lt;');
  });

  it('posts an edited text and stores its hash', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    await sends.send(id, { text: 'Hi Mark, tax for the EU?' });
    expect(slack.posts[0]?.text).toBe('Hi Mark, tax for the EU?');
    const row = store.db.$client
      .prepare('SELECT text, text_sha256 FROM stakeholder_sends')
      .get() as { text: string; text_sha256: string };
    expect(row.text).toBe('Hi Mark, tax for the EU?');
    expect(row.text_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a held text, and sends once the edit clears the hold', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card('See https://example.com', 'x');
    await sends.afterDraft(id);
    await expect(sends.send(id, {})).rejects.toThrow(InvalidError);
    await expect(sends.send(id, { overrideLimit: true })).rejects.toThrow(/url/);
    expect(slack.posts).toEqual([]);
    await sends.send(id, { text: 'Charge tax for EU customers?' });
    expect(send(id).state).toBe('sent');
  });

  it('refuses with a conflict when the card has no draft', async () => {
    const w = world();
    const id = w.card();
    await expect(sends.send(id, {})).rejects.toBeInstanceOf(ConflictError);
    w.route([w.person('mark')]);
    const routed = w.card('Routed?', 'r');
    await sends.afterDraft(routed);
    await sends.send(routed, {});
    await expect(sends.send(routed, {})).rejects.toBeInstanceOf(ConflictError);
  });

  it('fails the send on channel_not_found and gives the card to the builder', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'channel_not_found');
    await sends.send(id, {});
    expect(send(id)).toMatchObject({ state: 'failed', error: 'channel_not_found' });
    expect(getInboxItem(store.db, id)).toMatchObject({ assignees: ['me'], routedBy: 'builder' });
  });

  it('keeps the draft with a 409 when there is no token at Send', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('conversations.open', 'no_token');
    await expect(sends.send(id, {})).rejects.toBeInstanceOf(ConflictError);
    expect(send(id).state).toBe('draft');
    await sends.send(id, {});
    expect(send(id).state).toBe('sent');
  });

  it('fails the send when the token goes at the post', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'no_token');
    await sends.send(id, {});
    expect(send(id)).toMatchObject({ state: 'failed', error: 'no_token' });
    expect(getInboxItem(store.db, id).assignees).toEqual(['me']);
  });

  it('keeps a send mid-sending when Slack is unreachable at the post, and reposts on the next good tick', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'timeout');
    await sends.send(id, {});
    expect(send(id).state).toBe('sending');
    await sends.recoverSending();
    expect(send(id).state).toBe('sent');
    expect(slack.posts).toHaveLength(1);
  });
});

describe('recoverSending', () => {
  async function crashedMidPost(): Promise<{ id: InboxItemId; sendId: string }> {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'unreachable');
    await sends.send(id, {});
    return { id, sendId: send(id).id };
  }
  const posted = (sendId: string, ts: string, threadTs: string | null = null): SlackMessage => ({
    ts,
    threadTs,
    user: null,
    botId: 'B1',
    subtype: null,
    text: 'q',
    edited: false,
    reactions: [],
    metadata: { eventType: 'tendb_send', eventPayload: { sendId } },
  });

  it('finds a posted new thread by its metadata and does not post twice', async () => {
    const { id, sendId } = await crashedMidPost();
    slack.found = [posted(sendId, '777.000100')];
    await build(slack).recoverSending();
    expect(send(id).state).toBe('sent');
    expect(slack.posts).toEqual([]);
    const row = store.db.$client
      .prepare('SELECT message_ts, thread_ts, last_read_ts FROM stakeholder_sends')
      .get() as Record<string, string>;
    expect(row).toEqual({
      message_ts: '777.000100',
      thread_ts: '777.000100',
      last_read_ts: '777.000100',
    });
  });

  it('posts when it finds none', async () => {
    const { id } = await crashedMidPost();
    slack.found = [];
    await build(slack).recoverSending();
    expect(send(id).state).toBe('sent');
    expect(slack.posts).toHaveLength(1);
  });

  it('ignores a message that names another send', async () => {
    const { id } = await crashedMidPost();
    slack.found = [posted('snd_other', '777.000100')];
    await build(slack).recoverSending();
    expect(slack.posts).toHaveLength(1);
    expect(send(id).state).toBe('sent');
  });

  it('finds a posted follow-up inside its thread the same way', async () => {
    const w = world();
    const mark = w.person('mark', { sendMode: 'review' });
    w.route([mark]);
    const task = w.nextAsker();
    const first = w.card('First?', 'a', task);
    await sends.afterDraft(first);
    await sends.send(first, {});
    const parent = slack.posts[0]?.ts ?? '';
    const second = w.card('Second?', 'b', task);
    slack.failNext('chat.postMessage', 'unreachable');
    await sends.afterDraft(second);
    expect(send(second).state).toBe('sending');
    slack.found = [posted(send(second).id, '888.000100', parent)];
    const before = slack.posts.length;
    await build(slack).recoverSending();
    expect(send(second).state).toBe('sent');
    expect(slack.posts).toHaveLength(before);
    const row = store.db.$client
      .prepare('SELECT thread_ts, message_ts FROM stakeholder_sends WHERE id = ?')
      .get(send(second).id) as Record<string, string>;
    expect(row).toEqual({ thread_ts: parent, message_ts: '888.000100' });
  });
});

describe('connection and in-flight cells', () => {
  async function inFlight() {
    const w = world();
    const mark = w.person('mark', { sendMode: 'review' });
    w.route([mark]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'unreachable');
    await sends.send(id, {});
    expect(send(id).state).toBe('sending');
    return { w, id, mark };
  }

  it('fails a send, and gives the card to the builder, when Slack refuses the token', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'invalid_auth');
    await sends.send(id, {});
    expect(send(id)).toMatchObject({ state: 'failed', error: 'invalid_auth' });
    expect(getInboxItem(store.db, id).assignees).toEqual(['me']);
  });

  it.each(['http_500', 'http_502', 'http_503'])(
    'treats %s like an unreachable Slack: the post stays in flight, the open keeps the draft',
    async (code) => {
      const w = world();
      w.route([w.person('mark', { sendMode: 'review' })]);
      const id = w.card();
      await sends.afterDraft(id);
      slack.failNext('chat.postMessage', code);
      await sends.send(id, {});
      expect(send(id).state).toBe('sending');
      const other = w.card('Other?', 'o');
      store.db.$client.prepare('UPDATE person_contacts SET dm_channel_id = NULL').run();
      await sends.afterDraft(other);
      slack.failNext('conversations.open', code);
      await expect(sends.send(other, {})).rejects.toBeInstanceOf(ConflictError);
      expect(send(other).state).toBe('draft');
    },
  );

  it('refuses Send and Ask Someone on a send that is mid-post', async () => {
    const { id, w } = await inFlight();
    const ana = w.person('ana');
    await expect(sends.send(id, {})).rejects.toBeInstanceOf(ConflictError);
    expect(() => {
      sends.askSomeone(id, { personIds: [ana.id], always: null });
    }).toThrow(/Take it back first/);
  });

  it('closes a send taken back mid-post once it lands, then says so', async () => {
    const { id } = await inFlight();
    await sends.takeBack(id);
    expect(send(id).state).toBe('sending');
    expect(slack.posts).toEqual([]);
    await sends.recoverSending();
    expect(slack.posts.map((p) => p.text).at(-1)).toBe(
      'Never mind this one, Travis has it. Thanks!',
    );
    expect(send(id).state).toBe('closed');
  });

  it('lets Ask Someone send again after a failed send', async () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana', { sendMode: 'review' });
    w.route([mark]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'channel_not_found');
    await sends.send(id, {});
    expect(send(id).state).toBe('failed');
    sends.askSomeone(id, { personIds: [ana.id], always: null });
    expect(send(id)).toMatchObject({ state: 'draft' });
    expect(send(id).people.map((p) => p.userId)).toEqual(['U-ana']);
  });
});

describe('a limit and a reservation decided together', () => {
  it('lets only one of two cards routed to one person at once pass the daily limit', async () => {
    const w = world();
    const mark = w.person('mark', { dailyLimit: 2 });
    await seasoned(w, mark);
    store.db.$client.prepare('UPDATE person_contacts SET dm_channel_id = NULL').run();
    const a = w.card('A?', 'a');
    const b = w.card('B?', 'b');
    await Promise.all([sends.afterDraft(a), sends.afterDraft(b)]);
    const states = [send(a), send(b)].map((x) => [x.state, x.heldBy]);
    expect(states.filter(([state]) => state === 'sent')).toHaveLength(1);
    expect(states).toContainEqual(['draft', 'limit']);
    expect(slack.posts).toHaveLength(1);
  });

  it('keeps an unheld draft in flight when the DM cannot be opened, and a good tick finishes it', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    store.db.$client.prepare('UPDATE person_contacts SET dm_channel_id = NULL').run();
    const id = w.card();
    slack.failNext('conversations.open', 'unreachable');
    await sends.afterDraft(id);
    expect(send(id)).toMatchObject({ state: 'sending', heldBy: null });
    await sends.recoverSending();
    expect(send(id).state).toBe('sent');
    expect(slack.posts).toHaveLength(1);
  });

  it('does not post a send a second time while this process still has its post in flight', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    const id = w.card();
    const release = slack.pause('chat.postMessage');
    const first = sends.afterDraft(id);
    for (let i = 0; i < 50 && send(id).state !== 'sending'; i += 1) await Promise.resolve();
    expect(send(id).state).toBe('sending');
    await sends.recoverSending();
    release();
    await first;
    expect(slack.posts).toHaveLength(1);
    expect(send(id).state).toBe('sent');
  });
});

describe('a reserved send whose card closed before its conversation was opened', () => {
  it('is closed without opening anything or posting', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    store.db.$client.prepare('UPDATE person_contacts SET dm_channel_id = NULL').run();
    const id = w.card();
    slack.failNext('conversations.open', 'unreachable');
    await sends.afterDraft(id);
    expect(send(id).state).toBe('sending');
    store.write((ctx) => updateInboxItem(ctx, id, { state: InboxState.Cancelled }));
    slack.calls.length = 0;
    await sends.recoverSending();
    expect(send(id).state).toBe('closed');
    expect(slack.calls).toEqual([]);
    expect(slack.posts).toEqual([]);
  });
});

describe('a send found after a crash', () => {
  async function inFlight(card?: (w: ReturnType<typeof world>) => void) {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'unreachable');
    await sends.send(id, {});
    expect(send(id).state).toBe('sending');
    card?.(w);
    return id;
  }

  it('closes a send whose card closed meanwhile without posting the question', async () => {
    const id = await inFlight();
    store.write((ctx) => updateInboxItem(ctx, id, { state: InboxState.Cancelled }));
    await sends.recoverSending();
    expect(send(id).state).toBe('closed');
    expect(slack.posts).toEqual([]);
  });

  it('dates a send it finds by the time of its message, not the time it was found', async () => {
    const id = await inFlight();
    const posted = Date.parse('2026-10-13T12:00:30.000Z') / 1000;
    slack.found = [
      {
        ts: `${String(posted)}.000100`,
        threadTs: null,
        user: 'UBOT',
        botId: 'B1',
        subtype: null,
        text: 'q',
        edited: false,
        reactions: [],
        metadata: { eventType: 'tendb_send', eventPayload: { sendId: send(id).id } },
      },
    ];
    clock.advance(5 * 3600_000);
    await sends.recoverSending();
    const row = store.db.$client
      .prepare('SELECT sent_at AS sentAt, wait_started_at AS waitStartedAt FROM stakeholder_sends')
      .get() as { sentAt: string; waitStartedAt: string };
    expect(row).toEqual({
      sentAt: '2026-10-13T12:00:30.000Z',
      waitStartedAt: '2026-10-13T12:00:30.000Z',
    });
  });
});

describe('Send on a card whose send failed', () => {
  it('drafts again for the same people and sends, handing the card back to them', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'channel_not_found');
    await sends.send(id, {});
    expect(send(id).state).toBe('failed');
    expect(getInboxItem(store.db, id).assignees).toEqual(['me']);
    const first = send(id).id;
    await sends.send(id, {});
    expect(send(id)).toMatchObject({ state: 'sent' });
    expect(send(id).id).not.toBe(first);
    expect(send(id).people.map((p) => p.userId)).toEqual(['U-mark']);
    expect(getInboxItem(store.db, id).assignees).toEqual(['mark']);
    expect(parked).toEqual([id]);
    expect(slack.posts).toHaveLength(1);
  });

  it('still refuses a card that was closed or answered', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.takeBack(id);
    await expect(sends.send(id, {})).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('a draft written before the builder had a name', () => {
  const rename = (name: string) => {
    store.db.$client.prepare('UPDATE people SET name = ? WHERE is_builder = 1').run(name);
  };

  it('is composed again at Send, so the message carries his name', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    rename('You');
    const id = w.card();
    expect(send(id).text).toContain("You's 10db build");
    rename('Travis');
    await sends.send(id, {});
    expect(slack.posts[0]?.text).toContain("Travis's 10db build");
    expect(slack.posts[0]?.text).not.toContain("You's");
    expect(send(id).text).toContain("Travis's 10db build");
  });

  it('is composed again when a failed send is drafted again', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'channel_not_found');
    await sends.send(id, {});
    rename('Ana-the-builder');
    await sends.send(id, {});
    expect(slack.posts[0]?.text).toContain("Ana-the-builder's 10db build");
  });

  it('keeps an edit whose Send failed before posting, so the next Send posts it', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    const noToken = createStakeholderSends({
      state,
      slack,
      clock,
      log: silentLogger,
      hasToken: () => Promise.resolve(false),
    });
    await expect(noToken.send(id, { text: 'My own words, kept' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(send(id).state).toBe('draft');
    await sends.send(id, {});
    expect(slack.posts[0]?.text).toBe('My own words, kept');
  });

  it('keeps a text the builder wrote himself', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    await sends.send(id, { text: 'My own words' });
    expect(slack.posts[0]?.text).toBe('My own words');
  });
});

describe('a builder who has not set his name', () => {
  const seedName = () => {
    store.db.$client.prepare("UPDATE people SET name = 'You' WHERE is_builder = 1").run();
  };

  it('refuses Send with a 409 that says where to set it, and keeps the draft', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    seedName();
    await expect(sends.send(id, {})).rejects.toThrow(/Set your name in Settings › People/);
    await expect(sends.send(id, {})).rejects.toBeInstanceOf(ConflictError);
    expect(send(id).state).toBe('draft');
    expect(slack.posts).toEqual([]);
  });

  it('holds an automatic send for review instead of posting "You\'s 10db build"', async () => {
    const w = world();
    const mark = w.person('mark');
    await seasoned(w, mark);
    const id = w.card();
    seedName();
    await sends.afterDraft(id);
    expect(send(id)).toMatchObject({ state: 'draft', heldBy: 'review' });
  });
});

describe('Send without a token', () => {
  it('is a 409 that keeps the draft, even when the DM is already known', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    store.db.$client.prepare("UPDATE person_contacts SET dm_channel_id = 'D-U-mark'").run();
    await sends.afterDraft(id);
    const noToken = createStakeholderSends({
      state,
      slack,
      clock,
      log: silentLogger,
      hasToken: () => Promise.resolve(false),
    });
    await expect(noToken.send(id, {})).rejects.toBeInstanceOf(ConflictError);
    expect(send(id).state).toBe('draft');
    expect(slack.posts).toEqual([]);
    await sends.send(id, {});
    expect(send(id).state).toBe('sent');
  });
});

describe('askSomeone', () => {
  it('writes one route per category and person, sets the recipients, drafts for review and parks the session', () => {
    const w = world();
    const mark = w.person('mark', { sendMode: 'review' });
    const id = w.card();
    sends.askSomeone(id, {
      personIds: [mark.id],
      always: { categories: ['product', 'design'], goalId: null, taskId: null },
    });
    expect(getInboxItem(store.db, id)).toMatchObject({
      assignees: ['mark'],
      routedBy: RoutedBy.Builder,
    });
    expect(send(id)).toMatchObject({ state: 'draft', heldBy: 'first_send' });
    expect(parked).toEqual([id]);
    const routes = listRoutingRules(store.db, w.ws.project.id).map((r) => r.category);
    expect(routes.sort()).toEqual(['design', 'product']);
    expect(slack.posts).toEqual([]);
  });

  it('drops an old draft and drafts for the new people', () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana');
    w.route([mark]);
    const id = w.card();
    const old = send(id);
    sends.askSomeone(id, { personIds: [ana.id], always: null });
    expect(send(id).id).not.toBe(old.id);
    expect(send(id).people.map((p) => p.userId)).toEqual(['U-ana']);
  });

  it('refuses on a sent card until the builder takes it back, then allows a new send', async () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana');
    w.route([mark]);
    const id = w.card();
    await sends.afterDraft(id);
    await sends.send(id, {});
    expect(() => {
      sends.askSomeone(id, { personIds: [ana.id], always: null });
    }).toThrow(/Take it back first/);
    await sends.takeBack(id);
    sends.askSomeone(id, { personIds: [ana.id], always: null });
    expect(send(id)).toMatchObject({ state: 'draft' });
    expect(send(id).people.map((p) => p.userId)).toEqual(['U-ana']);
  });
});

describe('keepWaiting', () => {
  it('refuses unless the card has come back, then restarts both timers from now', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    await sends.afterDraft(id);
    await sends.send(id, {});
    expect(() => {
      sends.keepWaiting(id);
    }).toThrow(ConflictError);
    clock.advance(9 * 3600_000);
    store.write((ctx) => {
      markReturned(ctx, send(id).id, 'timer');
    });
    sends.keepWaiting(id);
    expect(send(id)).toMatchObject({ state: 'sent', returnedAt: null, remindedAt: null });
    const waitStartedAt = store.db.$client
      .prepare('SELECT wait_started_at AS at FROM stakeholder_sends')
      .get() as { at: string };
    expect(waitStartedAt.at).toBe(clock.now().toISOString());
  });

  it('refuses a card with no live send, or one that was not sent', () => {
    const w = world();
    const id = w.card();
    expect(() => {
      sends.keepWaiting(id);
    }).toThrow(ConflictError);
  });
});

describe('takeBack', () => {
  it('closes the send and returns the card to the builder', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.afterDraft(id);
    await sends.send(id, {});
    await sends.takeBack(id);
    expect(send(id).state).toBe('closed');
    expect(getInboxItem(store.db, id)).toMatchObject({
      assignees: ['me'],
      routedBy: 'builder',
      state: 'OPEN',
    });
  });

  it('closes a draft quietly, and refuses without a send', async () => {
    const w = world();
    w.route([w.person('mark')]);
    const id = w.card();
    await sends.takeBack(id);
    expect(send(id).state).toBe('closed');
    expect(slack.posts).toEqual([]);
    await expect(sends.takeBack(id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a card with no send', async () => {
    const w = world();
    const id = w.card();
    await expect(sends.takeBack(id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('onCardChanged: the closing lines', () => {
  /** A card sent to Mark, with the line-bearing posts cleared. */
  async function sentCard() {
    const w = world();
    const mark = w.person('mark', { sendMode: 'review' });
    w.route([mark]);
    const id = w.card();
    await sends.afterDraft(id);
    await sends.send(id, {});
    slack.posts.length = 0;
    return { w, id, mark };
  }
  const settle = async (
    id: InboxItemId,
    patch: Parameters<typeof updateInboxItem>[2],
  ): Promise<void> => {
    const card = store.write((ctx) => updateInboxItem(ctx, id, patch)).value;
    await sends.onCardChanged(card);
  };
  const said = () => slack.posts.map((p) => p.text);

  it('posts "Travis answered this one: B. Thanks!" once when the builder answers', async () => {
    const { id } = await sentCard();
    await settle(id, { state: InboxState.Answered, answer: { choice: 'No' } });
    await sends.onCardChanged(getInboxItem(store.db, id));
    expect(said()).toEqual(['Travis answered this one: B. Thanks!']);
    expect(send(id).state).toBe('closed');
    expect(slack.posts[0]?.threadTs).toBeDefined();
  });

  it('posts the take-back line for a Park answer and never the label', async () => {
    const { id } = await sentCard();
    await settle(id, { state: InboxState.Resolved, answer: { choice: PARK_TASK_CHOICE } });
    expect(said()).toEqual(['Never mind this one, Travis has it. Thanks!']);
    expect(said().join()).not.toContain('Park');
  });

  it.each([
    ['cancelled', { state: InboxState.Cancelled }],
    ['expired', { state: InboxState.Expired }],
    ['resolved with no answer', { state: InboxState.Resolved }],
  ] as const)('posts "no longer needed" for a card that is %s', async (_name, patch) => {
    const { id } = await sentCard();
    await settle(id, patch);
    expect(said()).toEqual(['This one is no longer needed. Thanks!']);
    expect(send(id).state).toBe('closed');
  });

  it('posts nothing for a card answered through Slack', async () => {
    const { id } = await sentCard();
    await settle(id, {
      state: InboxState.Answered,
      answer: { choice: 'Yes', via: 'slack', answeredBy: 'mark' },
    });
    expect(said()).toEqual([]);
    expect(send(id).state).toBe('sent');
  });

  it('says nothing while the card is still open', async () => {
    const { id } = await sentCard();
    await sends.onCardChanged(getInboxItem(store.db, id));
    expect(said()).toEqual([]);
  });

  it('gives a card closed while its question was in flight, and found posted, the line after it', async () => {
    const w = world();
    w.route([w.person('mark', { sendMode: 'review' })]);
    const id = w.card();
    await sends.afterDraft(id);
    slack.failNext('chat.postMessage', 'timeout');
    await sends.send(id, {});
    expect(send(id).state).toBe('sending');
    await settle(id, { state: InboxState.Answered, answer: { choice: 'Yes' } });
    expect(slack.posts).toEqual([]);
    // The post had landed although its answer was lost.
    slack.found = [
      {
        ts: '5000.000100',
        threadTs: null,
        user: 'UBOT',
        botId: 'B1',
        subtype: null,
        text: 'q',
        edited: false,
        reactions: [],
        metadata: { eventType: 'tendb_send', eventPayload: { sendId: send(id).id } },
      },
    ];
    await sends.recoverSending();
    expect(said()).toEqual(['Travis answered this one: A. Thanks!']);
    expect(send(id).state).toBe('closed');
  });

  it('says the closing line in the group DM and in the DM it moved from', async () => {
    const { id } = await sentCard();
    const sendId = send(id).id;
    store.write((ctx) => {
      moveSend(ctx, sendId, {
        channelId: 'G-new',
        threadTs: '500.000100',
        messageTs: '500.000100',
        permalink: null,
        added: [],
      });
    });
    await settle(id, { state: InboxState.Answered, answer: { choice: 'Yes' } });
    expect(slack.posts.map((p) => p.channel)).toEqual(['G-new', 'D-U-mark']);
  });

  it('gives the builder line when he answers a card its people disagreed on', async () => {
    const { id } = await sentCard();
    store.write((ctx) => {
      markReturned(ctx, send(id).id, 'disagreed');
    });
    await settle(id, { state: InboxState.Answered, answer: { choice: 'Yes' } });
    expect(said()).toEqual(['Travis answered this one: A. Thanks!']);
  });

  it('logs a failing closing line and raises no card', async () => {
    const { id } = await sentCard();
    const before = listInbox(store.db, {}).length;
    slack.failNext('chat.postMessage', 'channel_not_found');
    await settle(id, { state: InboxState.Cancelled });
    expect(send(id).state).toBe('closed');
    expect(listInbox(store.db, {})).toHaveLength(before);
  });

  it.each([
    ['answered', { state: InboxState.Answered, answer: { choice: 'Yes' } }, 'builder'],
    ['cancelled', { state: InboxState.Cancelled }, 'cancelled'],
  ] as const)(
    'closes the draft of a card that is %s, posting nothing',
    async (_name, patch, closed) => {
      const w = world();
      w.route([w.person('mark', { sendMode: 'review' })]);
      const id = w.card();
      await settle(id, patch);
      expect(send(id).state).toBe('closed');
      const reason = store.db.$client
        .prepare('SELECT closed_reason AS reason FROM stakeholder_sends')
        .get() as { reason: string };
      expect(reason.reason).toBe(closed);
      expect(slack.posts).toEqual([]);
    },
  );
});
