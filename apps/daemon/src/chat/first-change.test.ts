import { describe, expect, it } from 'vitest';
import { firstChangeOf } from './first-change';

describe('firstChangeOf', () => {
  it.each<{ name: string; call: Parameters<typeof firstChangeOf>[0]; want: 'edit' | 'git' | null }>(
    [
      { name: 'Edit', call: { toolName: 'Edit' }, want: 'edit' },
      { name: 'Write', call: { toolName: 'Write' }, want: 'edit' },
      { name: 'MultiEdit', call: { toolName: 'MultiEdit' }, want: 'edit' },
      { name: 'NotebookEdit', call: { toolName: 'NotebookEdit' }, want: 'edit' },
      // codex-guard.ts hands each apply_patch hunk to preToolUse under the name Edit.
      {
        name: "Codex's apply_patch, as the guard names it",
        call: { toolName: 'Edit' },
        want: 'edit',
      },
      {
        name: "a subagent's edit",
        call: { toolName: 'Edit', agentId: 'a1', agentType: 'general-purpose' } as Parameters<
          typeof firstChangeOf
        >[0],
        want: 'edit',
      },
      { name: 'make_branch', call: { toolName: 'mcp__10db__make_branch' }, want: 'git' },
      { name: 'switch_branch', call: { toolName: 'mcp__10db__switch_branch' }, want: 'git' },
      { name: 'pull', call: { toolName: 'mcp__10db__pull' }, want: 'git' },
      { name: 'commit_changes', call: { toolName: 'mcp__10db__commit_changes' }, want: 'git' },
      { name: 'push_branch', call: { toolName: 'mcp__10db__push_branch' }, want: null },
      { name: 'open_pull_request', call: { toolName: 'mcp__10db__open_pull_request' }, want: null },
      {
        name: 'merge_pull_request',
        call: { toolName: 'mcp__10db__merge_pull_request' },
        want: null,
      },
      {
        name: 'a chat tool that files a task',
        call: { toolName: 'mcp__10db__create_task' },
        want: null,
      },
      { name: 'Read', call: { toolName: 'Read' }, want: null },
      { name: 'Grep', call: { toolName: 'Grep' }, want: null },
      { name: 'Bash', call: { toolName: 'Bash' }, want: null },
      {
        name: 'another server tool named like a git tool',
        call: { toolName: 'mcp__other__pull' },
        want: null,
      },
    ],
  )('$name', ({ call, want }) => {
    expect(firstChangeOf(call)).toBe(want);
  });
});
