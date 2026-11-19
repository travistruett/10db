import { describe, expect, it } from 'vitest';
import { callKey, callSummary } from './call-summary';

// T4 Task 1: a skip names its call in a few words, and its key matches the same call in another
// worktree, never a call that only shares a prefix with it.

describe('callSummary', () => {
  it('names each call by the field that says what it does, cut at 500 characters', () => {
    const rows: [string, string, Record<string, unknown>, string][] = [
      [
        'Bash names its command',
        'Bash',
        { command: 'pnpm test', description: 'tests' },
        'pnpm test',
      ],
      [
        'WebFetch its url',
        'WebFetch',
        { url: 'https://example.com', prompt: 'x' },
        'https://example.com',
      ],
      ['WebSearch its query', 'WebSearch', { query: 'zod 4' }, 'zod 4'],
      [
        'an edit its path',
        'Edit',
        { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
        '/repo/a.ts',
      ],
      [
        'a network request its host',
        'SandboxNetworkAccess',
        { host: 'api.example.com' },
        'api.example.com',
      ],
      ['an unknown tool its name and input', 'mcp__x__y', { a: 1 }, 'mcp__x__y {"a":1}'],
    ];
    for (const [name, tool, input, text] of rows) {
      expect.soft(callSummary(tool, input), name).toEqual({ text, cut: false });
    }
    // A 600-character command is cut at 500 and says so.
    expect
      .soft(callSummary('Bash', { command: 'x'.repeat(600) }), 'a 600-character command')
      .toEqual({ text: `${'x'.repeat(500)}…`, cut: true });
  });
});

describe('callKey', () => {
  const key = (tool: string, input: Record<string, unknown>, checkout = '/wt/a') =>
    callKey(tool, input, checkout);

  it('gives the same call the same key in another worktree, whatever its description or key order', () => {
    const rows: [string, string, string][] = [
      [
        'the same call in another worktree',
        key('Bash', { command: 'cat /wt/a/src/x.ts' }, '/wt/a'),
        key('Bash', { command: 'cat /wt/b/src/x.ts' }, '/wt/b'),
      ],
      [
        'the same command with another description',
        key('Bash', { command: 'ls', description: 'one' }),
        key('Bash', { command: 'ls', description: 'two', timeout: 5 }),
      ],
      [
        'the checkout before a space or a shell operator is still the checkout',
        key('Bash', { command: 'cd /wt/a && ls' }, '/wt/a'),
        key('Bash', { command: 'cd /wt/b && ls' }, '/wt/b'),
      ],
      [
        'an unknown tool keys its whole input, whatever its key order',
        key('mcp__x__y', { a: 1, b: 2 }),
        key('mcp__x__y', { b: 2, a: 1 }),
      ],
    ];
    for (const [name, one, two] of rows) expect.soft(one, name).toBe(two);
  });

  it('gives a different key to any call that differs in what it does', () => {
    const shared = 'x'.repeat(499);
    const rows: [string, string, string][] = [
      [
        'two commands sharing 499 characters',
        key('Bash', { command: `${shared}a` }),
        key('Bash', { command: `${shared}b` }),
      ],
      [
        'the same command run in the background',
        key('Bash', { command: 'ls' }),
        key('Bash', { command: 'ls', run_in_background: true }),
      ],
      [
        'the same input under another tool name',
        key('Bash', { command: 'ls' }),
        key('Monitor', { command: 'ls' }),
      ],
      [
        'the same command run outside the sandbox',
        key('Bash', { command: 'ls' }),
        key('Bash', { command: 'ls', dangerouslyDisableSandbox: true }),
      ],
      [
        'the same Write path with other content',
        key('Write', { file_path: '/wt/a/x.ts', content: 'one' }),
        key('Write', { file_path: '/wt/a/x.ts', content: 'two' }),
      ],
      [
        'the same Edit path with other content',
        key('Edit', { file_path: '/wt/a/x.ts', old_string: 'a', new_string: 'b' }),
        key('Edit', { file_path: '/wt/a/x.ts', old_string: 'a', new_string: 'c' }),
      ],
      [
        'the same MultiEdit path with other content',
        key('MultiEdit', { file_path: '/wt/a/x.ts', edits: [1] }),
        key('MultiEdit', { file_path: '/wt/a/x.ts', edits: [2] }),
      ],
      [
        'a path that only begins with the checkout keeps its own name',
        key('Bash', { command: 'cat /wt/a-other/x' }, '/wt/a'),
        key('Bash', { command: 'cat /wt/b-other/x' }, '/wt/b'),
      ],
      [
        'a literal <checkout> in the input is not the checkout',
        key('Bash', { command: 'cat <checkout>/x' }, '/wt/a'),
        key('Bash', { command: 'cat /wt/a/x' }, '/wt/a'),
      ],
      [
        'an unknown tool with another input value',
        key('mcp__x__y', { a: 1 }),
        key('mcp__x__y', { a: 2 }),
      ],
    ];
    for (const [name, one, two] of rows) expect.soft(one, name).not.toBe(two);
  });
});
