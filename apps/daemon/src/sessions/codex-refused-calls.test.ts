import { describe, expect, it } from 'vitest';
import type { ClaudeDenial } from './claude-tool-calls';
import { refusedToolCalls } from './codex-refused-calls';

const AT = Date.parse('2026-11-14T10:00:00.000Z');
const judged: ClaudeDenial = {
  by: 'judge',
  reason: 'Skipped: this would write to a live system.',
  limit: 'writes_live',
  soft: false,
};

describe('refusedToolCalls', () => {
  it.each([
    [
      'a command',
      { tool_name: 'Bash', tool_input: { command: 'vercel deploy --prod' }, cwd: '/w' },
      [{ kind: 'command', command: 'vercel deploy --prod' }],
    ],
    [
      'a patch, one call per file with the item id before the index',
      {
        tool_name: 'apply_patch',
        tool_input: {
          command: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: b.ts\n*** End Patch',
        },
        cwd: '/w',
      },
      [
        { id: 'item-1:0', kind: 'edit', path: '/w/a.ts', change: 'add' },
        { id: 'item-1:1', kind: 'edit', path: '/w/b.ts', change: 'delete' },
      ],
    ],
    [
      'an MCP tool',
      { tool_name: 'mcp__10db__commit', tool_input: { message: 'x' } },
      [{ kind: 'mcp', server: '10db', tool: 'commit' }],
    ],
  ])('shows %s as denied, by whom and at which limit', (_name, hook, expected) => {
    const calls = refusedToolCalls({ ...hook, tool_use_id: 'item-1' }, judged, AT, 0);
    expect(calls).toMatchObject(
      expected.map((e) => ({
        id: 'item-1',
        ...e,
        status: 'denied',
        deniedBy: 'judge',
        limit: 'writes_live',
        soft: false,
        refusal: judged.reason,
      })),
    );
  });

  it('shows each refused call of a code-mode script as its own call, part of that script, even a repeat', () => {
    const hook = {
      tool_name: 'Bash',
      tool_input: { command: 'vercel deploy --prod' },
      tool_use_id: 'exec-7',
      cwd: '/w',
    };
    const calls = [0, 1].flatMap((seq) => refusedToolCalls(hook, judged, AT, seq));
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    for (const call of calls) {
      expect(call.id.startsWith('exec-7')).toBe(true);
      expect(call).toMatchObject({
        parentId: 'exec-7',
        status: 'denied',
        deniedBy: 'judge',
        limit: 'writes_live',
      });
      expect(call.title).toMatch(/^In a code-mode script: /);
      expect(call.refusal).toContain('inside a code-mode script');
      expect(call.refusal).toContain(judged.reason);
    }
  });

  it.each([
    ['a call with no id', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
    ['a tool 10db does not read', { tool_name: 'view_image', tool_input: {}, tool_use_id: 'i' }],
    ['a command that is no string', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'i' }],
  ])('shows nothing for %s', (_name, hook) => {
    expect(refusedToolCalls(hook, judged, AT, 0)).toEqual([]);
  });
});
