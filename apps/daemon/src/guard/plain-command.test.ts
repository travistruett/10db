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
});
