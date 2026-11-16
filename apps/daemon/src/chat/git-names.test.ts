import { InvalidError } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chatBranchName, isTenDbBranch } from './git-names';

describe('a branch name a chat may use', () => {
  it.each(['topic', 'feature/login', 'fix-1', 'v2.0', 'ten-db/x', '10dbx', 'x/10db/y'])(
    'takes %s',
    (name) => {
      expect(chatBranchName(name)).toBe(name);
    },
  );

  it.each([
    ['empty', ''],
    ['an option', '-c'],
    ['a force', '+topic'],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['a tab', 'a\tb'],
    ['too long', 'a'.repeat(201)],
    ['10db’s own', '10db/batch-abc123'],
    ['10db’s own in capitals', '10DB/Batch'],
    ['10db’s own with a decomposed letter', '10db/é'],
    ['10db itself', '10db'],
    ['a previous-branch reference', '@{-1}'],
    ['a reflog reference', 'topic@{1}'],
  ])('refuses %s', (_what, name) => {
    expect(() => chatBranchName(name)).toThrow(InvalidError);
  });

  it.each([
    ['', /1 to 200 characters/],
    ['-c', /never starts with - or \+/],
    ['a b', /no space or control character/],
    ['10db/x', /10db's own/],
    ['@{-1}', /@\{/],
  ])('says why it refuses %j', (name, message) => {
    expect(() => chatBranchName(name)).toThrow(message);
  });

  it('tells 10db’s branches by folded name', () => {
    expect(isTenDbBranch('10DB/x')).toBe(true);
    expect(isTenDbBranch('10db/x')).toBe(true);
    expect(isTenDbBranch('x/10db/x')).toBe(false);
  });
});
