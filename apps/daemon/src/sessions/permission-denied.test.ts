import { describe, expect, it } from 'vitest';
import { summaryOfCall } from './permission-denied';

// The summary is what Allow this approves and what the cut rule measures, so it holds every input
// key that changes what the call does.
describe('summaryOfCall', () => {
  it.each<[string, string, Record<string, unknown>, string]>([
    ['a command', 'Bash', { command: 'ls', description: 'List' }, 'ls'],
    ['a command with its timeout', 'Bash', { command: 'ls', timeout: 5000 }, 'ls'],
    [
      'a command run in the background',
      'Bash',
      { command: 'ls', run_in_background: true },
      'Bash {"command":"ls","run_in_background":true}',
    ],
    [
      'a command that leaves the sandbox',
      'Bash',
      { command: 'ls', dangerouslyDisableSandbox: true },
      'Bash {"command":"ls","dangerouslyDisableSandbox":true}',
    ],
    ['a Monitor command', 'Monitor', { command: 'tail -f x', timeout_ms: 1000 }, 'tail -f x'],
    [
      'a Monitor with a socket',
      'Monitor',
      { command: 'tail -f x', ws: { url: 'wss://example.net/' } },
      'Monitor {"command":"tail -f x","ws":{"url":"wss://example.net/"}}',
    ],
    [
      'a Monitor with a socket and no command',
      'Monitor',
      { ws: { url: 'wss://example.net/' } },
      'Monitor {"ws":{"url":"wss://example.net/"}}',
    ],
    [
      'a fetch',
      'WebFetch',
      { url: 'https://example.net/', prompt: 'Read it' },
      'https://example.net/',
    ],
    ['a search', 'WebSearch', { query: 'zod' }, 'zod'],
    [
      'a search limited to domains',
      'WebSearch',
      { query: 'zod', allowed_domains: ['example.net'] },
      'WebSearch {"query":"zod","allowed_domains":["example.net"]}',
    ],
    [
      'a write, with its content',
      'Write',
      { file_path: 'a.ts', content: 'export {};\n' },
      'Write {"file_path":"a.ts","content":"export {};\\n"}',
    ],
    [
      'an edit, with both strings',
      'Edit',
      { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
      'Edit {"file_path":"a.ts","old_string":"a","new_string":"b"}',
    ],
    [
      'a multi-edit, with its edits',
      'MultiEdit',
      { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
      'MultiEdit {"file_path":"a.ts","edits":[{"old_string":"a","new_string":"b"}]}',
    ],
    [
      'a notebook edit, with its source',
      'NotebookEdit',
      { notebook_path: 'a.ipynb', new_source: 'print(1)' },
      'NotebookEdit {"notebook_path":"a.ipynb","new_source":"print(1)"}',
    ],
    ['another tool', 'Skill', { skill: 'x' }, 'Skill {"skill":"x"}'],
  ])('%s', (_name, toolName, input, expected) => {
    expect(summaryOfCall({ toolName, input })).toBe(expected);
  });
});
