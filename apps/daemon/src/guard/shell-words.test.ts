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
