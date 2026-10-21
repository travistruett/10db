import { describe, expect, it } from 'vitest';
import { BoardColumnInput, BoardColumnPatch, DEFAULT_BOARD_COLUMN, TaskMove } from './board';
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
