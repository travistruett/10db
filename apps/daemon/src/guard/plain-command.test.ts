import { describe, expect, it } from 'vitest';
import { plainCommandWords } from './plain-command';

describe('plainCommandWords', () => {
  it.each<{ name: string; command: string; expected: string[][] | null }>([
    { name: 'plain words', command: 'git status', expected: [['git', 'status']] },
    { name: 'adjacent double quotes join one word', command: 'a"b"c', expected: [['abc']] },
    { name: 'single then double quotes join', command: `'a'"b"c`, expected: [['abc']] },
    { name: 'empty single quotes are an empty word', command: "cat ''", expected: [['cat', '']] },
    { name: 'empty double quotes are an empty word', command: 'cat ""', expected: [['cat', '']] },
    {
      name: 'empty quotes before an option vanish',
      command: "sort ''-o x y",
      expected: [['sort', '-o', 'x', 'y']],
    },
    {
      name: 'separators inside single quotes stay in the word',
      command: "grep 'a|b;c&d' x",
      expected: [['grep', 'a|b;c&d', 'x']],
    },
    {
      name: 'and-list splits segments',
      command: 'git diff && git status',
      expected: [
        ['git', 'diff'],
        ['git', 'status'],
      ],
    },
    {
      name: 'pipe, or-list and semicolon split segments',
      command: 'cat a | grep b || ls; pwd',
      expected: [['cat', 'a'], ['grep', 'b'], ['ls'], ['pwd']],
    },
    { name: '2>&1 is not a word', command: 'ls 2>&1', expected: [['ls']] },
    { name: '>/dev/null is not a word', command: 'ls >/dev/null', expected: [['ls']] },
    { name: '2>/dev/null is not a word', command: 'ls 2>/dev/null', expected: [['ls']] },
    { name: 'a single = inside a word', command: 'grep a=b x', expected: [['grep', 'a=b', 'x']] },
    {
      name: 'a long option with a value',
      command: 'git log --format=%H',
      expected: [['git', 'log', '--format=%H']],
    },
    { name: 'leading = unquoted', command: 'cat =ls', expected: null },
    { name: 'leading = after empty double quotes', command: 'cat ""=ls', expected: null },
    { name: 'leading = after empty single quotes', command: "cat ''=ls", expected: null },
    { name: 'leading = inside quotes', command: 'cat "="ls', expected: null },
    { name: '== in an option value', command: 'sort --o==ls x', expected: null },
    { name: '== split by empty quotes', command: 'sort --o=""=ls x', expected: null },
    { name: '== inside single quotes', command: "sort '--o==ls' x", expected: null },
    { name: '== mid-word', command: 'grep a==b x', expected: null },
    { name: ':= after an assignment-like =', command: 'cat a=:=ls', expected: null },
    { name: ':= in an option value', command: 'cat --o=x:=ls', expected: null },
    { name: ':= mid-word', command: 'cat x:=ls', expected: null },
    { name: 'a lone colon inside a word', command: 'grep a:b x', expected: [['grep', 'a:b', 'x']] },
    {
      name: 'a lowercase format option',
      command: 'git log --format=%h',
      expected: [['git', 'log', '--format=%h']],
    },
    {
      name: 'a type option',
      command: 'rg --type=ts TODO',
      expected: [['rg', '--type=ts', 'TODO']],
    },
    { name: 'unquoted glob', command: 'ls *', expected: null },
    { name: 'real newline', command: 'cat a\nb', expected: null },
    { name: 'fullwidth hyphen', command: 'ls －la', expected: null },
    { name: 'dollar expansion', command: 'cat $HOME', expected: null },
    { name: 'dollar inside double quotes', command: 'cat "$HOME"', expected: null },
    { name: 'backslash escape', command: 'cat a\\ b', expected: null },
    { name: 'other redirect', command: 'ls >out', expected: null },
    { name: 'redirect glued to a word', command: 'ls x2>&1', expected: null },
    { name: 'background', command: 'ls &', expected: null },
    { name: 'unterminated quote', command: "cat 'a", expected: null },
    { name: 'empty segment', command: 'ls ;; pwd', expected: null },
    { name: 'trailing separator', command: 'ls &&', expected: null },
    { name: 'empty command', command: '', expected: null },
  ])('$name', ({ command, expected }) => {
    expect(plainCommandWords(command)).toEqual(expected);
  });

  describe('grouping words', () => {
    it.each<[string, string, string[][] | null]>([
      [
        'escaped parentheses are the words ( and )',
        String.raw`find . \( -name a -o -name b \)`,
        [['find', '.', '(', '-name', 'a', '-o', '-name', 'b', ')']],
      ],
      [
        'quoted parentheses are the words ( and )',
        `find . '(' -name a ")"`,
        [['find', '.', '(', '-name', 'a', ')']],
      ],
      [
        'a bare ! after the command is a word',
        'find . ! -name a',
        [['find', '.', '!', '-name', 'a']],
      ],
      ['an escaped paren glued to a word', String.raw`find . \(-name a`, null],
      ['an escaped paren at the end of a word', String.raw`find . a\(`, null],
      ['a bare paren', 'find . ( -name a )', null],
      ['a bare ! as the command', '! ls', null],
      ['a ! glued to a word', 'find . !a', null],
      ['an escaped bang', String.raw`find . \!`, null],
      ['an escaped paren with a space after the backslash', String.raw`find . \ (`, null],
      ['a double backslash before a paren', String.raw`find . \\(`, null],
    ])('%s', (_name, command, expected) => {
      expect(plainCommandWords(command)).toEqual(expected);
      expect(plainCommandWords(command, { optionGlobs: true })).toEqual(expected);
    });
  });

  describe('with optionGlobs', () => {
    it.each<[string, string, string[][] | null]>([
      [
        'a glob in an option value',
        'grep -r x src --include=*.ts',
        [['grep', '-r', 'x', 'src', '--include=*.ts']],
      ],
      ['a glob before any =', 'grep -r* x', null],
      ['a glob in a path word', 'ls *', null],
      ['a glob in the command word', 'l* a', null],
      ['a glob after an = in a word that is not an option', 'ls a=*.ts', null],
    ])('%s', (_name, command, expected) => {
      expect(plainCommandWords(command, { optionGlobs: true })).toEqual(expected);
    });
  });
});
