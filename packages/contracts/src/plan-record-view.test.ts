import { describe, expect, it } from 'vitest';
import { PlanRecordQuery } from './index';

describe('PlanRecordQuery', () => {
  it('answers the first page of 25 when nothing is asked', () => {
    expect(PlanRecordQuery.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it.each([
    ['a page of 50', { pageSize: '50' }, { pageSize: 50 }],
    ['a page of 100 on page 3', { page: '3', pageSize: '100' }, { page: 3, pageSize: 100 }],
    ['a state', { state: 'open' }, { state: 'open' }],
    ['an entry kind', { kind: 'fact' }, { kind: 'fact' }],
    ['a document', { document: 'p1' }, { document: 'p1' }],
    ['a search, trimmed', { q: '  anchor ' }, { q: 'anchor' }],
  ])('reads %s', (_, input, out) => {
    expect(PlanRecordQuery.parse(input)).toEqual({ page: 1, pageSize: 25, ...out });
  });

  it.each([
    ['a page of 30', { pageSize: '30' }],
    ['a page of 101', { pageSize: '101' }],
    ['page 0', { page: '0' }],
    ['a state no list has', { state: 'gone' }],
    ['a kind no list has', { kind: 'rumour' }],
    ['a field it does not know', { sort: 'title' }],
  ])('refuses %s', (_, input) => {
    expect(PlanRecordQuery.safeParse(input).success).toBe(false);
  });
});
