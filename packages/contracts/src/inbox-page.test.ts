import { describe, expect, it } from 'vitest';
import { CARD_RESOLUTION } from './card-resolution';
import { mintId } from './ids';
import { InboxOutcome, InboxPageQuery, inboxOutcome } from './inbox-page';

const projectId = mintId('Project');

describe('inbox page query', () => {
  it.each([
    ['only a state', { state: 'resolved' }, { state: 'resolved', page: 1, pageSize: 25 }],
    [
      'every filter, a sort and a page',
      {
        state: 'resolved',
        project: projectId,
        kind: 'question',
        outcome: 'slack',
        sort: 'title',
        dir: 'desc',
        page: '3',
        pageSize: '50',
      },
      {
        state: 'resolved',
        project: projectId,
        kind: 'question',
        outcome: 'slack',
        sort: 'title',
        dir: 'desc',
        page: 3,
        pageSize: 50,
      },
    ],
    [
      'the largest page size',
      { state: 'open', pageSize: '100' },
      { state: 'open', page: 1, pageSize: 100 },
    ],
  ])('reads %s', (_name, input, expected) => {
    expect(InboxPageQuery.parse(input)).toEqual(expected);
  });

  it.each([
    ['no state', {}],
    ['an unknown state', { state: 'OPEN' }],
    ['an unknown kind', { state: 'open', kind: 'nope' }],
    ['an unknown outcome', { state: 'resolved', outcome: 'nope' }],
    ['an unknown sort', { state: 'resolved', sort: 'urgency' }],
    ['a page size over 100', { state: 'resolved', pageSize: '101' }],
    ['page 0', { state: 'resolved', page: '0' }],
    ['a project that is not an id', { state: 'resolved', project: 'nope' }],
    ['an unknown key', { state: 'resolved', recent: '100' }],
  ])('rejects %s', (_name, input) => {
    expect(InboxPageQuery.safeParse(input).success).toBe(false);
  });
});

describe('inboxOutcome', () => {
  const slackAnswer = { choice: 'A', note: '', via: 'slack' as const };
  const builderAnswer = { choice: 'A', note: '' };
  const closedBy10db = { [CARD_RESOLUTION]: { by: '10db', reason: 'The task finished.' } };
  it.each([
    ['a Slack answer', { answer: slackAnswer, detail: null }, InboxOutcome.Slack],
    [
      'a Slack answer on a card 10db also closed',
      { answer: slackAnswer, detail: closedBy10db },
      InboxOutcome.Slack,
    ],
    ['a card 10db closed', { answer: null, detail: closedBy10db }, InboxOutcome.TenDb],
    [
      'a builder answer on a card 10db closed',
      { answer: builderAnswer, detail: closedBy10db },
      InboxOutcome.TenDb,
    ],
    [
      'a resolution that does not parse',
      { answer: null, detail: { [CARD_RESOLUTION]: { by: 'someone' } } },
      InboxOutcome.Answered,
    ],
    ['the builder answer', { answer: builderAnswer, detail: null }, InboxOutcome.Answered],
    ['a dismissal with no answer', { answer: null, detail: null }, InboxOutcome.Answered],
  ])('reads %s', (_name, item, expected) => {
    expect(inboxOutcome(item)).toBe(expected);
  });
});
