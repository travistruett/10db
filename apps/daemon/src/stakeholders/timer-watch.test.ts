import { EventType, type InboxItemId } from '@10db/contracts';
import {
  createTestStore,
  insertDraft,
  insertInboxItem,
  insertPerson,
  markLoneReplyPending,
  markReminded,
  markSending,
  markSent,
  openSends,
  setStakeholderTimers,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createTimerWatch } from './timer-watch';

let store: Store;
let close: () => void;
let state: StateStore;
let bus: EventBus;
let clock: ManualClock;
let changes: string[];

const HOUR = 3_600_000;

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  bus = createEventBus();
  changes = [];
  bus.subscribe((e) => {
    if (e.type === EventType.StakeholderSendChanged) changes.push(e.entityId);
  });
  state = createStateStore(store, bus);
});
afterEach(() => {
  close();
});

/** A question sent now to Mark, waiting for his answer. */
let people = 0;
function sentNow(): { cardId: InboxItemId; sendId: string } {
  people += 1;
  const ws = seedWorkstream(store);
  const mark = store.write((ctx) =>
    insertPerson(ctx, {
      handle: `mark${String(people)}`,
      name: 'Mark',
      slack: { teamId: 'T1', userId: `U${String(people)}`, sendMode: 'auto', dailyLimit: 10 },
    }),
  ).value;
  const card = store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId: ws.project.id,
      kind: 'question',
      title: 'Q?',
      body: '',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: ws.workstream.id, sessionId: null }],
    }),
  ).value;
  const at = clock.now().toISOString();
  const send = store.write((ctx) => {
    const draft = insertDraft(ctx, {
      inboxItemId: card.id,
      recipients: [mark.id],
      text: 'Q',
      hits: [],
    });
    markSending(ctx, draft.id, { textSha256: 'x', threadTs: null, channelId: 'D1', startedAt: at });
    markSent(ctx, draft.id, {
      channelId: 'D1',
      threadTs: '1.1',
      messageTs: '1.1',
      permalink: null,
      at,
    });
    return draft;
  }).value;
  return { cardId: card.id, sendId: send.id };
}

const returned = () => openSends(store.db).map((s) => s.returnedAt !== null);
const watch = () => createTimerWatch({ state, clock, log: silentLogger });

describe('the timer watch', () => {
  it('returns a send to the builder at eight hours, with no Slack, and leaves it sent', async () => {
    sentNow();
    clock.advance(7 * HOUR);
    await watch().tick();
    expect(returned()).toEqual([false]);
    clock.advance(HOUR);
    await watch().tick();
    expect(returned()).toEqual([true]);
    expect(openSends(store.db)).toHaveLength(1);
  });

  it('returns once when two ticks race on one due send', async () => {
    sentNow();
    clock.advance(9 * HOUR);
    const w = watch();
    changes.length = 0;
    await Promise.all([w.tick(), w.tick(), watch().tick()]);
    expect(changes).toHaveLength(1);
    expect(returned()).toEqual([true]);
  });

  it('returns each of two sends, even with no Slack, after eight hours', async () => {
    sentNow();
    sentNow();
    clock.advance(8 * HOUR);
    await watch().tick();
    expect(returned()).toEqual([true, true]);
  });

  it('fires the return once, not the reminder, when the Mac slept from three to ten hours', async () => {
    sentNow();
    clock.advance(3 * HOUR);
    await watch().tick();
    clock.advance(7 * HOUR);
    await watch().tick();
    expect(returned()).toEqual([true]);
    expect(openSends(store.db)[0]?.remindedAt).toBeNull();
    changes.length = 0;
    clock.advance(HOUR);
    await watch().tick();
    expect(changes).toEqual([]);
  });

  it('leaves a reminder for the reply watch: it never marks one', async () => {
    sentNow();
    clock.advance(5 * HOUR);
    await watch().tick();
    expect(openSends(store.db)[0]?.remindedAt).toBeNull();
    expect(returned()).toEqual([false]);
  });

  it('holds the return one tick for a lone reply already waiting, then returns it', async () => {
    const { sendId } = sentNow();
    clock.advance(7 * HOUR + 59 * 60_000);
    store.write((ctx) => {
      markLoneReplyPending(ctx, sendId as never, clock.now().toISOString());
    });
    clock.advance(60_000);
    await watch().tick();
    expect(returned()).toEqual([false]);
    clock.advance(3 * 60_000);
    await watch().tick();
    expect(returned()).toEqual([true]);
  });

  it('does not return a send that was reminded and then answered by the clock alone before eight hours', async () => {
    const { sendId } = sentNow();
    clock.advance(4 * HOUR);
    store.write((ctx) => {
      markReminded(ctx, sendId as never, clock.now().toISOString());
    });
    clock.advance(3 * HOUR);
    await watch().tick();
    expect(returned()).toEqual([false]);
  });

  it('applies a changed setting to open sends from the next tick', async () => {
    sentNow();
    clock.advance(3 * HOUR);
    await watch().tick();
    expect(returned()).toEqual([false]);
    store.write((ctx) => {
      setStakeholderTimers(ctx, { remindAfterHours: 1, returnAfterHours: 2 });
    });
    await watch().tick();
    expect(returned()).toEqual([true]);
  });

  it('ticks on its own interval after start, and stop waits for the tick in flight', async () => {
    sentNow();
    const w = createTimerWatch({ state, clock, log: silentLogger, intervalMs: 60_000 });
    w.start();
    clock.advance(9 * HOUR);
    await w.stop();
    expect(returned()).toEqual([true]);
  });
});
