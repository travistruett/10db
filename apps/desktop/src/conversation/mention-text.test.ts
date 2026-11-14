import { describe, expect, it } from 'vitest';
import { COMMAND_MENTION, FILE_MENTION, mentionText } from './mention-text';

const file = (path: string): string => FILE_MENTION.insert({ id: path, display: path });
const command = (name: string): string => COMMAND_MENTION.insert({ id: name, display: name });

describe('mentionText', () => {
  it.each([
    {
      name: 'a path with a space',
      value: `${file('src/a b.ts')} why`,
      text: '@src/a b.ts why',
      paths: ['src/a b.ts'],
    },
    {
      name: 'a path with brackets and parentheses',
      value: `read ${file('src/[id](x).tsx')}`,
      text: 'read @src/[id](x).tsx',
      paths: ['src/[id](x).tsx'],
    },
    {
      name: 'a path with a unicode name',
      value: file('docs/é.md'),
      text: '@docs/é.md',
      paths: ['docs/é.md'],
    },
    {
      name: 'two mentions',
      value: `${file('a.ts')} and ${file('b.ts')}`,
      text: '@a.ts and @b.ts',
      paths: ['a.ts', 'b.ts'],
    },
    {
      name: 'the same path twice',
      value: `${file('a.ts')} ${file('a.ts')}`,
      text: '@a.ts @a.ts',
      paths: ['a.ts'],
    },
    { name: 'a command', value: command('compact'), text: '/compact', paths: [] },
    {
      name: 'plain text',
      value: 'just words, an email a@b.c and /x',
      text: 'just words, an email a@b.c and /x',
      paths: [],
    },
  ])('$name', ({ value, text, paths }) => {
    expect(mentionText(value)).toEqual({ text, mentions: paths });
  });
});

describe('the serializers', () => {
  it('find what they insert, with its index', () => {
    const value = `see ${file('a b.ts')} then ${file('c.ts')}`;
    expect(FILE_MENTION.findAll(value).map((m) => [m.id, m.index])).toEqual([
      ['a b.ts', 4],
      ['c.ts', value.indexOf(file('c.ts'))],
    ]);
    expect(COMMAND_MENTION.findAll(value)).toEqual([]);
  });
});
