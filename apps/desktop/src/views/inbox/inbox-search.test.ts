import { InboxKind, InboxListState, InboxOutcome, PersonId, ProjectId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  filtersSet,
  inboxList,
  inboxSearch,
  lastInboxSearch,
  narrowed,
  withFilter,
  withoutFilters,
  withoutQuery,
  withProject,
  withState,
} from './inbox-search';

const PROJECT = ProjectId.parse('prj_01920000-0000-7000-8000-000000000001');
const PERSON = PersonId.parse('psn_01920000-0000-7000-8000-000000000001');

describe('inboxSearch', () => {
  it.each([
    ['state', { state: 'waiting' }, { state: 'waiting' }],
    ['state, unknown', { state: 'nope' }, {}],
    ['q', { q: 'deploy' }, { q: 'deploy' }],
    ['q, empty', { q: '' }, {}],
    ['q, only spaces', { q: '  ' }, {}],
    ['q, 200 characters', { q: 'a'.repeat(200) }, { q: 'a'.repeat(200) }],
    ['q, 201 characters', { q: 'a'.repeat(201) }, {}],
    ['q, keeps a trailing space', { q: 'dep ' }, { q: 'dep ' }],
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

describe('withState and withProject', () => {
  it.each([
    [
      'Open leaves no state',
      withState({ state: 'waiting', project: PROJECT }, 'open'),
      { project: PROJECT },
    ],
    [
      'Waiting sets it',
      withState({ project: PROJECT }, 'waiting'),
      { state: 'waiting', project: PROJECT },
    ],
    [
      'a project is set',
      withProject({ state: 'resolved' }, PROJECT),
      { state: 'resolved', project: PROJECT },
    ],
    [
      'every project drops it',
      withProject({ state: 'resolved', project: PROJECT }, null),
      { state: 'resolved' },
    ],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });
});

describe('filters and the search', () => {
  it.each([
    ['nothing', { state: 'open' }, false, false],
    ['q alone is no filter', { q: 'a' }, false, true],
    ['a kind', { kind: InboxKind.Flag }, true, true],
    ['a person in Open does not apply', { person: PERSON }, false, false],
    ['a person in Waiting', { state: 'waiting', person: PERSON }, true, true],
    ['an outcome in Resolved', { state: 'resolved', outcome: InboxOutcome.Slack }, true, true],
    ['a since in Waiting does not apply', { state: 'waiting', since: 'day' }, false, false],
  ] as const)('%s', (_name, search, filters, any) => {
    expect(filtersSet(search)).toBe(filters);
    expect(narrowed(search)).toBe(any);
  });

  it('sets and clears one key, and leaves the rest', () => {
    const search = { state: InboxListState.Resolved, q: 'a', kind: InboxKind.Flag } as const;
    expect(withFilter(search, 'kind', null)).toEqual({ state: 'resolved', q: 'a' });
    expect(withFilter(search, 'q', 'b')).toEqual({ state: 'resolved', q: 'b', kind: 'flag' });
    expect(withoutFilters({ ...search, project: PROJECT })).toEqual({ state: 'resolved', q: 'a' });
    expect(withoutQuery(search)).toEqual({ state: 'resolved', kind: 'flag' });
  });
});

describe('lastInboxSearch', () => {
  it('remembers what was set', () => {
    lastInboxSearch.set({ state: InboxListState.Waiting });
    expect(lastInboxSearch.get()).toEqual({ state: 'waiting' });
    lastInboxSearch.set({});
  });
});
