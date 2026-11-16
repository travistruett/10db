import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { closeTaskTab, openTaskTab, parseTaskTabs, type TaskTab } from './task-tabs';

const tab = (title: string, position: number): TaskTab => ({
  taskId: mintId('Task'),
  projectId: mintId('Project'),
  title,
  place: 'copy',
  position,
});

describe('task tabs', () => {
  it('opens a task once, where it first opened', () => {
    const a = tab('A', 0);
    expect(openTaskTab(openTaskTab([], a), { ...a, position: 5 })).toEqual([a]);
  });

  it('closes by task', () => {
    const [a, b] = [tab('A', 0), tab('B', 1)];
    expect(closeTaskTab([a, b], a.taskId)).toEqual([b]);
  });

  it.each([
    { name: 'nothing stored', raw: null },
    { name: 'text that is not JSON', raw: 'x{' },
    { name: 'a list of the wrong shape', raw: '[{"taskId":"nope"}]' },
  ])('reads as empty: $name', ({ raw }) => {
    expect(parseTaskTabs(raw)).toEqual([]);
  });

  it('reads what it wrote', () => {
    const a = tab('A', 2);
    expect(parseTaskTabs(JSON.stringify([a]))).toEqual([a]);
  });
});
