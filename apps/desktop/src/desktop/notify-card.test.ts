import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../test/fixtures';
import { sendDto } from '../test/people-fixtures';
import { shouldNotifyOpened, triagedToBuilder } from './notify-card';

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
    ['a draft that waits for review', inboxItemDto({ send: sendDto({ state: 'draft' }) }), true],
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
