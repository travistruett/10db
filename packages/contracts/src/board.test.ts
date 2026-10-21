import { describe, expect, it } from 'vitest';
import {
  BoardColumnDelete,
  BoardColumnInput,
  BoardColumnPatch,
  columnNameKey,
  DEFAULT_BOARD_COLUMN,
  normalizeColumnName,
  SYSTEM_COLUMN_LABEL,
  TaskMove,
} from './board';
import { EventType } from './events';
import { BoardColumnId, mintId } from './ids';

const a = mintId('Task');
const b = mintId('Task');
const column = mintId('BoardColumn');

describe('TaskMove', () => {
  it.each([
    { name: 'between two planned tasks', value: { to: null, after: a, before: b }, ok: true },
    {
      name: 'to the top of a human column',
      value: { to: column, after: null, before: a },
      ok: true,
    },
    {
      name: 'into an empty human column',
      value: { to: column, after: null, before: null },
      ok: true,
    },
    { name: 'between a task and itself', value: { to: null, after: a, before: a }, ok: false },
    {
      name: 'to a malformed column',
      value: { to: 'bcl_nope', after: null, before: null },
      ok: false,
    },
    { name: 'with a missing key', value: { to: null, after: a }, ok: false },
  ])('parses a move $name: $ok', ({ value, ok }) => {
    expect(TaskMove.safeParse(value).success).toBe(ok);
  });
});

describe('board columns', () => {
  it('mints column ids with the bcl prefix', () => {
    expect(BoardColumnId.safeParse(column).success).toBe(true);
    expect(column.startsWith('bcl_')).toBe(true);
  });

  it.each([
    { name: 'a plain name', value: 'Exploring', ok: true, parsed: 'Exploring' },
    { name: 'a padded name, trimmed', value: '  Needs spec ', ok: true, parsed: 'Needs spec' },
    { name: 'an empty name', value: '   ', ok: false, parsed: null },
    { name: 'a 41-character name', value: 'x'.repeat(41), ok: false, parsed: null },
  ])('parses $name', ({ value, ok, parsed }) => {
    const result = BoardColumnInput.safeParse({ name: value });
    expect(result.success).toBe(ok);
    if (result.success) expect(result.data.name).toBe(parsed);
  });

  it('refuses an empty patch', () => {
    expect(BoardColumnPatch.safeParse({}).success).toBe(false);
    expect(BoardColumnPatch.safeParse({ position: 0 }).success).toBe(true);
  });

  it('names Icebox as the default column and its events', () => {
    expect(DEFAULT_BOARD_COLUMN).toBe('Icebox');
    expect(EventType.BoardColumnSaved).toBe('board_column.saved');
    expect(EventType.BoardColumnDeleted).toBe('board_column.deleted');
  });
});

describe('column names', () => {
  it.each([
    { name: 'inner runs of spaces', typed: 'In  progress', normalized: 'In progress' },
    { name: 'a no-break space', typed: 'In\u00a0progress', normalized: 'In progress' },
    { name: 'a zero-width space', typed: 'Ba\u200bcklog', normalized: 'Backlog' },
    { name: 'full-width letters', typed: '\uff24one', normalized: 'Done' },
    { name: 'tabs and newlines', typed: ' Needs\t\nspec ', normalized: 'Needs spec' },
  ])('normalizes $name', ({ typed, normalized }) => {
    expect(normalizeColumnName(typed)).toBe(normalized);
    expect(BoardColumnInput.parse({ name: typed }).name).toBe(normalized);
  });

  it.each([
    { name: 'case', a: 'icebox', b: 'Icebox', same: true },
    { name: 'a zero-width character', a: 'Ice\u200bbox', b: 'Icebox', same: true },
    { name: 'a Cyrillic \u0435 for Latin e', a: 'R\u0435ady', b: 'Ready', same: true },
    { name: 'different words', a: 'Icebox', b: 'Exploring', same: false },
  ])('compares names by key: $name', ({ a, b, same }) => {
    expect(columnNameKey(a) === columnNameKey(b)).toBe(same);
  });

  it('labels the five system columns', () => {
    expect(Object.values(SYSTEM_COLUMN_LABEL)).toEqual([
      'Backlog',
      'Ready',
      'In progress',
      'Blocked',
      'Done',
    ]);
  });
});

describe('BoardColumnDelete', () => {
  it.each([
    { name: 'another column', value: { moveTasksTo: column }, ok: true },
    { name: 'an explicit planned', value: { moveTasksTo: 'planned' }, ok: true },
    { name: 'null, which no longer means planned', value: { moveTasksTo: null }, ok: false },
    { name: 'no target', value: {}, ok: false },
    { name: 'a malformed column', value: { moveTasksTo: 'bcl_nope' }, ok: false },
  ])('parses a delete with $name: $ok', ({ value, ok }) => {
    expect(BoardColumnDelete.safeParse(value).success).toBe(ok);
  });
});
