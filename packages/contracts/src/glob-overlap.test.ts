import { describe, expect, it } from 'vitest';
import { globsOverlap } from './glob-overlap';

describe('globsOverlap', () => {
  it.each([
    ['sibling folders', 'app/people/**', 'app/settings/**', false],
    ['a folder and one inside it', 'src/**', 'src/a/**', true],
    ['the same glob', 'src/a/**', 'src/a/**', true],
    ['a folder and its own files', 'app/*', 'app/people/**', false],
    ['a folder, and the name the folder has', 'app/people/**', 'app/people', false],
    ['a middle ** that takes no folder', 'a/**/c', 'a/c', true],
    ['a leading ** and a deep file', '**/page.tsx', 'app/people/page.tsx', true],
    ['two extensions in one folder', 'src/*.ts', 'src/*.css', false],
    ['a star and a literal prefix', 'src/b*', 'src/a*', false],
    ['stars on both sides', 'src/*x', 'src/y*', true],
    ['a question mark against one character', 'a?c/**', 'abc/**', true],
    ['a question mark against two characters', 'a?/**', 'abc/**', false],
    ['two classes that share a character', '[ab]/**', '[bc]/**', true],
    ['two classes with nothing in common', '[ab]/**', '[cd]/**', false],
    ['a range and a character inside it', '[a-m]x', 'gx', true],
    ['a negated class and the character it excludes', '[!a]x', 'ax', false],
    ['a negated class and another character', '[!a]x', 'bx', true],
    ['a literal bracket, as the proposer writes one', 'app/[[]id]/**', 'app/*]/page.tsx', true],
    ['a literal bracket against the class it spells', 'app/[[]id]/**', 'app/[id]/**', false],
    ['a literal paren class, as the proposer writes one', 'app/[(]app)/**', 'app/(app)/a', true],
    ['a brace alternative that matches', 'src/{a,b}/**', 'src/b/x', true],
    ['brace alternatives that miss', 'src/{a,b}/**', 'src/c/**', false],
    ['letters that differ only in case, on a folding file system', 'Src/**', 'src/a', true],
    ['dot names, which an area glob takes like any other', '**', '.github/x', true],
    ['an extglob, read as any one name, wider than it is', 'src/@(a|b)/**', 'src/c/x', true],
    ['an extglob against another depth', 'src/@(a|b)', 'lib/a', false],
    ['a POSIX class alone, read as any character', 'app/[[:alpha:]]x/**', 'app/ax/**', true],
    ['a POSIX class beside other members', 'app/[[:alpha:]_]*/**', 'app/people/**', true],
    ['two POSIX classes in one class', 'app/[[:alpha:][:digit:]]/**', 'app/7/**', true],
    ['a POSIX class at another depth', 'app/[[:alpha:]_]', 'app/people/x', false],
    ['an accent composed and decomposed', 'app/caf\u00e9/**', 'app/cafe\u0301/**', true],
    ['an accent decomposed in capitals', 'app/CAFE\u0301/**', 'app/caf\u00e9/x', true],
  ] as const)('%s: %s and %s → %s', (_name, a, b, overlap) => {
    expect(globsOverlap(a, b)).toBe(overlap);
    expect(globsOverlap(b, a)).toBe(overlap);
  });
});
