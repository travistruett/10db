import { describe, expect, it } from 'vitest';
import { CARD_RESOLUTION } from './card-resolution';
import { mintId } from './ids';
import { InboxOutcome, InboxPageDto, InboxPageQuery, inboxOutcome } from './inbox-page';

const projectId = mintId('Project');
const cardId = mintId('InboxItem');
const sortJson = JSON.stringify([1, '2026-11-01T00:00:00.000Z', cardId]);

describe('inbox page query', () => {
  it.each([
    ['only a state', { state: 'resolved' }, { state: 'resolved', page: undefined, pageSize: 25 }],
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
      'an after cursor as JSON',
      { state: 'open', after: sortJson },
      { state: 'open', pageSize: 25, after: [1, '2026-11-01T00:00:00.000Z', cardId] },
    ],
    [
      'a trimmed search, a since and a card',
      { state: 'resolved', q: '  hello ', since: '2026-11-01T00:00:00.000Z', card: cardId },
      {
        state: 'resolved',
        pageSize: 25,
        q: 'hello',
        since: '2026-11-01T00:00:00.000Z',
        card: cardId,
      },
    ],
    [
      'the largest page size',
      { state: 'open', pageSize: '100' },
      { state: 'open', page: undefined, pageSize: 100 },
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
    ['an after that is not JSON', { state: 'open', after: 'nope' }],
    ['an after that is not a row sort', { state: 'open', after: '[1,2]' }],
    ['an after with a page', { state: 'open', after: sortJson, page: '2' }],
    ['an after with a sort', { state: 'open', after: sortJson, sort: 'title' }],
    ['an after with a dir', { state: 'open', after: sortJson, dir: 'asc' }],
    ['a card with an after', { state: 'open', card: cardId, after: sortJson }],
    ['a card with a page', { state: 'open', card: cardId, page: '2' }],
    ['a since outside resolved', { state: 'open', since: '2026-11-01T00:00:00.000Z' }],
    ['a blank search', { state: 'open', q: '  ' }],
  ])('rejects %s', (_name, input) => {
    expect(InboxPageQuery.safeParse(input).success).toBe(false);
  });
});

describe('inbox page dto', () => {
  it('reads an answer without rows and next, as an older fixture has it', () => {
    const dto = InboxPageDto.parse({ items: [], total: 0, page: 1, pageSize: 25 });
    expect(dto.rows).toEqual([]);
    expect(dto.next).toBeNull();
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
