import { BoardStatus, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskDto } from '../../test/fixtures';
import { columnKeyId, type LayoutColumn } from './board-layout';
import { isCollapsible, isRail, parseCollapsed } from './column-rail';

const system = (status: BoardStatus, count = 0): LayoutColumn => ({
  key: { kind: 'system', status },
  label: status,
  tasks: Array.from({ length: count }, () => taskDto()),
});
const human = (count = 0): LayoutColumn => ({
  key: { kind: 'human', id: mintId('BoardColumn') },
  label: 'Icebox',
  tasks: Array.from({ length: count }, () => taskDto()),
});

describe('isCollapsible', () => {
  it('lets the builder collapse human columns and Done, and no other', () => {
    expect(isCollapsible(human().key)).toBe(true);
    expect(isCollapsible(system(BoardStatus.Done).key)).toBe(true);
    for (const status of [
      BoardStatus.Backlog,
      BoardStatus.Ready,
      BoardStatus.InProgress,
      BoardStatus.InReview,
      BoardStatus.Blocked,
    ]) {
      expect(isCollapsible(system(status).key)).toBe(false);
    }
  });
});

describe('isRail', () => {
  it('collapses an empty column to a rail', () => {
    expect(isRail(system(BoardStatus.InProgress), [])).toBe(true);
    expect(isRail(human(), [])).toBe(true);
    expect(isRail(system(BoardStatus.InProgress, 2), [])).toBe(false);
  });

  it('keeps Ready open while empty, for its Add Task button', () => {
    expect(isRail(system(BoardStatus.Ready), [])).toBe(false);
  });

  it('makes a rail of a collapsible column the builder collapsed', () => {
    const done = system(BoardStatus.Done, 3);
    const icebox = human(45);
    expect(isRail(done, [])).toBe(false);
    expect(isRail(done, [columnKeyId(done.key)])).toBe(true);
    expect(isRail(icebox, [columnKeyId(icebox.key)])).toBe(true);
  });

  it('ignores a stored collapse for a column that cannot be collapsed', () => {
    const review = system(BoardStatus.InReview, 2);
    expect(isRail(review, [columnKeyId(review.key)])).toBe(false);
  });
});

describe('parseCollapsed', () => {
  it('reads a list of column keys and drops anything else', () => {
    expect(parseCollapsed(JSON.stringify(['system:done', 'human:x']))).toEqual([
      'system:done',
      'human:x',
    ]);
    expect(parseCollapsed(JSON.stringify(['a', 3, null]))).toEqual(['a']);
    expect(parseCollapsed('{"a":1}')).toEqual([]);
    expect(parseCollapsed('not json')).toEqual([]);
    expect(parseCollapsed(undefined)).toEqual([]);
  });
});
