import { describe, expect, it } from 'vitest';
import { boardColumnDto, taskDto } from '../../test/fixtures';
import { boardLayout, columnKeyId, DONE_LIMIT } from './board-layout';

const at = (minute: number) => `2026-10-13T12:${String(minute).padStart(2, '0')}:00.000Z`;
const icebox = boardColumnDto({ name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ name: 'Exploring', position: 1 });

describe('boardLayout', () => {
  it('lists human columns by position, then the system columns in the spec\u2019s order', () => {
    expect(boardLayout([exploring, icebox], []).map((c) => c.label)).toEqual([
      'Icebox',
      'Exploring',
      'Backlog',
      'Ready',
      'In progress',
      'In review',
      'Blocked',
      'Done',
    ]);
  });

  it.each([
    {
      name: 'a parked task in its human column, whatever its status',
      tasks: [taskDto({ title: 'idea', boardStatus: 'ready', boardColumnId: icebox.id })],
      expected: { Icebox: ['idea'], Ready: [] },
    },
    {
      name: 'planned tasks by board status, in board order',
      tasks: [
        taskDto({ title: 'r2', boardStatus: 'ready', boardOrder: 2 }),
        taskDto({ title: 'b1', boardStatus: 'backlog', boardOrder: 1 }),
        taskDto({ title: 'r1', boardStatus: 'ready', boardOrder: 0.5 }),
      ],
      expected: { Backlog: ['b1'], Ready: ['r1', 'r2'] },
    },
    {
      name: 'a task whose column is gone in its system column',
      tasks: [
        taskDto({ title: 'orphan', boardStatus: 'backlog', boardColumnId: boardColumnDto().id }),
      ],
      expected: { Backlog: ['orphan'], Icebox: [] },
    },
    {
      name: 'a task whose pull request is open in In review, in board order',
      tasks: [
        taskDto({ title: 'r2', boardStatus: 'in_review', status: 'done', boardOrder: 2 }),
        taskDto({ title: 'r1', boardStatus: 'in_review', status: 'done', boardOrder: 1 }),
      ],
      expected: { 'In review': ['r1', 'r2'], Done: [] },
    },
    {
      name: 'done tasks most recently finished first',
      tasks: [
        taskDto({ title: 'old', boardStatus: 'done', status: 'done', updatedAt: at(1) }),
        taskDto({ title: 'new', boardStatus: 'done', status: 'done', updatedAt: at(9) }),
      ],
      expected: { Done: ['new', 'old'] },
    },
  ])('puts $name', ({ tasks, expected }) => {
    const layout = boardLayout([icebox, exploring], tasks);
    for (const [label, titles] of Object.entries(expected))
      expect(layout.find((c) => c.label === label)?.tasks.map((t) => t.title)).toEqual(titles);
  });

  it('gives each column a stable key and keeps the done limit at 20', () => {
    const [first] = boardLayout([icebox], []);
    if (!first) throw new Error('no column');
    expect(columnKeyId(first.key)).toBe(`human:${icebox.id}`);
    expect(columnKeyId({ kind: 'system', status: 'ready' })).toBe('system:ready');
    expect(DONE_LIMIT).toBe(20);
  });
});
