import { describe, expect, it } from 'vitest';
import { callKey, callSummary } from './call-summary';

// T4 Task 1: a skip names its call in a few words, and its key matches the same call in another
// worktree, never a call that only shares a prefix with it.

describe('callSummary', () => {
  it.each<[string, string, Record<string, unknown>, string]>([
    ['Bash names its command', 'Bash', { command: 'pnpm test', description: 'tests' }, 'pnpm test'],
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
  ])('%s', (_name, tool, input, text) => {
    expect(callSummary(tool, input)).toEqual({ text, cut: false });
  });

  it('a 600-character command is cut at 500 and says so', () => {
    const { text, cut } = callSummary('Bash', { command: 'x'.repeat(600) });
    expect(cut).toBe(true);
    expect(text).toBe(`${'x'.repeat(500)}…`);
  });
});

describe('callKey', () => {
  const key = (tool: string, input: Record<string, unknown>, checkout = '/wt/a') =>
    callKey(tool, input, checkout);

  it('two commands sharing 499 characters have different keys', () => {
    const shared = 'x'.repeat(499);
    expect(key('Bash', { command: `${shared}a` })).not.toBe(key('Bash', { command: `${shared}b` }));
  });

  it('the same call in another worktree has the same key', () => {
    expect(key('Bash', { command: 'cat /wt/a/src/x.ts' }, '/wt/a')).toBe(
      key('Bash', { command: 'cat /wt/b/src/x.ts' }, '/wt/b'),
    );
  });

  it('the same command with another description has the same key', () => {
    expect(key('Bash', { command: 'ls', description: 'one' })).toBe(
      key('Bash', { command: 'ls', description: 'two', timeout: 5 }),
    );
  });

  it('the same command run in the background has another key', () => {
    expect(key('Bash', { command: 'ls' })).not.toBe(
      key('Bash', { command: 'ls', run_in_background: true }),
    );
  });

  it('the same input under another tool name has a different key', () => {
    expect(key('Bash', { command: 'ls' })).not.toBe(key('Monitor', { command: 'ls' }));
  });

  it('an unknown tool keys its whole input, whatever its key order', () => {
    expect(key('mcp__x__y', { a: 1, b: 2 })).toBe(key('mcp__x__y', { b: 2, a: 1 }));
    expect(key('mcp__x__y', { a: 1 })).not.toBe(key('mcp__x__y', { a: 2 }));
  });
});
