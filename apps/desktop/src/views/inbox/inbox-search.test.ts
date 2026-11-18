import { InboxKind, InboxListState, InboxOutcome, PersonId, ProjectId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxList, inboxSearch, lastInboxSearch } from './inbox-search';

const PROJECT = ProjectId.parse('prj_01920000-0000-7000-8000-000000000001');
const PERSON = PersonId.parse('psn_01920000-0000-7000-8000-000000000001');

describe('inboxSearch', () => {
  it.each([
    ['state', { state: 'waiting' }, { state: 'waiting' }],
    ['state, unknown', { state: 'nope' }, {}],
    ['q', { q: 'deploy' }, { q: 'deploy' }],
    ['q, empty', { q: '' }, {}],
    ['project', { project: PROJECT }, { project: PROJECT }],
    ['project, not an id', { project: 'x' }, {}],
    ['kind', { kind: InboxKind.Question }, { kind: InboxKind.Question }],
    ['kind, unknown', { kind: 'nope' }, {}],
    ['outcome', { outcome: 'slack' }, { outcome: 'slack' }],
    ['outcome, unknown', { outcome: 'nope' }, {}],
    ['person', { person: PERSON }, { person: PERSON }],
    ['person, not an id', { person: 'x' }, {}],
    ['since', { since: 'week' }, { since: 'week' }],
    ['since, unknown', { since: 'year' }, {}],
    ['a number is no string', { q: 4, state: 7 }, {}],
  ])('%s', (_name, input, expected) => {
    expect(inboxSearch(input)).toEqual(expected);
  });
});

describe('inboxList', () => {
  const now = new Date(2026, 10, 17, 15, 30);
  it.each([
    ['day', 0],
    ['week', 6],
    ['month', 29],
  ] as const)('since %s is local midnight %i days back', (since, back) => {
    const list = inboxList({ state: InboxListState.Resolved, since }, now);
    expect(list.since).toBe(new Date(2026, 10, 17 - back).toISOString());
  });

  it('drops a filter the state does not use', () => {
    const search = {
      state: InboxListState.Open,
      person: PERSON,
      outcome: InboxOutcome.Slack,
      since: 'day',
    } as const;
    expect(inboxList(search, now)).toEqual({ state: 'open' });
    expect(inboxList({ ...search, state: InboxListState.Waiting }, now)).toEqual({
      state: 'waiting',
      person: PERSON,
    });
  });

  it('defaults to Open and keeps q, project and kind', () => {
    expect(inboxList({ q: 'a', project: PROJECT, kind: InboxKind.Question }, now)).toEqual({
      state: 'open',
      q: 'a',
      project: PROJECT,
      kind: 'question',
    });
  });
});

describe('lastInboxSearch', () => {
  it('remembers what was set', () => {
    lastInboxSearch.set({ state: InboxListState.Waiting });
    expect(lastInboxSearch.get()).toEqual({ state: 'waiting' });
    lastInboxSearch.set({});
  });
});
