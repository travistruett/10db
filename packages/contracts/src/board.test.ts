import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BoardColumnDelete,
  BoardColumnInput,
  BoardColumnPatch,
  columnNameKey,
  DEFAULT_BOARD_COLUMN,
  cleanColumnName,
  SYSTEM_COLUMN_LABEL,
  TaskMove,
} from './board';
import { EventType } from './events';
import { renderJsonSchemas } from './json-schema';
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
    {
      name: 'a name padded past 40 characters, limited after cleanup',
      value: `Needs spec${' '.repeat(31)}`,
      ok: true,
      parsed: 'Needs spec',
    },
    {
      name: 'a name whose inner spaces collapse to 40 characters',
      value: `${'x'.repeat(20)}     ${'x'.repeat(19)}`,
      ok: true,
      parsed: `${'x'.repeat(20)} ${'x'.repeat(19)}`,
    },
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
    { name: 'inner runs of spaces', typed: 'In  progress', stored: 'In progress' },
    { name: 'a no-break space', typed: 'In\u00a0progress', stored: 'In progress' },
    { name: 'a zero-width space', typed: 'Ba\u200bcklog', stored: 'Backlog' },
    { name: 'a byte-order mark', typed: '\ufeffIcebox', stored: 'Icebox' },
    { name: 'bidi controls', typed: '\u202eIcebox\u202c', stored: 'Icebox' },
    { name: 'tabs and newlines', typed: ' Needs\t\nspec ', stored: 'Needs spec' },
    {
      name: 'an emoji sequence (zero-width joiner kept)',
      typed: '\u{1F9D1}\u200d\u{1F4BB} Dev',
      stored: '\u{1F9D1}\u200d\u{1F4BB} Dev',
    },
    {
      name: 'a Persian word (zero-width non-joiner kept)',
      typed: '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645',
      stored: '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645',
    },
    { name: 'a circled digit (not folded)', typed: '\u2460 Triage', stored: '\u2460 Triage' },
    { name: 'full-width letters (not folded)', typed: '\uff24one', stored: '\uff24one' },
  ])('stores $name as typed apart from cleanup', ({ typed, stored }) => {
    expect(cleanColumnName(typed)).toBe(stored);
    expect(BoardColumnInput.parse({ name: typed }).name).toBe(stored);
  });

  it('still treats full-width and circled look-alikes as the same name when comparing', () => {
    expect(columnNameKey('\uff24one')).toBe(columnNameKey('Done'));
    expect(columnNameKey('\u2460')).toBe(columnNameKey('1'));
  });

  // The 40-character limit applies after cleanup, which JSON Schema can't express: a maxLength on the
  // typed text would refuse a padded name the API accepts, so the limit is published as a description.
  it('publishes the name limits as they apply: one typed character, 40 after cleanup', () => {
    const rendered = renderJsonSchemas();
    for (const file of ['board-column-input.schema.json', 'board-column-patch.schema.json']) {
      const { properties } = z
        .object({ properties: z.object({ name: z.unknown() }) })
        .parse(JSON.parse(rendered.get(file) ?? '{}'));
      const name = properties.name;
      expect(name).toMatchObject({ type: 'string', minLength: 1 });
      expect(name).not.toHaveProperty('maxLength');
      expect(name).toHaveProperty('description', expect.stringContaining('40 characters'));
    }
  });

  it.each([
    { name: 'case', a: 'icebox', b: 'Icebox', same: true },
    { name: 'a zero-width character', a: 'Ice\u200bbox', b: 'Icebox', same: true },
    { name: 'a Cyrillic \u0435 for Latin e', a: 'R\u0435ady', b: 'Ready', same: true },
    { name: 'different words', a: 'Icebox', b: 'Exploring', same: false },
  ])('compares names by key: $name', ({ a, b, same }) => {
    expect(columnNameKey(a) === columnNameKey(b)).toBe(same);
  });

  it('labels the six system columns', () => {
    expect(Object.values(SYSTEM_COLUMN_LABEL)).toEqual([
      'Backlog',
      'Ready',
      'In progress',
      'In review',
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
