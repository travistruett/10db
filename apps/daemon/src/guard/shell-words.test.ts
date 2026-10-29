import { describe, expect, it } from 'vitest';
import { parseShell } from './shell-words';

describe('a parenthesis where a command starts', () => {
  const CASES: readonly { name: string; command: string; certain: boolean }[] = [
    { name: 'after do', command: 'for d in a b; do (cd $d && ls); done', certain: true },
    { name: 'after then', command: 'if true; then (cd a && ls); fi', certain: true },
    { name: 'after else', command: 'if true; then ls; else (cd a && ls); fi', certain: true },
    { name: 'after elif', command: 'if false; then ls; elif (cd a); then ls; fi', certain: true },
    { name: 'after while', command: 'while (cd a && ls); do ls; done', certain: true },
    { name: 'after until', command: 'until (cd a && ls); do ls; done', certain: true },
    { name: 'after a negation', command: '! (cd a && ls)', certain: true },
    { name: 'after &&', command: 'true && (cd a && ls)', certain: true },
    { name: 'at the start', command: '(cd a && ls)', certain: true },
    { name: 'arithmetic after do', command: 'for d in a; do ((i++)); done', certain: false },
    { name: 'a function definition', command: 'f() { ls; }', certain: false },
    { name: 'after a command word', command: 'echo do (a)', certain: false },
    { name: 'after time, which is a wrapper', command: 'time (cd a)', certain: false },
    { name: 'after empty quotes', command: "'' (a)", certain: false },
    { name: 'unclosed after do', command: 'for d in a; do (cd $d; done', certain: false },
  ];

  it.each(CASES)('$name: certain=$certain', ({ command, certain }) => {
    expect(parseShell(command).certain).toBe(certain);
  });

  it('numbers the subshell after do and ends it at the close', () => {
    const { segments } = parseShell('for d in a; do (cd $d && ls); pwd; done');
    const byWords = Object.fromEntries(segments.map((s) => [s.words.join(' '), s.subshells]));
    expect(byWords['cd $d']).toEqual([1]);
    expect(byWords['ls']).toEqual([1]);
    expect(byWords['pwd']).toEqual([]);
  });
});

describe('which words the shell passes as exactly one word', () => {
  const CASES: readonly { name: string; command: string; words: string[]; single: boolean[] }[] = [
    {
      name: 'plain and double-quoted words',
      command: 'x "$a" y',
      words: ['x', '$a', 'y'],
      single: [true, true, true],
    },
    { name: 'an unquoted expansion', command: 'x $a', words: ['x', '$a'], single: [true, false] },
    {
      name: 'quoted text around an expansion',
      command: 'x "@10db/$p"',
      words: ['x', '@10db/$p'],
      single: [true, true],
    },
    {
      name: 'a quoted expansion beside an unquoted one',
      command: 'x "$a"$b',
      words: ['x', '$a$b'],
      single: [true, false],
    },
    {
      name: 'a quoted expansion beside unquoted text',
      command: 'x --f="$a"',
      words: ['x', '--f=$a'],
      single: [true, true],
    },
    {
      name: 'all positional parameters',
      command: 'x "$@" "$*" "${a[@]}" "${a[*]}"',
      words: ['x', '$@', '$*', '${a[@]}', '${a[*]}'],
      single: [true, false, false, false, false],
    },
    {
      name: 'a quoted substitution is one word, an unquoted one splits',
      command: 'x "$(c)" $(c) "`c`" `c`',
      words: ['x', '$(c)', '$(c)', '`c`', '`c`'],
      single: [true, true, false, true, false],
    },
    {
      name: 'zsh splitting and array flags inside quotes',
      command: 'x "${=a}" "${(@)a}"',
      words: ['x', '${=a}', '${(@)a}'],
      single: [true, false, false],
    },
    {
      name: 'zsh modifiers and defaults inside quotes',
      command: 'x "${(s: :)a}" "${a:-b c}" "${a}" "$1" "${#a}"',
      words: ['x', '${(s: :)a}', '${a:-b c}', '${a}', '$1', '${#a}'],
      single: [true, false, false, true, true, true],
    },
    {
      name: 'a glob',
      command: 'x * "*" \'*\' a?',
      words: ['x', '*', '*', '*', 'a?'],
      single: [true, false, true, true, false],
    },
    {
      name: 'a brace expansion',
      command: 'x {a,b}',
      words: ['x', 'a', 'b'],
      single: [true, false, false],
    },
    {
      name: 'a single-quoted dollar',
      command: "x '$a'",
      words: ['x', '$a'],
      single: [true, true],
    },
  ];

  it.each(CASES)('$name: $command', ({ command, words, single }) => {
    const { segments } = parseShell(command);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.words).toEqual(words);
    expect(segments[0]?.singleWords).toEqual(single);
  });
});
