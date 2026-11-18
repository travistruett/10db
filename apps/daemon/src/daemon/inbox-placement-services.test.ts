import { InboxPageQuery, type SlackConnectionDto } from '@10db/contracts';
import { insertDraft, insertInboxItem, insertPerson, markSending, markSent } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** Only the inbox page and the card's context run here, so the rest of the deps are absent. */
function inboxServices(state: SlackConnectionDto['state']) {
  const slackConnection = { get: () => ({ state }) as SlackConnectionDto };
  // A cast at a test boundary: these reads touch only the state store and the connection.
  return createServices({ state: h.state, slackConnection } as unknown as Parameters<
    typeof createServices
  >[0]);
}

/** An open card with a send that is out and has not come back. */
function sentCard() {
  return h.state.write((ctx) => {
    const card = insertInboxItem(ctx, {
      projectId: h.project.id,
      kind: 'question',
      title: 'Q',
      body: 'b',
      options: [],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [],
    });
    const ana = insertPerson(ctx, {
      handle: 'ana',
      name: 'Ana',
      slack: { teamId: 'T1', userId: 'U2', sendMode: 'review' as const, dailyLimit: 10 },
    });
    const draft = insertDraft(ctx, {
      inboxItemId: card.id,
      recipients: [ana.id],
      text: 'Hi',
      hits: [],
    });
    markSending(ctx, draft.id, { textSha256: 'abc', threadTs: null, startedAt: ctx.now });
    markSent(ctx, draft.id, {
      channelId: 'D1',
      threadTs: '100.1',
      messageTs: '100.1',
      permalink: 'https://x/p',
      at: ctx.now,
    });
    return card.id;
  });
}

describe('pageInbox placement follows the live Slack connection', () => {
  it.each([
    ['connected', false],
    ['refused', true],
    ['none', true],
    ['off', true],
    ['unreachable', true],
  ] as const)('with the connection %s, a sent card is in Open: %s', (state, inOpen) => {
    const id = sentCard();
    const services = inboxServices(state);
    const open = services.pageInbox(InboxPageQuery.parse({ state: 'open' }));
    expect(open.items.map((i) => i.id).includes(id)).toBe(inOpen);
    const waiting = services.pageInbox(InboxPageQuery.parse({ state: 'waiting' }));
    expect(waiting.items.map((i) => i.id)).toEqual([id]);
  });
});
