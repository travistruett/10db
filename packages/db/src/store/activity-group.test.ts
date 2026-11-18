import { mintId, type NoticePostedData } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { groupNotices, type PostedNotice } from './activity-group';

const P1 = mintId('Project');
const P2 = mintId('Project');
const T1 = mintId('Task');
const T2 = mintId('Task');
const BASE = Date.parse('2026-11-17T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(BASE - m * 60_000).toISOString();

function notice(
  seq: number,
  agoMin: number,
  key: string,
  over: Partial<NoticePostedData> = {},
): PostedNotice {
  return {
    seq,
    at: minutesAgo(agoMin),
    data: {
      projectId: P1,
      taskId: null,
      key,
      tone: 'info',
      line: `line ${String(seq)}`,
      body: '',
      ...over,
    },
  };
}

interface Case {
  readonly name: string;
  readonly notices: readonly PostedNotice[];
  readonly pageSize: number;
  readonly rows: readonly { seq: number; count: number; firstAt: string }[];
  readonly consumed: number;
  readonly full: boolean;
}

const cases: readonly Case[] = [
  {
    name: 'three of one key a minute apart are one row',
    notices: [notice(3, 0, 'a'), notice(2, 1, 'a'), notice(1, 2, 'a')],
    pageSize: 10,
    rows: [{ seq: 3, count: 3, firstAt: minutesAgo(2) }],
    consumed: 3,
    full: false,
  },
  {
    name: 'the same key 11 minutes apart is two rows',
    notices: [notice(2, 0, 'a'), notice(1, 11, 'a')],
    pageSize: 10,
    rows: [
      { seq: 2, count: 1, firstAt: minutesAgo(0) },
      { seq: 1, count: 1, firstAt: minutesAgo(11) },
    ],
    consumed: 2,
    full: false,
  },
  {
    name: 'the same key in another project is two rows',
    notices: [notice(2, 0, 'a'), notice(1, 1, 'a', { projectId: P2 })],
    pageSize: 10,
    rows: [
      { seq: 2, count: 1, firstAt: minutesAgo(0) },
      { seq: 1, count: 1, firstAt: minutesAgo(1) },
    ],
    consumed: 2,
    full: false,
  },
  {
    name: 'the same key on another task is two rows',
    notices: [notice(2, 0, 'a', { taskId: T1 }), notice(1, 1, 'a', { taskId: T2 })],
    pageSize: 10,
    rows: [
      { seq: 2, count: 1, firstAt: minutesAgo(0) },
      { seq: 1, count: 1, firstAt: minutesAgo(1) },
    ],
    consumed: 2,
    full: false,
  },
  {
    name: 'A, B, A within 10 minutes is A twice, then B',
    notices: [notice(3, 0, 'a'), notice(2, 1, 'b'), notice(1, 2, 'a')],
    pageSize: 10,
    rows: [
      { seq: 3, count: 2, firstAt: minutesAgo(2) },
      { seq: 2, count: 1, firstAt: minutesAgo(1) },
    ],
    consumed: 3,
    full: false,
  },
  {
    name: 'a full page stops before the notice that would start another row',
    notices: [notice(3, 0, 'a'), notice(2, 1, 'a'), notice(1, 2, 'b')],
    pageSize: 1,
    rows: [{ seq: 3, count: 2, firstAt: minutesAgo(1) }],
    consumed: 2,
    full: true,
  },
  {
    name: 'a page of two over A, B, C is full after two',
    notices: [notice(3, 0, 'a'), notice(2, 1, 'b'), notice(1, 2, 'c')],
    pageSize: 2,
    rows: [
      { seq: 3, count: 1, firstAt: minutesAgo(0) },
      { seq: 2, count: 1, firstAt: minutesAgo(1) },
    ],
    consumed: 2,
    full: true,
  },
  {
    name: 'every notice joining leaves the page not full',
    notices: [notice(2, 0, 'a'), notice(1, 1, 'a')],
    pageSize: 1,
    rows: [{ seq: 2, count: 2, firstAt: minutesAgo(1) }],
    consumed: 2,
    full: false,
  },
  {
    name: 'an empty list is nothing',
    notices: [],
    pageSize: 5,
    rows: [],
    consumed: 0,
    full: false,
  },
];

describe('groupNotices', () => {
  it.each(cases)('$name', ({ notices, pageSize, rows, consumed, full }) => {
    const out = groupNotices(notices, pageSize);
    expect(out.rows.map((r) => ({ seq: r.seq, count: r.count, firstAt: r.firstAt }))).toEqual(rows);
    expect(out.consumed).toBe(consumed);
    expect(out.full).toBe(full);
  });

  it('keeps the newest notice line and body on the row', () => {
    const out = groupNotices(
      [notice(2, 0, 'a', { line: 'new', body: 'nb' }), notice(1, 1, 'a', { line: 'old' })],
      5,
    );
    expect(out.rows[0]).toMatchObject({ line: 'new', body: 'nb', at: minutesAgo(0) });
  });
});
