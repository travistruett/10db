import { mintId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { sharedAskNeeded } from './shared-ask';

// Workbench spec §7.2 step 3 (W5): a task asks the builder before it changes a shared area that
// another task of the pass changed, by a change not dropped, or holds now.

const ME = mintId('Task');
const OTHER = mintId('Task');
const AT = '2026-11-09T12:00:00.000Z';

type Hold = Parameters<typeof sharedAskNeeded>[0]['holds'][number];
type Change = Parameters<typeof sharedAskNeeded>[0]['changes'][number];

const hold = (seq: number, taskId: TaskId, open: boolean, area = 'src'): Hold => ({
  seq,
  taskId,
  area,
  closedAt: open ? null : AT,
});
const change = (seq: number, taskId: TaskId, patch: Partial<Change> = {}): Change => ({
  seq,
  taskId,
  paths: ['src/button.ts'],
  dropOf: null,
  droppedBy: null,
  updatedAt: AT,
  ...patch,
});

describe('sharedAskNeeded', () => {
  it.each<{ name: string; holds: Hold[]; changes: Change[]; asks: boolean }>([
    { name: 'nobody has touched the area', holds: [], changes: [], asks: false },
    { name: 'another task holds it now', holds: [hold(1, OTHER, true)], changes: [], asks: true },
    {
      name: 'another task changed it',
      holds: [hold(1, OTHER, false)],
      changes: [change(1, OTHER)],
      asks: true,
    },
    {
      name: "another task's change was dropped",
      holds: [hold(1, OTHER, false)],
      changes: [change(1, OTHER, { droppedBy: 2 }), change(2, OTHER, { dropOf: 1 })],
      asks: false,
    },
    {
      name: 'only this task changed it',
      holds: [hold(1, ME, false)],
      changes: [change(1, ME)],
      asks: false,
    },
    {
      name: 'another task changed another shared area',
      holds: [hold(1, OTHER, false, 'styles')],
      changes: [change(1, OTHER)],
      asks: false,
    },
    {
      name: "another task's hold changed nothing",
      holds: [hold(1, OTHER, false)],
      changes: [],
      asks: false,
    },
  ])('$name: asks $asks', ({ holds, changes, asks }) => {
    expect(sharedAskNeeded({ taskId: ME, area: 'src', holds, changes })).toBe(asks);
  });
});
