import { describe, expect, it } from 'vitest';
import { taskKind } from './background-task-kind';

describe('taskKind', () => {
  it.each([
    ['local_bash', 'shell'],
    ['LOCAL_SHELL', 'shell'],
    ['local_agent', 'agent'],
    ['monitor_mcp', 'monitor'],
    ['local_workflow', 'other'],
    ['mcp_task', 'other'],
    ['__proto__', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ])('reads %s as %s', (type, kind) => {
    expect(taskKind(type)).toBe(kind);
  });
});
