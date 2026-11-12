import type { InboxItemDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../../test/fixtures';
import { personDto, sendDto, slackContact } from '../../test/people-fixtures';
import { routeLine, stakeholderMode } from './route-line';

const mark = personDto({ name: 'Mark Ellis', handle: 'mark', slack: slackContact('U1') });
const ana = personDto({ name: 'Ana Ortiz', handle: 'ana', slack: slackContact('U2') });
const priya = personDto({ name: 'Priya Shah', handle: 'priya' });
const me = personDto({ name: 'Travis', handle: 'travis', isBuilder: true });
const people = [me, mark, ana, priya];

describe('routeLine', () => {
  const lines: readonly [string, Partial<InboxItemDto>, string][] = [
    ['a rule', { routedBy: 'rule', assignees: ['mark'] }, 'Product question → Mark Ellis'],
    [
      'a tie',
      { routedBy: 'rule', assignees: ['mark', 'ana'] },
      'Product question → Mark Ellis and Ana Ortiz',
    ],
    [
      'the judge',
      { routedBy: 'judge', assignees: ['ana'] },
      'Product question → Ana Ortiz · chosen by Jev',
    ],
    [
      'the builder',
      { routedBy: 'builder', assignees: ['mark'] },
      'Product question → Mark Ellis · chosen by you',
    ],
    [
      'triage still running',
      { routedBy: 'triage_pending', assignees: ['travis'] },
      'Finding who answers…',
    ],
  ];
  it.each(lines)('%s', (_name, over, expected) => {
    const card = inboxItemDto({ category: 'product', ...over });
    expect(routeLine(card, people).text).toBe(expected);
    expect(routeLine(card, people).pending).toBe(card.routedBy === 'triage_pending');
  });

  it('names a category in words', () => {
    const card = inboxItemDto({ category: 'business', routedBy: 'rule', assignees: ['mark'] });
    expect(routeLine(card, people).text).toBe('Business question → Mark Ellis');
  });
});

describe('stakeholderMode', () => {
  it('is copy for people not in Slack that the card names in copyFor, and not for people in Slack', () => {
    expect(stakeholderMode(inboxItemDto({ copyFor: ['priya'] }), people)).toBe('copy');
    expect(stakeholderMode(inboxItemDto({ copyFor: ['mark'] }), people)).toBe('unrouted');
    expect(stakeholderMode(inboxItemDto({ copyFor: [] }), people)).toBe('unrouted');
  });

  const rows: readonly [string, Partial<InboxItemDto>, string][] = [
    ['a card nobody was asked about', {}, 'unrouted'],
    ['a pending triage', { routedBy: 'triage_pending' }, 'pending'],
    ['a draft', { assignees: ['mark'], send: sendDto({ state: 'draft' }) }, 'draft'],
    [
      'a failed send',
      { assignees: ['mark'], send: sendDto({ state: 'failed', error: 'x' }) },
      'failed',
    ],
    ['a person in Slack with no send yet', { assignees: ['mark'], routedBy: 'rule' }, 'unrouted'],
    ['a sent question', { assignees: ['mark'], send: sendDto({ state: 'sent' }) }, 'none'],
    ['a card that is not a question', { kind: 'flag' }, 'none'],
  ];
  it.each(rows)('%s is %s', (_name, over, expected) => {
    expect(stakeholderMode(inboxItemDto(over), people)).toBe(expected);
  });
});
