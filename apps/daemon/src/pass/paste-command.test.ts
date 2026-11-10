import { describe, expect, it } from 'vitest';
import { branchMergeCommand } from './paste-command';

// A command 10db shows for the builder to paste: a branch name runs as one word, whatever it holds.

describe('branchMergeCommand', () => {
  it.each([
    {
      name: 'plain names stay as they are',
      into: 'main',
      from: '10db/polish-abc123',
      command: 'git switch main && git merge 10db/polish-abc123',
    },
    {
      name: 'a name with shell metacharacters is quoted',
      into: 'main;$(touch pwned)&`id`',
      from: "it's(x)",
      command: `git switch 'main;$(touch pwned)&\`id\`' && git merge 'it'\\''s(x)'`,
    },
  ])('$name', ({ into, from, command }) => {
    expect(branchMergeCommand(into, from)).toBe(command);
  });
});
