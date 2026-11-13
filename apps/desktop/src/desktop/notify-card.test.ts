import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../test/fixtures';
import { sendDto } from '../test/people-fixtures';
import {
  answeredNotice,
  disagreementNotices,
  shouldNotifyOpened,
  triagedToBuilder,
} from './notify-card';

describe('shouldNotifyOpened', () => {
  it.each([
    ['a plain card', inboxItemDto(), true],
    ['a card still being triaged', inboxItemDto({ routedBy: 'triage_pending' }), false],
    [
      'a card that went straight to Waiting',
      inboxItemDto({ send: sendDto({ state: 'sent' }) }),
      false,
    ],
    ['a card sending right now', inboxItemDto({ send: sendDto({ state: 'sending' }) }), false],
    [
      'a draft that waits for review',
      inboxItemDto({ send: sendDto({ state: 'draft', heldBy: 'review' }) }),
      true,
    ],
    [
      'a draft held at the limit',
      inboxItemDto({ send: sendDto({ state: 'draft', heldBy: 'limit' }) }),
      true,
    ],
    [
      'a draft nothing holds, which sends by itself',
      inboxItemDto({ send: sendDto({ state: 'draft', heldBy: null }) }),
      false,
    ],
  ])('%s: %s', (_name, item, expected) => {
    expect(shouldNotifyOpened(item)).toBe(expected);
  });
});

describe('triagedToBuilder', () => {
  it.each([
    ['triage left it with the builder', { routedBy: 'builder', toBuilder: true }, true],
    ['triage routed it away', { routedBy: 'judge', toBuilder: false }, false],
    ['a payload of another shape', { routedBy: 'judge' }, false],
    ['no payload', undefined, false],
  ])('%s', (_name, data, expected) => {
    expect(triagedToBuilder(data)).toBe(expected);
  });
});

describe('answeredNotice', () => {
  const mark = [{ personId: null, userId: 'U1', name: 'Mark', recipient: true }];
  const card = inboxItemDto({ title: 'How long?', send: sendDto({ state: 'sent', people: mark }) });

  it('names who answered and the question, from the card the client holds', () => {
    expect(answeredNotice({ inboxItemId: card.id, state: 'answered' }, [card])).toEqual({
      title: 'Mark answered',
      body: 'How long?',
    });
  });

  it.each([
    ['another state', { inboxItemId: card.id, state: 'sent' }],
    ['a card the client does not hold', { inboxItemId: 'inb_other', state: 'answered' }],
    ['a payload of another shape', { state: 'answered' }],
    ['no payload', undefined],
  ])('says nothing for %s', (_name, data) => {
    expect(answeredNotice(data, [card])).toBeNull();
  });
});

describe('disagreementNotices', () => {
  const people = [
    { personId: null, userId: 'U1', name: 'Mark', recipient: true },
    { personId: null, userId: 'U2', name: 'Ana', recipient: true },
  ];
  const before = inboxItemDto({ title: 'How long?', send: sendDto({ state: 'sent', people }) });
  const after = {
    ...before,
    send: sendDto({
      state: 'sent',
      people,
      returnedAt: '2026-11-12T10:00:00.000Z',
      returnedReason: 'disagreed',
    }),
  };

  it('says who disagree the first time a card is seen disagreeing', () => {
    expect(disagreementNotices([before], [after])).toEqual([
      { title: 'Mark and Ana disagree', body: 'How long?' },
    ]);
  });

  it('says it once, not on every refetch', () => {
    expect(disagreementNotices([after], [after])).toEqual([]);
  });

  it('says nothing for a card that was not held before', () => {
    expect(disagreementNotices([], [after])).toEqual([]);
  });

  it('says nothing for a timer return', () => {
    const timer = {
      ...before,
      send: sendDto({
        state: 'sent',
        people,
        returnedAt: '2026-11-12T10:00:00.000Z',
        returnedReason: 'timer',
      }),
    };
    expect(disagreementNotices([before], [timer])).toEqual([]);
  });
});
