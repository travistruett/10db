import { describe, expect, it } from 'vitest';
import {
  decisionProposal,
  goalProposal,
  landingProposal,
  looseTaskProposal,
  questionProposal,
} from '../../test/shape-fixtures';
import { changedFields, editableFields, filledValues } from './row-editing';

// Shape spec §6 Editing: what a builder may set on a row, and what an edit sends.

const names = (row: Parameters<typeof editableFields>[0]) => editableFields(row).map((f) => f.name);

describe('editableFields', () => {
  it.each([
    {
      name: 'a loose task',
      row: looseTaskProposal('a'),
      fields: ['title', 'description', 'size', 'ceremony'],
    },
    {
      name: 'a goal and each of its tasks',
      row: goalProposal('g', ['one', 'two']),
      fields: [
        'title',
        'objective',
        'ceremony',
        'tasks.one.title',
        'tasks.one.size',
        'tasks.two.title',
        'tasks.two.size',
      ],
    },
    {
      name: 'a decision',
      row: decisionProposal('d'),
      fields: ['question', 'choice', 'rationale'],
    },
    { name: 'a question', row: questionProposal('q'), fields: ['text', 'for'] },
    { name: 'a landing', row: landingProposal('l', ['a']), fields: ['title'] },
  ])('lists $name', ({ row, fields }) => {
    expect(names(row)).toEqual(fields);
  });

  it('offers S, M and L for a size, never XL (a task that big is split)', () => {
    const size = editableFields(looseTaskProposal('a')).find((f) => f.name === 'size');
    expect(size).toMatchObject({ control: 'select', options: ['S', 'M', 'L'], value: 'S' });
  });

  it('starts each field at the row’s value', () => {
    const values = Object.fromEntries(
      editableFields(goalProposal('g', ['one'])).map((f) => [f.name, f.value]),
    );
    expect(values).toMatchObject({
      title: 'Brainstorm chat in 10db',
      ceremony: 'direct',
      'tasks.one.title': 'Task one',
      'tasks.one.size': 'M',
    });
  });
});

describe('changedFields', () => {
  const row = looseTaskProposal('a');

  it('sends only what the builder changed', () => {
    expect(changedFields(row, { title: 'A better title', size: 'S', ceremony: 'direct' })).toEqual({
      title: 'A better title',
    });
  });

  it('sends nothing when nothing changed', () => {
    expect(changedFields(row, { title: row.kind === 'task' ? row.body.title : '' })).toEqual({});
  });

  it('trims what it sends and ignores a change that is only spaces', () => {
    expect(changedFields(row, { title: '  Trimmed  ' })).toEqual({ title: 'Trimmed' });
    expect(changedFields(row, { description: '   ' })).toEqual({});
  });

  it('does not send a field the row cannot take, or an empty required one', () => {
    expect(changedFields(row, { bogus: 'x' })).toEqual({});
    expect(changedFields(row, { title: '   ' })).toEqual({});
  });

  it('names a goal task’s field by its path', () => {
    expect(changedFields(goalProposal('g', ['one']), { 'tasks.one.size': 'L' })).toEqual({
      'tasks.one.size': 'L',
    });
  });
});

describe('filledValues', () => {
  it('reads the values of every field of the row', () => {
    expect(filledValues(looseTaskProposal('a'))).toMatchObject({ title: 'Task a', size: 'S' });
  });
});
